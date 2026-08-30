import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  GuestSessionAuthorization,
  GuestSessionRecord,
  IdempotentCommandResult,
  IntelligentIntakePresentation,
  IntakeClassificationRecord,
  IntakeSourceCategory,
  UploadConstraints,
  UploadSessionCreated,
  UploadSessionRecord,
} from "ipw-contracts-ts/product";

import { IdentityBoundary } from "../identity/identity.service.js";
import { DomainError, requireByteSize, requireId, requireText } from "../../kernel/errors.js";
import {
  PRODUCT_REPOSITORY,
  RUNTIME_VALUES,
  type CommandContext,
  type ProductKernelRepository,
} from "../../kernel/product.types.js";
import { requestDigest, type RuntimeValues } from "../../kernel/runtime.js";
import { INTAKE_REPOSITORY, type IntakeOwner, type IntakeRepository } from "./intake.types.js";
import type { StoredUploadSession } from "./intake.types.js";
import {
  PRIVATE_OBJECT_STORE,
  UploadChecksumMismatch,
  UploadLimitExceeded,
  UploadOffsetConflict,
  UploadSizeMismatch,
  type UploadAuthorizationInput,
  type PrivateObjectStore,
} from "./private-object-store.js";
import {
  GUEST_HANDOFF_REPOSITORY,
  type GuestHandoffRepository,
} from "./guest-handoff.repository.js";

type Headers = Record<string, string | string[] | undefined>;

const CONSTRAINTS: UploadConstraints = {
  schema_version: PRODUCT_SCHEMA_VERSION,
  allowed_media_types: [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/tiff",
    "image/bmp",
    "image/heif",
    "image/heic",
    "application/pdf",
  ],
  max_bytes: 100 * 1024 * 1024,
  max_pixels: 100_000_000,
  max_pages: 500,
};

const SOURCE_CATEGORIES = new Set<IntakeSourceCategory>([
  "photograph",
  "graphic",
  "document",
  "scan",
  "animation",
  "other",
  "unsure",
]);

@Injectable()
export class IntakeService implements OnApplicationShutdown {
  constructor(
    @Inject(INTAKE_REPOSITORY) private readonly repository: IntakeRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
    @Inject(GUEST_HANDOFF_REPOSITORY) private readonly handoffs: GuestHandoffRepository,
    private readonly identity: IdentityBoundary,
  ) {}

