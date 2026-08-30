import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type {
  GuestSessionAuthorization,
  GuestSessionRecord,
  IdempotentCommandResult,
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
  UploadLimitExceeded,
  UploadOffsetConflict,
  type PrivateObjectStore,
} from "./private-object-store.js";

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

@Injectable()
export class IntakeService implements OnApplicationShutdown {
  constructor(
    @Inject(INTAKE_REPOSITORY) private readonly repository: IntakeRepository,
    @Inject(PRIVATE_OBJECT_STORE) private readonly objects: PrivateObjectStore,
    @Inject(PRODUCT_REPOSITORY) private readonly product: ProductKernelRepository,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
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
    const stored = await this.requireAccessible(headers, id);
    const owner = this.owner(stored.record);
    const cancelled = await this.repository.cancelUpload(id, owner, this.runtime.now());
    await this.objects.remove(cancelled.quarantineRef);
    if (owner.ownerKind === "actor") {
      const command = this.commandContext(headers, owner, "upload.cancel", { uploadSessionId: id });
      await this.product.recordExternalMutation(command, owner.workspaceId!, "upload.cancelled", "upload_session", id);
    }
    return { schema_version: PRODUCT_SCHEMA_VERSION, upload_session: cancelled.record };
  }

  async cleanupExpired(): Promise<number> {
    const refs = await this.repository.expireUploads(this.runtime.now());
    await Promise.all(refs.map((ref) => this.objects.remove(ref)));
    return refs.length;
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
  }

  private async create(headers: Headers, owner: IntakeOwner, body: Record<string, unknown>): Promise<UploadSessionCreated> {
    await this.cleanupExpired();
    const displayName = this.fileName(body["display_name"]);
    const expectedMediaType = requireText(body["media_type"], "media type", 200).toLowerCase();
    const expectedByteSize = requireByteSize(body["byte_size"]);
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
    });
    try {
      const created = await this.repository.createUpload(
        {
          record,
          quarantineRef,
          uploadTokenHash: this.hash(uploadToken),
          uploadTokenExpiresAt,
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
      const authorization = await this.objects.authorizeUpload(
        active.quarantineRef,
        active.record.upload_session_id,
        uploadToken,
        uploadTokenExpiresAt,
      );
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
        authorization: {
          schema_version: PRODUCT_SCHEMA_VERSION,
          transfer_kind: "resumable",
          method: authorization.method,
          upload_url: authorization.uploadUrl,
          expires_at: authorization.expiresAt,
          required_headers: authorization.requiredHeaders,
        },
        command: commandResult,
      };
    } catch (error) {
      await this.objects.remove(quarantineRef);
      throw error;
    }
  }

  private async requireAccessible(headers: Headers, uploadSessionId: string) {
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
    if (!context?.effectivePermissions.some((item) => item.permission === "upload.read" && item.allowed)) {
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
