import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { PRODUCT_SCHEMA_VERSION } from "ipw-contracts-ts/product";
import type { Permission } from "ipw-contracts-ts/product";

import { IdentityBoundary } from "../domains/identity/identity.service.js";
import {
  DomainError,
  requireByteSize,
  requireId,
  requireSha256,
  requireText,
} from "./errors.js";
import { hasPermission } from "./permissions.js";
import {
  PRODUCT_REPOSITORY,
  type AddReferenceInput,
  type CommandContext,
  type MoveFileInput,
  type ProductKernelRepository,
  type RegisterFileInput,
  type RegisterSourceInput,
} from "./product.types.js";
import { requestDigest } from "./runtime.js";

type HeaderValue = string | string[] | undefined;
type Headers = Record<string, HeaderValue>;

@Injectable()
export class ProductKernelService implements OnApplicationShutdown {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly repository: ProductKernelRepository,
    private readonly identity: IdentityBoundary,
  ) {}

  async bootstrap(headers: Headers) {
    const context = this.commandContext(headers, "session.bootstrap", {});
    const result = await this.repository.bootstrap(context);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      actor: result.actor,
      workspace: result.workspace,
      membership: result.membership,
      policy: result.policy,
      default_files: result.defaultFiles,
      effective_permissions: hasPermission(
        (await this.requireContext(context.principal.actorId, result.workspace.workspace_id)).effectivePermissions,
        "workspace.read",
      )
        ? (await this.requireContext(context.principal.actorId, result.workspace.workspace_id)).effectivePermissions
        : [],
      command: this.commandResult(context.idempotencyKey, result.replayed, "workspace", result.workspace.workspace_id),
    };
  }

  async listWorkspaces(headers: Headers) {
    const principal = this.identity.resolve(headers);
    return { schema_version: PRODUCT_SCHEMA_VERSION, workspaces: await this.repository.listWorkspaces(principal.actorId) };
  }

  async context(headers: Headers, workspaceId: string) {
    const principal = this.identity.resolve(headers);
    const context = await this.requireContext(principal.actorId, requireId(workspaceId, "workspace id"));
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      actor: context.actor,
      workspace: context.workspace,
      membership: context.membership,
      policy: context.policy,
      default_files: context.defaultFiles,
      effective_permissions: context.effectivePermissions,
    };
  }

  async listProjects(headers: Headers, workspaceId: string) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "project.read");
    const result = await this.repository.listProjects(principal.actorId, id);
    return { schema_version: PRODUCT_SCHEMA_VERSION, projects: result.projects, collections: result.collections };
  }

  async createProject(headers: Headers, workspaceId: string, body: Record<string, unknown>) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "project.create");
    const input = {
      name: requireText(body["name"], "name"),
      parentProjectId: body["parent_project_id"] ? requireId(body["parent_project_id"], "parent project id") : undefined,
    };
    const context = this.commandContext(headers, "project.create", { workspaceId: id, ...input });
    const result = await this.repository.createProject(context, id, input);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      project: result.value,
      command: this.commandResult(context.idempotencyKey, result.replayed, "project", result.value.project_id),
    };
  }

  async listFiles(headers: Headers, workspaceId: string) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "file.read");
    return { schema_version: PRODUCT_SCHEMA_VERSION, files: await this.repository.listFiles(principal.actorId, id) };
  }

  async registerFile(headers: Headers, workspaceId: string, body: Record<string, unknown>) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "file.create");
    const input: RegisterFileInput = {
      displayName: requireText(body["display_name"], "display name"),
      objectKey: requireText(body["object_key"], "object key", 2048),
      sha256: requireSha256(body["sha256"]),
      mediaType: requireText(body["media_type"], "media type", 200),
      byteSize: requireByteSize(body["byte_size"]),
      projectId: body["project_id"] ? requireId(body["project_id"], "project id") : undefined,
    };
    const context = this.commandContext(headers, "file.register", { workspaceId: id, ...input });
    const result = await this.repository.registerFile(context, id, input);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      file: result.file,
      original: result.original,
      source_version: result.sourceVersion,
      object_reference: result.objectReference,
      command: this.commandResult(context.idempotencyKey, result.replayed, "file", result.file.file_id),
    };
  }

  async registerSource(headers: Headers, workspaceId: string, fileId: string, body: Record<string, unknown>) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "file.create");
    const input: RegisterSourceInput = {
      objectKey: requireText(body["object_key"], "object key", 2048),
      sha256: requireSha256(body["sha256"]),
      mediaType: requireText(body["media_type"], "media type", 200),
      byteSize: requireByteSize(body["byte_size"]),
    };
    const target = requireId(fileId, "file id");
    const context = this.commandContext(headers, "file.source.register", { workspaceId: id, fileId: target, ...input });
    const result = await this.repository.registerSourceVersion(context, id, target, input);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      file: result.file,
      source_version: result.sourceVersion,
      object_reference: result.objectReference,
      command: this.commandResult(context.idempotencyKey, result.replayed, "source_version", result.sourceVersion.source_version_id),
    };
  }

  async moveFile(headers: Headers, workspaceId: string, fileId: string, body: Record<string, unknown>) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "file.move");
    if (body["kind"] !== "default_files" && body["kind"] !== "project") {
      throw new DomainError(400, "invalid-input", "kind must be default_files or project");
    }
    const input: MoveFileInput = {
      kind: body["kind"],
      projectId: body["project_id"] ? requireId(body["project_id"], "project id") : undefined,
    };
    if (input.kind === "project" && !input.projectId) {
      throw new DomainError(400, "invalid-input", "project_id is required for a project location");
    }
    const target = requireId(fileId, "file id");
    const context = this.commandContext(headers, "file.move", { workspaceId: id, fileId: target, ...input });
    const result = await this.repository.moveFile(context, id, target, input);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      file: result.value,
      command: this.commandResult(context.idempotencyKey, result.replayed, "file", target),
    };
  }

  async addReference(headers: Headers, workspaceId: string, fileId: string, body: Record<string, unknown>) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "file.create");
    if (body["owner_kind"] !== "project" && body["owner_kind"] !== "document") {
      throw new DomainError(400, "invalid-input", "owner_kind must be project or document");
    }
    const input: AddReferenceInput = {
      ownerKind: body["owner_kind"],
      ownerId: requireId(body["owner_id"], "owner id"),
      purpose: requireText(body["purpose"], "purpose"),
    };
    const target = requireId(fileId, "file id");
    const context = this.commandContext(headers, "file.reference.add", { workspaceId: id, fileId: target, ...input });
    const result = await this.repository.addFileReference(context, id, target, input);
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      reference: result.value,
      command: this.commandResult(context.idempotencyKey, result.replayed, "file_reference", result.value.reference_id),
    };
  }

  async listReferences(headers: Headers, workspaceId: string, fileId: string) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "file.read");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      references: await this.repository.listFileReferences(principal.actorId, id, requireId(fileId, "file id")),
    };
  }

  async audit(headers: Headers, workspaceId: string) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "audit.read");
    return { schema_version: PRODUCT_SCHEMA_VERSION, events: await this.repository.listAuditEvents(principal.actorId, id) };
  }

  async usage(headers: Headers, workspaceId: string) {
    const principal = this.identity.resolve(headers);
    const id = requireId(workspaceId, "workspace id");
    await this.authorize(principal.actorId, id, "usage.read");
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      events: await this.repository.listUsageEvents(principal.actorId, id),
      customer_total: "0.00",
      credit_debit_total: 0,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.repository.close();
  }

  private commandContext(headers: Headers, command: string, payload: unknown): CommandContext {
    const principal = this.identity.resolve(headers);
    const rawKey = headers["idempotency-key"];
    const rawTrace = headers["x-trace-id"];
    const idempotencyKey = requireId(Array.isArray(rawKey) ? rawKey[0] : rawKey, "Idempotency-Key");
    const traceId = requireId(Array.isArray(rawTrace) ? rawTrace[0] : rawTrace, "trace id");
    return { principal, idempotencyKey, traceId, requestHash: requestDigest({ command, payload }) };
  }

  private async requireContext(actorId: string, workspaceId: string) {
    const context = await this.repository.workspaceContext(actorId, workspaceId);
    if (!context) throw new DomainError(403, "access-denied", "You do not have access to this workspace");
    return context;
  }

  private async authorize(actorId: string, workspaceId: string, permission: Permission): Promise<void> {
    const context = await this.requireContext(actorId, workspaceId);
    if (!hasPermission(context.effectivePermissions, permission)) {
      throw new DomainError(403, "access-denied", "You do not have permission to perform this action");
    }
  }

  private commandResult(key: string, replayed: boolean, resourceKind: string, resourceId: string) {
    return {
      schema_version: PRODUCT_SCHEMA_VERSION,
      idempotency_key: key,
      replayed,
      resource_kind: resourceKind,
      resource_id: resourceId,
    };
  }
}