  async createGuestSession(): Promise<GuestSessionAuthorization> {
    const now = this.runtime.now();
    const token = this.token();
    const guestSession: GuestSessionRecord = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      guest_session_id: this.runtime.id("guest"),
      expires_at: this.after(now, 24 * 60 * 60),
    };
    await this.repository.createGuest(guestSession, this.hash(token), now);
    return { schema_version: PRODUCT_SCHEMA_VERSION, guest_session: guestSession, token };
  }

  async createForWorkspace(
    headers: Headers,
    workspaceId: string,
    body: Record<string, unknown>,
  ): Promise<UploadSessionCreated> {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    const context = await this.product.workspaceContext(principal.actorId, id);
    if (!context || !context.effectivePermissions.some((item) => item.permission === "upload.create" && item.allowed)) {
      throw new DomainError(403, "access-denied", "You do not have permission to upload to this workspace");
    }
    return this.create(headers, { ownerKind: "actor", ownerScope: id, workspaceId: id, actorId: principal.actorId }, body);
  }

  async createForGuest(headers: Headers, body: Record<string, unknown>): Promise<UploadSessionCreated> {
    const guest = await this.requireGuest(headers);
    return this.create(headers, {
      ownerKind: "guest",
      ownerScope: guest.guest_session_id,
      guestSessionId: guest.guest_session_id,
    }, body);
  }

  async get(headers: Headers, uploadSessionId: string): Promise<{ schema_version: string; upload_session: UploadSessionRecord }> {
    const stored = await this.requireAccessible(headers, requireId(uploadSessionId, "upload session id"));
    return { schema_version: PRODUCT_SCHEMA_VERSION, upload_session: stored.record };
  }

  async presentation(
    headers: Headers,
    uploadSessionId: string,
  ): Promise<{ schema_version: string; presentation: IntelligentIntakePresentation }> {
    const stored = await this.requireAccessible(headers, requireId(uploadSessionId, "upload session id"));
    this.requireReadyFacts(stored.record);
    const owner = this.owner(stored.record);
    const saved = await this.repository.findClassification(stored.record.upload_session_id, owner);
    const classification = saved ?? this.inferClassification(stored.record);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      presentation: this.intakePresentation(stored.record, classification),
    };
  }

  async correctClassification(
    headers: Headers,
    uploadSessionId: string,
    body: Record<string, unknown>,
  ) {
    const stored = await this.requireAccessible(headers, requireId(uploadSessionId, "upload session id"));
    this.requireReadyFacts(stored.record);
    const requested = requireText(body["category"], "source category", 50) as IntakeSourceCategory;
    if (!SOURCE_CATEGORIES.has(requested)) {
      throw new DomainError(400, "classification-invalid", "Choose an available source category");
    }
    const owner = this.owner(stored.record);
    const inferred = await this.repository.findClassification(stored.record.upload_session_id, owner)
      ?? this.inferClassification(stored.record);
    const now = this.runtime.now();
    const classification: IntakeClassificationRecord = {
      ...inferred,
      customer_category: requested,
      updated_at: now,
    };
    const context = this.commandContext(headers, owner, "intake.classification.correct", {
      uploadSessionId: stored.record.upload_session_id,
      category: requested,
    });
    const saved = await this.repository.saveClassification(classification, owner, {
      ownerScope: owner.ownerScope,
      idempotencyKey: context.idempotencyKey,
      commandName: "intake.classification.correct",
      requestHash: context.requestHash,
    }, now);
    if (owner.ownerKind === "actor") {
      await this.product.recordExternalMutation(
        context,
        owner.workspaceId!,
        "intake.classification-corrected",
        "upload_session",
        stored.record.upload_session_id,
      );
    }
    const command: IdempotentCommandResult = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      idempotency_key: context.idempotencyKey,
      replayed: saved.replayed,
      resource_kind: "intake_classification",
      resource_id: stored.record.upload_session_id,
    };
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      classification: saved.classification,
      presentation: this.intakePresentation(stored.record, saved.classification),
      command,
    };
  }

  async resume(
    headers: Headers,
    uploadSessionId: string,
  ): Promise<{ schema_version: string; authorization: UploadSessionCreated["authorization"]; upload_session: UploadSessionRecord }> {
    const id = requireId(uploadSessionId, "upload session id");
    const stored = await this.requireAccessible(headers, id);
    if (!["initiated", "uploading"].includes(stored.record.state)) {
      throw new DomainError(409, "upload-not-resumable", "This upload can no longer be resumed");
    }
    const resumeToken = this.token();
    const expiresAt = this.after(this.runtime.now(), 15 * 60);
    const owner = this.owner(stored.record);
    const rotated = await this.repository.rotateUploadToken(
      id,
      owner,
      this.hash(resumeToken),
      expiresAt,
      this.runtime.now(),
    );
    const authorization = await this.objects.resumeUpload(
      rotated.quarantineRef,
      rotated.protectedProviderSession,
      this.authorizationInput(rotated.record, resumeToken, expiresAt),
    );
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      upload_session: rotated.record,
      authorization: this.publicAuthorization(authorization, resumeToken),
    };
  }

  async reconcileForFinalise(headers: Headers, uploadSessionId: string): Promise<StoredUploadSession> {
    const stored = await this.requireAccessible(headers, requireId(uploadSessionId, "upload session id"));
    if (stored.record.job_id) return stored;
    const owner = this.owner(stored.record);
    try {
      const metadata = await this.objects.reconcile(
        stored.quarantineRef,
        this.authorizationInput(stored.record, "reconciliation-only", this.runtime.now()),
      );
      return this.repository.recordProviderObject(stored.record.upload_session_id, owner, metadata, this.runtime.now());
    } catch (error) {
      if (error instanceof UploadSizeMismatch) {
        throw new DomainError(409, "upload-incomplete", `The provider has ${error.providerBytes} of ${stored.record.expected_byte_size} bytes`);
      }
      if (error instanceof UploadChecksumMismatch) {
        throw new DomainError(422, "upload-checksum-mismatch", "The uploaded file does not match its expected checksum");
      }
      throw error;
    }
  }

  async uploadBytes(
    uploadSessionId: string,
    token: string,
    contentType: string | undefined,
    offset: number,
    bytes: Uint8Array,
  ): Promise<{ schema_version: string; upload_session: UploadSessionRecord; upload_offset: number }> {
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
      throw new DomainError(415, "upload-content-type-invalid", "Upload bytes as application/octet-stream");
    }
    const id = requireId(uploadSessionId, "upload session id");
    const tokenHash = this.hash(requireText(token, "upload token", 512));
    const current = await this.repository.findUploadByToken(id, tokenHash, this.runtime.now());
    if (!current) throw new DomainError(401, "upload-authorization-invalid", "Upload authorization is invalid or expired");
    if (current.transferProvider !== "local_api") {
      throw new DomainError(409, "upload-provider-conflict", "Use the authorised storage provider for this upload");
    }
    if (offset !== current.record.bytes_received) {
      throw new DomainError(409, "upload-offset-conflict", `Resume this upload at byte ${current.record.bytes_received}`);
    }
    try {
      const next = await this.objects.append(
        current.quarantineRef,
        bytes,
        offset,
        Math.min(current.record.expected_byte_size, current.record.constraints.max_bytes),
      );
      const stored = await this.repository.recordUploadedBytes(id, tokenHash, next, this.runtime.now());
      return { schema_version: PRODUCT_SCHEMA_VERSION, upload_session: stored.record, upload_offset: next };
    } catch (error) {
      if (error instanceof UploadOffsetConflict) {
        throw new DomainError(409, "upload-offset-conflict", `Resume this upload at byte ${error.currentOffset}`);
      }
      if (error instanceof UploadLimitExceeded) {
        throw new DomainError(413, "upload-too-large", "The selected file exceeds the allowed upload size");
      }
      throw error;
    }
  }

  async cancel(headers: Headers, uploadSessionId: string): Promise<{ schema_version: string; upload_session: UploadSessionRecord }> {
    const id = requireId(uploadSessionId, "upload session id");
    const stored = await this.requireAccessible(headers, id, "upload.cancel");
    if (["ready", "rejected", "expired", "cancelled"].includes(stored.record.state)) {
      return { schema_version: PRODUCT_SCHEMA_VERSION, upload_session: stored.record };
    }
    const owner = this.owner(stored.record);
    const cancelled = await this.repository.cancelUpload(id, owner, this.runtime.now());
    await this.objects.remove(cancelled.quarantineRef);
    if (owner.ownerKind === "actor") {
      const command = this.commandContext(headers, owner, "upload.cancel", { uploadSessionId: id });
      await this.product.recordExternalMutation(command, owner.workspaceId!, "upload.cancellation-requested", "upload_session", id);
      await this.product.recordExternalMutation(command, owner.workspaceId!, "upload.cancelled", "upload_session", id);
      await this.product.recordExternalMutation(command, owner.workspaceId!, "source.cleanup", "upload_session", id);
    }
    return { schema_version: PRODUCT_SCHEMA_VERSION, upload_session: cancelled.record };
  }

  async cleanupExpired(limit = 100): Promise<{ cleaned: number; failed: number }> {
    const now = this.runtime.now();
    const workerId = this.runtime.id("cleanup");
    const candidates = await this.repository.claimCleanup(workerId, now, this.after(now, 90), limit);
    let cleaned = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await this.objects.remove(candidate.object);
        if (candidate.owner.ownerKind === "actor") {
          const traceId = `trace-cleanup-${candidate.uploadSessionId}`;
          await this.product.recordExternalMutation(
            {
              principal: {
                actorId: candidate.owner.actorId!,
                displayName: "intake-cleanup",
              },
              idempotencyKey: `cleanup-${candidate.uploadSessionId}`,
              traceId,
              requestHash: requestDigest({
                command: "source.cleanup",
                uploadSessionId: candidate.uploadSessionId,
              }),
            },
            candidate.owner.workspaceId!,
            "source.cleanup",
            "upload_session",
            candidate.uploadSessionId,
          );
        }
        await this.repository.completeCleanup(candidate.uploadSessionId, workerId, this.runtime.now());
        cleaned += 1;
      } catch {
        failed += 1;
        await this.repository.releaseCleanup(candidate.uploadSessionId, workerId);
      }
    }
    return { cleaned, failed };
  }

  async handoffGuest(headers: Headers, uploadSessionId: string, body: Record<string, unknown>) {
    const guest = await this.requireGuest(headers);
    const principal = this.identity.resolve(headers);
    const workspaceId = requireId(body["workspace_id"], "workspace id");
    const context = await this.product.workspaceContext(principal.actorId, workspaceId);
    if (!context || !context.effectivePermissions.some((item) => item.permission === "file.create" && item.allowed)) {
      throw new DomainError(403, "access-denied", "You do not have permission to save this source");
    }
    const id = requireId(uploadSessionId, "upload session id");
    const owner: IntakeOwner = {
      ownerKind: "guest",
      ownerScope: guest.guest_session_id,
      guestSessionId: guest.guest_session_id,
    };
    const stored = await this.repository.findUpload(id, owner);
    if (!stored || stored.record.state !== "ready" || !stored.record.source_facts
      || !stored.record.asset_original_id || !stored.record.source_version_id) {
      throw new DomainError(409, "upload-not-ready", "Guest upload is not ready to save");
    }
    const command = this.commandContext(headers, {
      ownerKind: "actor",
      ownerScope: workspaceId,
      workspaceId,
      actorId: principal.actorId,
    }, "guest-source.handoff", { uploadSessionId: id, workspaceId });
    const target = await this.objects.rehome(
      stored.quarantineRef,
      workspaceId,
      stored.record.source_facts.sha256,
    );
    const fileId = this.runtime.id("file");
    const result = await this.handoffs.handoff({
      uploadSessionId: id,
      guestSessionId: guest.guest_session_id,
      workspaceId,
      actorId: principal.actorId,
      objectReferenceId: this.runtime.id("object"),
      assetOriginalId: stored.record.asset_original_id,
      sourceVersionId: stored.record.source_version_id,
      fileId,
      displayName: stored.record.display_name,
      immutableObjectKey: target.objectKey,
      sha256: stored.record.source_facts.sha256,
      mediaType: stored.record.source_facts.detected_media_type,
      byteSize: stored.record.source_facts.byte_size,
      command,
      now: this.runtime.now(),
    });
    const file = (await this.product.listFiles(principal.actorId, workspaceId))
      .find((candidate) => candidate.file_id === result.fileId);
    if (!file) throw new Error("handed-off file is unavailable");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      file,
      asset_original_id: stored.record.asset_original_id,
      source_version_id: stored.record.source_version_id,
      command: {
        schema_version: PRODUCT_SCHEMA_VERSION,
        idempotency_key: command.idempotencyKey,
        replayed: result.replayed,
        resource_kind: "file",
        resource_id: result.fileId,
      },
    };
  }

  requireForInternal(headers: Headers, uploadSessionId: string): Promise<StoredUploadSession> {
    return this.requireAccessible(headers, requireId(uploadSessionId, "upload session id"));
  }

  ownerFor(record: UploadSessionRecord): IntakeOwner {
    return this.owner(record);
  }

  hasGuestToken(headers: Headers): boolean {
    return Boolean(this.header(headers, "x-ipw-guest-token"));
  }

  async guestOwner(headers: Headers): Promise<IntakeOwner> {
    const guest = await this.requireGuest(headers);
    return { ownerKind: "guest", ownerScope: guest.guest_session_id, guestSessionId: guest.guest_session_id };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.repository.close();
    await this.handoffs.close();
  }

  private async create(headers: Headers, owner: IntakeOwner, body: Record<string, unknown>): Promise<UploadSessionCreated> {
    const displayName = this.fileName(body["display_name"]);
    const expectedMediaType = requireText(body["media_type"], "media type", 200).toLowerCase();
    const expectedByteSize = requireByteSize(body["byte_size"]);
    const expectedSha256 = this.optionalSha256(body["expected_sha256"]);
    if (expectedByteSize < 1 || expectedByteSize > CONSTRAINTS.max_bytes) {
      throw new DomainError(413, "upload-too-large", "Choose a file smaller than 100 MB");
    }
    if (!CONSTRAINTS.allowed_media_types.includes(expectedMediaType)) {
      throw new DomainError(415, "media-type-not-supported", "Choose a supported image or PDF file");
    }
    const now = this.runtime.now();
    const uploadSessionId = this.runtime.id("upload");
    const uploadToken = this.token();
    const uploadTokenExpiresAt = this.after(now, 15 * 60);
    const record: UploadSessionRecord = {
      schema_version: PRODUCT_SCHEMA_VERSION,
      upload_session_id: uploadSessionId,
      owner_kind: owner.ownerKind,
      workspace_id: owner.workspaceId ?? null,
      actor_id: owner.actorId ?? null,
      guest_session_id: owner.guestSessionId ?? null,
      display_name: displayName,
      expected_media_type: expectedMediaType,
      expected_byte_size: expectedByteSize,
      expected_sha256: expectedSha256,
      verified_sha256: null,
      bytes_received: 0,
      state: "initiated",
      constraints: CONSTRAINTS,
      job_id: null,
      asset_original_id: null,
      source_version_id: null,
      file_id: null,
      source_facts: null,
      failure: null,
      created_at: now,
      expires_at: this.after(now, 24 * 60 * 60),
      updated_at: now,
    };
    const quarantineRef = await this.objects.createQuarantine(owner.ownerScope, uploadSessionId);
    const command = this.commandContext(headers, owner, "upload.create", {
      ownerScope: owner.ownerScope,
      displayName,
      expectedMediaType,
      expectedByteSize,
      expectedSha256,
    });
    try {
      const created = await this.repository.createUpload(
        {
          record,
          quarantineRef,
          uploadTokenHash: this.hash(uploadToken),
          uploadTokenExpiresAt,
          transferProvider: this.objects.provider,
          protectedProviderSession: null,
          providerMetadata: null,
        },
        {
          ownerScope: owner.ownerScope,
          idempotencyKey: command.idempotencyKey,
          commandName: "upload.create",
          requestHash: command.requestHash,
        },
        now,
      );
      let active = created.stored;
      if (created.replayed) {
        await this.objects.remove(quarantineRef);
        active = await this.repository.rotateUploadToken(
          active.record.upload_session_id,
          owner,
          this.hash(uploadToken),
          uploadTokenExpiresAt,
          now,
        );
      } else if (owner.ownerKind === "actor") {
        await this.product.recordExternalMutation(command, owner.workspaceId!, "upload.created", "upload_session", uploadSessionId);
      }
      const authorization = created.replayed
        ? await this.objects.resumeUpload(
          active.quarantineRef,
          active.protectedProviderSession,
          this.authorizationInput(active.record, uploadToken, uploadTokenExpiresAt),
        )
        : await this.objects.authorizeUpload(
          active.quarantineRef,
          this.authorizationInput(active.record, uploadToken, uploadTokenExpiresAt),
        );
      if (!created.replayed) {
        active = await this.repository.setUploadProviderState(
          active.record.upload_session_id,
          owner,
          authorization.provider,
          authorization.protectedProviderSession ?? null,
          now,
        );
      }
      const commandResult: IdempotentCommandResult = {
        schema_version: PRODUCT_SCHEMA_VERSION,
        idempotency_key: command.idempotencyKey,
        replayed: created.replayed,
        resource_kind: "upload_session",
        resource_id: active.record.upload_session_id,
      };
      return {
        schema_version: PRODUCT_SCHEMA_VERSION,
        upload_session: active.record,
        authorization: this.publicAuthorization(authorization, uploadToken),
        command: commandResult,
      };
    } catch (error) {
      await this.objects.remove(quarantineRef);
      throw error;
    }
  }

  private async requireAccessible(headers: Headers, uploadSessionId: string, permission = "upload.read") {
    const guestToken = this.header(headers, "x-ipw-guest-token");
    if (guestToken) {
      const guest = await this.repository.findGuest(this.hash(guestToken), this.runtime.now());
      if (!guest) throw new DomainError(401, "guest-session-invalid", "Guest session is invalid or expired");
      const stored = await this.repository.findUpload(uploadSessionId, {
        ownerKind: "guest",
        ownerScope: guest.guest_session_id,
        guestSessionId: guest.guest_session_id,
      });
      if (!stored) throw new DomainError(404, "upload-not-found", "Upload session was not found");
      return stored;
    }
    const principal = this.identity.resolve(headers);
    const stored = await this.repository.findUploadByActor(uploadSessionId, principal.actorId);
    if (!stored?.record.workspace_id) throw new DomainError(404, "upload-not-found", "Upload session was not found");
    const context = await this.product.workspaceContext(principal.actorId, stored.record.workspace_id);
    if (!context?.effectivePermissions.some((item) => item.permission === permission && item.allowed)) {
      throw new DomainError(404, "upload-not-found", "Upload session was not found");
    }
    return stored;
  }

  private async requireGuest(headers: Headers): Promise<GuestSessionRecord> {
    const token = this.header(headers, "x-ipw-guest-token");
    if (!token) throw new DomainError(401, "guest-session-required", "Start a guest session to continue");
    const guest = await this.repository.findGuest(this.hash(token), this.runtime.now());
    if (!guest) throw new DomainError(401, "guest-session-invalid", "Guest session is invalid or expired");
    return guest;
  }

  private commandContext(headers: Headers, owner: IntakeOwner, command: string, payload: unknown): CommandContext {
    const idempotencyKey = requireId(this.header(headers, "idempotency-key"), "Idempotency-Key");
    const traceId = requireId(this.header(headers, "x-trace-id"), "trace id");
    return {
      principal: { actorId: owner.actorId ?? owner.guestSessionId!, displayName: owner.ownerKind },
      idempotencyKey,
      traceId,
      requestHash: requestDigest({ command, payload }),
    };
  }

  private owner(record: UploadSessionRecord): IntakeOwner {
    return record.owner_kind === "actor"
      ? { ownerKind: "actor", ownerScope: record.workspace_id!, workspaceId: record.workspace_id!, actorId: record.actor_id! }
      : { ownerKind: "guest", ownerScope: record.guest_session_id!, guestSessionId: record.guest_session_id! };
  }

  private fileName(value: unknown): string {
    const name = requireText(value, "display name", 2048);
    if (/[\\/\x00-\x1f]/.test(name) || name === "." || name === "..") {
      throw new DomainError(400, "filename-invalid", "Choose a file with a valid name");
    }
    return name;
  }

  private optionalSha256(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    const digest = requireText(value, "expected SHA-256", 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new DomainError(400, "checksum-invalid", "Expected SHA-256 must contain 64 hexadecimal characters");
    }
    return digest;
  }

  private requireReadyFacts(record: UploadSessionRecord): asserts record is UploadSessionRecord & {
    source_facts: NonNullable<UploadSessionRecord["source_facts"]>;
  } {
    if (record.state !== "ready" || !record.source_facts || record.source_facts.malware_scan_state !== "clean") {
      throw new DomainError(409, "intake-not-ready", "Verified source facts are not available for this upload");
    }
  }

  private inferClassification(record: UploadSessionRecord & {
    source_facts: NonNullable<UploadSessionRecord["source_facts"]>;
  }): IntakeClassificationRecord {
    const facts = record.source_facts;
    let inferredCategory: IntakeSourceCategory | null = null;
    let confidencePercent: number | null = null;
    let evidence: string[] = [];
    if (facts.detected_media_type === "application/pdf") {
      inferredCategory = "document";
      confidencePercent = 100;
      evidence = ["The validated container is a PDF document."];
    } else if ((facts.frame_count ?? 1) > 1) {
      inferredCategory = "animation";
      confidencePercent = 95;
      evidence = ["The verified image contains multiple frames."];
    } else if (facts.has_alpha === true) {
      inferredCategory = "graphic";
      confidencePercent = 78;
      evidence = ["The verified image includes an alpha channel commonly used by composed graphics."];
    }
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      upload_session_id: record.upload_session_id,
      inferred_category: inferredCategory,
      confidence_percent: confidencePercent,
      evidence,
      customer_category: null,
      updated_at: record.updated_at,
    };
  }

  private intakePresentation(
    record: UploadSessionRecord & { source_facts: NonNullable<UploadSessionRecord["source_facts"]> },
    classification: IntakeClassificationRecord,
  ): IntelligentIntakePresentation {
    const facts = record.source_facts;
    const category = classification.customer_category ?? classification.inferred_category;
    const isPdf = facts.detected_media_type === "application/pdf";
    const recommendedOutcome = isPdf
      ? "edit-manage-pdf" as const
      : category === "document" || category === "scan"
        ? "create-pdf" as const
        : "image-graphic-studio" as const;
    const recommendationRationale = isPdf
      ? "The source is a verified PDF, so document organization and management is the relevant next outcome."
      : recommendedOutcome === "create-pdf"
        ? "Your source category indicates a page-like image that can be organized into a PDF."
        : "The verified source is an image, so visual preparation is the relevant next outcome.";
    const sensitiveMetadata = facts.sensitive_metadata ?? [];
    const sensitive = sensitiveMetadata.length > 0;
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      upload_session_id: record.upload_session_id,
      filename: record.display_name,
      source_facts: facts,
      classification,
      risk_dimensions: [
        {
          schema_version: PRODUCT_SCHEMA_VERSION,
          dimension: "safety",
          state: "clear",
          summary: "Malware scanning completed cleanly before this source was accepted.",
        },
        {
          schema_version: PRODUCT_SCHEMA_VERSION,
          dimension: "structure",
          state: "clear",
          summary: "The supported container passed integrity and approved resource-limit checks.",
        },
        {
          schema_version: PRODUCT_SCHEMA_VERSION,
          dimension: "privacy",
          state: sensitive ? "attention" : "clear",
          summary: sensitive
            ? `Sensitive metadata is present: ${sensitiveMetadata.join(", ")}.`
            : "No sensitive metadata was detected by the approved inspection path.",
        },
      ],
      suitable_explanation: "This original passed the currently approved safety and structure checks. It has not been changed.",
      recommended_outcome: recommendedOutcome,
      recommendation_rationale: recommendationRationale,
    };
  }

  private authorizationInput(
    record: UploadSessionRecord,
    resumeToken: string,
    expiresAt: string,
  ): UploadAuthorizationInput {
    return {
      uploadSessionId: record.upload_session_id,
      resumeToken,
      expiresAt,
      expectedByteSize: record.expected_byte_size,
      expectedMediaType: record.expected_media_type,
      expectedSha256: record.expected_sha256 ?? null,
    };
  }

  private publicAuthorization(
    authorization: Awaited<ReturnType<PrivateObjectStore["authorizeUpload"]>>,
    resumeToken: string,
  ): UploadSessionCreated["authorization"] {
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      transfer_kind: "resumable",
      provider: authorization.provider,
      protocol: authorization.protocol,
      method: authorization.method,
      upload_url: authorization.uploadUrl,
      expires_at: authorization.expiresAt,
      resume_token: resumeToken,
      required_headers: authorization.requiredHeaders,
    };
  }

  private header(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return (Array.isArray(value) ? value[0] : value)?.trim();
  }

  private token(): string {
    return randomBytes(32).toString("base64url");
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private after(now: string, seconds: number): string {
    return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
  }
}
