import type { ObjectReference } from "ipw-contracts-ts/product";

import type { RuntimeValues } from "./runtime.js";

export interface ObjectReferenceInput {
  objectKey: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
}

export interface ObjectReferenceCatalog {
  create(workspaceId: string, input: ObjectReferenceInput): ObjectReference;
}

/** Metadata-only local adapter. Recovery 2A never reads or writes object bytes. */
export class MetadataObjectReferenceCatalog implements ObjectReferenceCatalog {
  constructor(private readonly runtime: RuntimeValues) {}

  create(workspaceId: string, input: ObjectReferenceInput): ObjectReference {
    return {
      schema_version: "1.7.0",
      object_reference_id: this.runtime.id("object"),
      workspace_id: workspaceId,
      object_key: input.objectKey,
      sha256: input.sha256,
      media_type: input.mediaType,
      byte_size: input.byteSize,
    };
  }
}
