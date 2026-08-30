import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export type ObjectZone = "quarantine" | "immutable";

export interface PrivateObjectRef {
  ownerScope: string;
  objectKey: string;
  zone: ObjectZone;
  generation?: string;
}

export interface UploadAuthorizationResult {
  method: "PUT";
  provider: "local_api" | "google_cloud_storage";
  protocol: "ipw_offset_json" | "gcs_resumable";
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
  protectedProviderSession?: string;
}

export interface UploadAuthorizationInput {
  uploadSessionId: string;
  resumeToken: string;
  expiresAt: string;
  expectedByteSize: number;
  expectedMediaType: string;
  expectedSha256: string | null;
}

export interface ProviderObjectMetadata {
  byteSize: number;
  generation: string;
  mediaType: string;
  uploadSessionId: string;
  expectedSha256: string | null;
  calculatedSha256: string | null;
}

export interface PrivateObjectStore {
  readonly provider: "local_api" | "google_cloud_storage";
  createQuarantine(ownerScope: string, uploadSessionId: string): Promise<PrivateObjectRef>;
  authorizeUpload(ref: PrivateObjectRef, input: UploadAuthorizationInput): Promise<UploadAuthorizationResult>;
  resumeUpload(
    ref: PrivateObjectRef,
    protectedProviderSession: string | null,
    input: UploadAuthorizationInput,
  ): Promise<UploadAuthorizationResult>;
  reconcile(ref: PrivateObjectRef, input: UploadAuthorizationInput): Promise<ProviderObjectMetadata>;
  append(ref: PrivateObjectRef, bytes: Uint8Array, expectedOffset: number, maxBytes: number): Promise<number>;
  read(ref: PrivateObjectRef, maxBytes: number): Promise<Uint8Array>;
  promote(ref: PrivateObjectRef, sha256: string): Promise<PrivateObjectRef>;
  rehome(ref: PrivateObjectRef, targetOwnerScope: string, sha256: string): Promise<PrivateObjectRef>;
  remove(ref: PrivateObjectRef): Promise<void>;
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function immutableKey(ownerScope: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("invalid sha256");
  return `immutable/${safeSegment(ownerScope, "owner scope")}/${sha256}`;
}

export class MemoryPrivateObjectStore implements PrivateObjectStore {
  readonly provider = "local_api" as const;
  private readonly objects = new Map<string, Uint8Array>();

  async createQuarantine(ownerScope: string, uploadSessionId: string): Promise<PrivateObjectRef> {
    const ref = {
      ownerScope: safeSegment(ownerScope, "owner scope"),
      objectKey: `quarantine/${safeSegment(ownerScope, "owner scope")}/${safeSegment(uploadSessionId, "upload id")}`,
      zone: "quarantine" as const,
    };
    if (this.objects.has(ref.objectKey)) throw new Error("quarantine object already exists");
    this.objects.set(ref.objectKey, new Uint8Array());
    return ref;
  }

  async authorizeUpload(
    _ref: PrivateObjectRef,
    input: UploadAuthorizationInput,
  ): Promise<UploadAuthorizationResult> {
    return {
      method: "PUT",
      provider: this.provider,
      protocol: "ipw_offset_json",
      uploadUrl: `/v1/uploads/${input.uploadSessionId}/content?token=${encodeURIComponent(input.resumeToken)}`,
      expiresAt: input.expiresAt,
      requiredHeaders: { "content-type": "application/octet-stream", "upload-offset": "0" },
    };
  }

  resumeUpload(
    ref: PrivateObjectRef,
    _protectedProviderSession: string | null,
    input: UploadAuthorizationInput,
  ): Promise<UploadAuthorizationResult> {
    return this.authorizeUpload(ref, input);
  }

  async reconcile(ref: PrivateObjectRef, input: UploadAuthorizationInput): Promise<ProviderObjectMetadata> {
    const bytes = await this.read(ref, input.expectedByteSize);
    if (bytes.byteLength !== input.expectedByteSize) throw new UploadSizeMismatch(bytes.byteLength);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new UploadChecksumMismatch();
    return {
      byteSize: bytes.byteLength,
      generation: sha256,
      mediaType: input.expectedMediaType,
      uploadSessionId: input.uploadSessionId,
      expectedSha256: input.expectedSha256,
      calculatedSha256: sha256,
    };
  }

