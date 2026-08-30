import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export type ObjectZone = "quarantine" | "immutable";

export interface PrivateObjectRef {
  ownerScope: string;
  objectKey: string;
  zone: ObjectZone;
}

export interface UploadAuthorizationResult {
  method: "PUT";
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export interface PrivateObjectStore {
  createQuarantine(ownerScope: string, uploadSessionId: string): Promise<PrivateObjectRef>;
  authorizeUpload(
    ref: PrivateObjectRef,
    uploadSessionId: string,
    token: string,
    expiresAt: string,
  ): Promise<UploadAuthorizationResult>;
  append(ref: PrivateObjectRef, bytes: Uint8Array, expectedOffset: number, maxBytes: number): Promise<number>;
  read(ref: PrivateObjectRef, maxBytes: number): Promise<Uint8Array>;
  promote(ref: PrivateObjectRef, sha256: string): Promise<PrivateObjectRef>;
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
    uploadSessionId: string,
    token: string,
    expiresAt: string,
  ): Promise<UploadAuthorizationResult> {
    return {
      method: "PUT",
      uploadUrl: `/v1/uploads/${uploadSessionId}/content?token=${encodeURIComponent(token)}`,
      expiresAt,
      requiredHeaders: { "content-type": "application/octet-stream", "upload-offset": "0" },
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
    this.objects.delete(ref.objectKey);
    return { ownerScope: ref.ownerScope, objectKey, zone: "immutable" };
  }

  async remove(ref: PrivateObjectRef): Promise<void> {
    this.objects.delete(ref.objectKey);
  }
}

export class LocalFilesystemPrivateObjectStore implements PrivateObjectStore {
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
    uploadSessionId: string,
    token: string,
    expiresAt: string,
  ): Promise<UploadAuthorizationResult> {
    return {
      method: "PUT",
      uploadUrl: `/v1/uploads/${uploadSessionId}/content?token=${encodeURIComponent(token)}`,
      expiresAt,
      requiredHeaders: { "content-type": "application/octet-stream", "upload-offset": "0" },
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
    await rm(this.path(ref), { force: true });
    return target;
  }

  async remove(ref: PrivateObjectRef): Promise<void> {
    await rm(this.path(ref), { force: true });
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
  createPrivateObject(objectKey: string): Promise<void>;
  signedWriteUrl(objectKey: string, expiresAt: string): Promise<string>;
  append(objectKey: string, bytes: Uint8Array, expectedOffset: number, maxBytes: number): Promise<number>;
  read(objectKey: string, maxBytes: number): Promise<Uint8Array>;
  copyIfAbsent(sourceKey: string, targetKey: string): Promise<void>;
  remove(objectKey: string): Promise<void>;
}

export class GcsPrivateObjectStore implements PrivateObjectStore {
  constructor(private readonly client: GcsPrivateClient) {}

  async createQuarantine(ownerScope: string, uploadSessionId: string): Promise<PrivateObjectRef> {
    const ref: PrivateObjectRef = {
      ownerScope: safeSegment(ownerScope, "owner scope"),
      objectKey: `quarantine/${safeSegment(ownerScope, "owner scope")}/${safeSegment(uploadSessionId, "upload id")}`,
      zone: "quarantine",
    };
    await this.client.createPrivateObject(ref.objectKey);
    return ref;
  }

  async authorizeUpload(
    ref: PrivateObjectRef,
    _uploadSessionId: string,
    _token: string,
    expiresAt: string,
  ): Promise<UploadAuthorizationResult> {
    return {
      method: "PUT",
      uploadUrl: await this.client.signedWriteUrl(ref.objectKey, expiresAt),
      expiresAt,
      requiredHeaders: { "content-type": "application/octet-stream" },
    };
  }

  append(ref: PrivateObjectRef, bytes: Uint8Array, expectedOffset: number, maxBytes: number): Promise<number> {
    return this.client.append(ref.objectKey, bytes, expectedOffset, maxBytes);
  }

  read(ref: PrivateObjectRef, maxBytes: number): Promise<Uint8Array> {
    return this.client.read(ref.objectKey, maxBytes);
  }

  async promote(ref: PrivateObjectRef, sha256: string): Promise<PrivateObjectRef> {
    const target = { ownerScope: ref.ownerScope, objectKey: immutableKey(ref.ownerScope, sha256), zone: "immutable" as const };
    await this.client.copyIfAbsent(ref.objectKey, target.objectKey);
    await this.client.remove(ref.objectKey);
    return target;
  }

  remove(ref: PrivateObjectRef): Promise<void> {
    return this.client.remove(ref.objectKey);
  }
}

export class UploadOffsetConflict extends Error {
  constructor(readonly currentOffset: number) {
    super("upload offset does not match stored bytes");
  }
}

export class UploadLimitExceeded extends Error {}

export const PRIVATE_OBJECT_STORE = Symbol("PRIVATE_OBJECT_STORE");
