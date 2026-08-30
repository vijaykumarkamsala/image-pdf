import { Storage, type FileMetadata } from "@google-cloud/storage";

import type { GcsPrivateClient, ProviderObjectMetadata } from "./private-object-store.js";

interface GoogleApiError extends Error {
  code?: number;
}

function custom(metadata: FileMetadata): Record<string, string> {
  const value = metadata.metadata;
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function normalise(metadata: FileMetadata): ProviderObjectMetadata {
  const privateMetadata = custom(metadata);
  const byteSize = Number(metadata.size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new Error("GCS returned an invalid object size");
  const generation = String(metadata.generation ?? "");
  if (!/^\d+$/.test(generation)) throw new Error("GCS returned an invalid object generation");
  return {
    byteSize,
    generation,
    mediaType: String(metadata.contentType ?? "application/octet-stream"),
    uploadSessionId: privateMetadata["ipw-upload-session"] ?? "",
    expectedSha256: privateMetadata["ipw-expected-sha256"] || null,
    calculatedSha256: privateMetadata["ipw-calculated-sha256"] || null,
  };
}

export interface GcsSdkPrivateClientConfig {
  bucket: string;
  projectId?: string;
}

/** Official-SDK implementation. The default Storage constructor uses ADC. */
export class GcsSdkPrivateClient implements GcsPrivateClient {
  private readonly storage: Storage;

  constructor(
    private readonly config: GcsSdkPrivateClientConfig,
    storage?: Storage,
  ) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)) {
      throw new Error("IPW_GCS_BUCKET is invalid");
    }
    this.storage = storage ?? new Storage(config.projectId ? { projectId: config.projectId } : undefined);
  }

  async initiateResumableUpload(input: {
    objectKey: string;
    uploadSessionId: string;
    expectedByteSize: number;
    expectedMediaType: string;
    expectedSha256: string | null;
  }): Promise<string> {
    const [uri] = await this.file(input.objectKey).createResumableUpload({
      private: true,
      metadata: {
        contentType: input.expectedMediaType,
        metadata: {
          "ipw-upload-session": input.uploadSessionId,
          "ipw-expected-bytes": String(input.expectedByteSize),
          "ipw-expected-sha256": input.expectedSha256 ?? "",
          "ipw-zone": "quarantine",
        },
      },
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith("googleapis.com")) {
      throw new Error("GCS returned an invalid resumable upload URI");
    }
    return uri;
  }

  async metadata(objectKey: string): Promise<ProviderObjectMetadata> {
    const [metadata] = await this.file(objectKey).getMetadata();
    return normalise(metadata);
  }

  async read(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    const metadata = await this.metadata(objectKey);
    if (metadata.byteSize > maxBytes) throw new Error("private object exceeds the read limit");
    const [bytes] = await this.file(objectKey, metadata.generation).download();
    if (bytes.byteLength !== metadata.byteSize) throw new Error("GCS object changed during the bounded read");
    return bytes;
  }

  async copyIfAbsent(
    sourceKey: string,
    sourceGeneration: string,
    targetKey: string,
    sha256: string,
  ): Promise<string> {
    const source = this.file(sourceKey, sourceGeneration);
    const target = this.file(targetKey);
    try {
      await source.copy(target, {
        metadata: { "ipw-sha256": sha256, "ipw-zone": "immutable" },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (error) {
      if ((error as GoogleApiError).code !== 412) throw error;
      const [existing] = await target.getMetadata();
      if (custom(existing)["ipw-sha256"] !== sha256) {
        throw new Error("immutable GCS object already exists with conflicting identity");
      }
    }
    const [metadata] = await target.getMetadata();
    const generation = String(metadata.generation ?? "");
    if (!/^\d+$/.test(generation)) throw new Error("GCS promotion returned an invalid generation");
    return generation;
  }

  async remove(objectKey: string, generation?: string): Promise<void> {
    await this.file(objectKey, generation).delete({ ignoreNotFound: true });
  }

  private file(objectKey: string, generation?: string) {
    return this.storage.bucket(this.config.bucket).file(objectKey, generation ? { generation } : undefined);
  }
}