  async append(ref: PrivateObjectRef, bytes: Uint8Array, expectedOffset: number, maxBytes: number): Promise<number> {
    if (ref.zone !== "quarantine") throw new Error("only quarantine objects are writable");
    const current = this.objects.get(ref.objectKey);
    if (!current) throw new Error("private object not found");
    if (current.byteLength !== expectedOffset) throw new UploadOffsetConflict(current.byteLength);
    if (current.byteLength + bytes.byteLength > maxBytes) throw new UploadLimitExceeded();
    const combined = new Uint8Array(current.byteLength + bytes.byteLength);
    combined.set(current);
    combined.set(bytes, current.byteLength);
    this.objects.set(ref.objectKey, combined);
    return combined.byteLength;
  }

  async read(ref: PrivateObjectRef, maxBytes: number): Promise<Uint8Array> {
    const value = this.objects.get(ref.objectKey);
    if (!value) throw new Error("private object not found");
    if (value.byteLength > maxBytes) throw new UploadLimitExceeded();
    return value.slice();
  }

  async promote(ref: PrivateObjectRef, sha256: string): Promise<PrivateObjectRef> {
    if (ref.zone !== "quarantine") throw new Error("only quarantine objects can be promoted");
    const bytes = await this.read(ref, Number.MAX_SAFE_INTEGER);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) throw new Error("promotion digest mismatch");
    const objectKey = immutableKey(ref.ownerScope, sha256);
    const existing = this.objects.get(objectKey);
    if (existing && createHash("sha256").update(existing).digest("hex") !== sha256) {
      throw new Error("immutable object collision");
    }
    if (!existing) this.objects.set(objectKey, bytes);
    return { ownerScope: ref.ownerScope, objectKey, zone: "immutable" };
  }

  async remove(ref: PrivateObjectRef): Promise<void> {
    this.objects.delete(ref.objectKey);
  }

  async rehome(ref: PrivateObjectRef, targetOwnerScope: string, sha256: string): Promise<PrivateObjectRef> {
    if (ref.zone !== "immutable") throw new Error("only immutable objects can be rehomed");
    const bytes = await this.read(ref, Number.MAX_SAFE_INTEGER);
    const objectKey = immutableKey(targetOwnerScope, sha256);
    const existing = this.objects.get(objectKey);
    if (existing && createHash("sha256").update(existing).digest("hex") !== sha256) {
      throw new Error("immutable object collision");
    }
    if (!existing) this.objects.set(objectKey, bytes);
    return { ownerScope: targetOwnerScope, objectKey, zone: "immutable" };
  }
}

export class LocalFilesystemPrivateObjectStore implements PrivateObjectStore {
  readonly provider = "local_api" as const;
  constructor(private readonly root: string) {}

