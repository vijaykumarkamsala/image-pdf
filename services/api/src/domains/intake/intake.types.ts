import type { GuestSessionRecord, UploadSessionRecord } from "ipw-contracts-ts/product";

import type { PrivateObjectRef, ProviderObjectMetadata } from "./private-object-store.js";

export interface IntakeOwner {
  ownerKind: "actor" | "guest";
  ownerScope: string;
  workspaceId?: string;
  actorId?: string;
  guestSessionId?: string;
}

export interface IntakeCommand {
  ownerScope: string;
  idempotencyKey: string;
  commandName: string;
  requestHash: string;
}

export interface StoredUploadSession {
  record: UploadSessionRecord;
  quarantineRef: PrivateObjectRef;
  uploadTokenHash: string;
  uploadTokenExpiresAt: string;
  transferProvider: "local_api" | "google_cloud_storage";
  protectedProviderSession: string | null;
  providerMetadata: ProviderObjectMetadata | null;
}

export interface UploadCreateResult {
  stored: StoredUploadSession;
  replayed: boolean;
}

export interface IntakeRepository {
  createGuest(record: GuestSessionRecord, tokenHash: string, createdAt: string): Promise<void>;
  findGuest(tokenHash: string, now: string): Promise<GuestSessionRecord | null>;
  createUpload(
    stored: StoredUploadSession,
    command: IntakeCommand,
    createdAt: string,
  ): Promise<UploadCreateResult>;
  rotateUploadToken(
    uploadSessionId: string,
    owner: IntakeOwner,
    tokenHash: string,
    expiresAt: string,
    updatedAt: string,
  ): Promise<StoredUploadSession>;
  setUploadProviderState(
    uploadSessionId: string,
    owner: IntakeOwner,
    transferProvider: StoredUploadSession["transferProvider"],
    protectedProviderSession: string | null,
    updatedAt: string,
  ): Promise<StoredUploadSession>;
  findUpload(uploadSessionId: string, owner: IntakeOwner): Promise<StoredUploadSession | null>;
  findUploadByActor(uploadSessionId: string, actorId: string): Promise<StoredUploadSession | null>;
  findUploadByToken(uploadSessionId: string, tokenHash: string, now: string): Promise<StoredUploadSession | null>;
  recordUploadedBytes(
    uploadSessionId: string,
    tokenHash: string,
    bytesReceived: number,
    now: string,
  ): Promise<StoredUploadSession>;
  recordProviderObject(
    uploadSessionId: string,
    owner: IntakeOwner,
    metadata: ProviderObjectMetadata,
    now: string,
  ): Promise<StoredUploadSession>;
  cancelUpload(uploadSessionId: string, owner: IntakeOwner, now: string): Promise<StoredUploadSession>;
  expireUploads(now: string): Promise<PrivateObjectRef[]>;
  close(): Promise<void>;
}

export const INTAKE_REPOSITORY = Symbol("INTAKE_REPOSITORY");