  async createQuarantine(ownerScope: string, uploadSessionId: string): Promise<PrivateObjectRef> {
    const ref: PrivateObjectRef = {
      ownerScope: safeSegment(ownerScope, "owner scope"),
      objectKey: `quarantine/${safeSegment(ownerScope, "owner scope")}/${safeSegment(uploadSessionId, "upload id")}`,
      zone: "quarantine",
    };
    const path = this.path(ref);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, new Uint8Array(), { flag: "wx", mode: 0o600 });
    return ref;
  }

  async authorizeUpload(
    _ref: PrivateObjectRef,
    input: UploadAuthorizationInput,
  ): Promise<UploadAuthorizationResult> {
    return {
      method: "PUT",
      provider: this.provider,
      protocol: "ipw_offset_json",
      uploadUrl: `/v1/uploads/${input.uploadSessionId}/content?token=${encodeURIComponent(input.resumeToken)}`,
      expiresAt: input.expiresAt,
      requiredHeaders: { "content-type": "application/octet-stream", "upload-offset": "0" },
    };
  }

  resumeUpload(
    ref: PrivateObjectRef,
    _protectedProviderSession: string | null,
    input: UploadAuthorizationInput,
  ): Promise<UploadAuthorizationResult> {
    return this.authorizeUpload(ref, input);
  }

  async reconcile(ref: PrivateObjectRef, input: UploadAuthorizationInput): Promise<ProviderObjectMetadata> {
    const bytes = await this.read(ref, input.expectedByteSize);
    if (bytes.byteLength !== input.expectedByteSize) throw new UploadSizeMismatch(bytes.byteLength);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new UploadChecksumMismatch();
    return {
      byteSize: bytes.byteLength,
      generation: sha256,
      mediaType: input.expectedMediaType,
      uploadSessionId: input.uploadSessionId,
      expectedSha256: input.expectedSha256,
      calculatedSha256: sha256,
    };
  }

  async append(ref: PrivateObjectRef, bytes: Uint8Array, expectedOffset: number, maxBytes: number): Promise<number> {
    if (ref.zone !== "quarantine") throw new Error("only quarantine objects are writable");
    const path = this.path(ref);
    const current = (await stat(path)).size;
    if (current !== expectedOffset) throw new UploadOffsetConflict(current);
    if (current + bytes.byteLength > maxBytes) throw new UploadLimitExceeded();
    await appendFile(path, bytes, { mode: 0o600 });
    return current + bytes.byteLength;
  }

  async read(ref: PrivateObjectRef, maxBytes: number): Promise<Uint8Array> {
    const path = this.path(ref);
    const metadata = await stat(path);
    if (metadata.size > maxBytes) throw new UploadLimitExceeded();
    return readFile(path);
  }

  async promote(ref: PrivateObjectRef, sha256: string): Promise<PrivateObjectRef> {
    const bytes = await this.read(ref, Number.MAX_SAFE_INTEGER);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("promotion digest mismatch");
    const target: PrivateObjectRef = {
      ownerScope: ref.ownerScope,
      objectKey: immutableKey(ref.ownerScope, sha256),
      zone: "immutable",
    };
    const targetPath = this.path(target);
    await mkdir(resolve(targetPath, ".."), { recursive: true, mode: 0o700 });
    try {
      await copyFile(this.path(ref), targetPath, constants.COPYFILE_EXCL);
    } catch (error) {
      const existing = await readFile(targetPath).catch(() => null);
      if (!existing || createHash("sha256").update(existing).digest("hex") !== sha256) throw error;
    }
    return target;
  }

  async remove(ref: PrivateObjectRef): Promise<void> {
    await rm(this.path(ref), { force: true });
  }

  async rehome(ref: PrivateObjectRef, targetOwnerScope: string, sha256: string): Promise<PrivateObjectRef> {
    const bytes = await this.read(ref, Number.MAX_SAFE_INTEGER);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("rehoming digest mismatch");
    const target: PrivateObjectRef = {
      ownerScope: safeSegment(targetOwnerScope, "owner scope"),
      objectKey: immutableKey(targetOwnerScope, sha256),
      zone: "immutable",
    };
    const targetPath = this.path(target);
    await mkdir(resolve(targetPath, ".."), { recursive: true, mode: 0o700 });
    try {
      await copyFile(this.path(ref), targetPath, constants.COPYFILE_EXCL);
    } catch (error) {
      const existing = await readFile(targetPath).catch(() => null);
      if (!existing || createHash("sha256").update(existing).digest("hex") !== sha256) throw error;
    }
    return target;
  }

  private path(ref: PrivateObjectRef): string {
    if (!/^(quarantine|immutable)\/[a-z0-9._-]{3,64}\/[a-z0-9._-]{3,128}$/.test(ref.objectKey)) {
      throw new Error("invalid private object key");
    }
    const root = resolve(this.root);
    const target = resolve(root, ...ref.objectKey.split("/"));
    if (!target.startsWith(`${root}${sep}`)) throw new Error("private object path escaped storage root");
    return target;
  }
}

export interface GcsPrivateClient {
  initiateResumableUpload(input: {
    objectKey: string;
    uploadSessionId: string;
    expectedByteSize: number;
    expectedMediaType: string;
    expectedSha256: string | null;
  }): Promise<string>;
  metadata(objectKey: string): Promise<ProviderObjectMetadata>;
  read(objectKey: string, maxBytes: number): Promise<Uint8Array>;
  copyIfAbsent(sourceKey: string, sourceGeneration: string, targetKey: string, sha256: string): Promise<string>;
  remove(objectKey: string, generation?: string): Promise<void>;
}

export class ResumableSessionProtector {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("IPW_UPLOAD_SESSION_SECRET must contain at least 32 characters");
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  protect(uri: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(uri, "utf8"), cipher.final()]);
    return `v1.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
  }

  reveal(protectedValue: string): string {
    if (!protectedValue.startsWith("v1.")) throw new Error("protected resumable session has an unsupported format");
    try {
      const value = Buffer.from(protectedValue.slice(3), "base64url");
      if (value.byteLength < 29) throw new Error("invalid protected value");
      const decipher = createDecipheriv("aes-256-gcm", this.key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("protected resumable session could not be decrypted");
    }
  }
}

export class GcsPrivateObjectStore implements PrivateObjectStore {
  readonly provider = "google_cloud_storage" as const;

  constructor(
    private readonly client: GcsPrivateClient,
    private readonly protector: ResumableSessionProtector,
  ) {}

  async createQuarantine(ownerScope: string, uploadSessionId: string): Promise<PrivateObjectRef> {
    const ref: PrivateObjectRef = {
      ownerScope: safeSegment(ownerScope, "owner scope"),
      objectKey: `quarantine/${safeSegment(ownerScope, "owner scope")}/${safeSegment(uploadSessionId, "upload id")}`,
      zone: "quarantine",
    };
    return ref;
  }

  async authorizeUpload(
    ref: PrivateObjectRef,
    input: UploadAuthorizationInput,
  ): Promise<UploadAuthorizationResult> {
    const uri = await this.client.initiateResumableUpload({ objectKey: ref.objectKey, ...input });
    return {
      method: "PUT",
      provider: this.provider,
      protocol: "gcs_resumable",
      uploadUrl: uri,
      expiresAt: input.expiresAt,
      requiredHeaders: { "content-type": input.expectedMediaType },
      protectedProviderSession: this.protector.protect(uri),
    };
  }

  async resumeUpload(
    _ref: PrivateObjectRef,
    protectedProviderSession: string | null,
    input: UploadAuthorizationInput,
  ): Promise<UploadAuthorizationResult> {
    if (!protectedProviderSession) throw new Error("resumable provider session is unavailable");
    return {
      method: "PUT",
      provider: this.provider,
      protocol: "gcs_resumable",
      uploadUrl: this.protector.reveal(protectedProviderSession),
      expiresAt: input.expiresAt,
      requiredHeaders: { "content-type": input.expectedMediaType },
    };
  }

  append(_ref: PrivateObjectRef, _bytes: Uint8Array, _expectedOffset: number, _maxBytes: number): Promise<number> {
    throw new Error("GCS resumable transfers must be sent directly to the provider");
  }

  async reconcile(ref: PrivateObjectRef, input: UploadAuthorizationInput): Promise<ProviderObjectMetadata> {
    const metadata = await this.client.metadata(ref.objectKey);
    if (metadata.byteSize !== input.expectedByteSize) throw new UploadSizeMismatch(metadata.byteSize);
    if (metadata.uploadSessionId !== input.uploadSessionId) throw new Error("provider upload-session metadata mismatch");
    if (metadata.mediaType !== input.expectedMediaType) throw new Error("provider media-type metadata mismatch");
    if (metadata.expectedSha256 !== input.expectedSha256) throw new Error("provider checksum metadata mismatch");
    return metadata;
  }

  read(ref: PrivateObjectRef, maxBytes: number): Promise<Uint8Array> {
    return this.client.read(ref.objectKey, maxBytes);
  }

  async promote(ref: PrivateObjectRef, sha256: string): Promise<PrivateObjectRef> {
    if (!ref.generation) throw new Error("source generation is required for conditional promotion");
    const target = { ownerScope: ref.ownerScope, objectKey: immutableKey(ref.ownerScope, sha256), zone: "immutable" as const };
    const generation = await this.client.copyIfAbsent(ref.objectKey, ref.generation, target.objectKey, sha256);
    return { ...target, generation };
  }

  remove(ref: PrivateObjectRef): Promise<void> {
    return this.client.remove(ref.objectKey, ref.generation);
  }

  async rehome(ref: PrivateObjectRef, targetOwnerScope: string, sha256: string): Promise<PrivateObjectRef> {
    const target = {
      ownerScope: safeSegment(targetOwnerScope, "owner scope"),
      objectKey: immutableKey(targetOwnerScope, sha256),
      zone: "immutable" as const,
    };
    if (!ref.generation) throw new Error("source generation is required for conditional rehome");
    const generation = await this.client.copyIfAbsent(ref.objectKey, ref.generation, target.objectKey, sha256);
    return { ...target, generation };
  }
}

export class UploadOffsetConflict extends Error {
  constructor(readonly currentOffset: number) {
    super("upload offset does not match stored bytes");
  }
}

export class UploadLimitExceeded extends Error {}

export class UploadSizeMismatch extends Error {
  constructor(readonly providerBytes: number) {
    super("provider object size does not match the expected upload size");
  }
}

export class UploadChecksumMismatch extends Error {
  constructor() {
    super("calculated upload checksum does not match the expected checksum");
  }
}

export const PRIVATE_OBJECT_STORE = Symbol("PRIVATE_OBJECT_STORE");
