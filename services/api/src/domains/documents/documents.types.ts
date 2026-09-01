import type {
  DocumentReadModel,
  DocumentVersionRecord,
  EditorDocumentRecord,
  EditorDocumentSnapshot,
  EditorLeaseGrant,
  EditorLeaseRecord,
  EditorMutation,
  ImportCompatibilityReport,
  LeaseTakeoverResult,
} from "ipw-contracts-ts/product";

import type { CommandContext } from "../../kernel/product.types.js";

export interface VerifiedRasterSource {
  fileId: string;
  displayName: string;
  assetOriginalId: string;
  sourceVersionId: string;
  objectReferenceId: string | null;
  mediaType: string;
  width: number | null;
  height: number | null;
}

export interface CreateDocumentInput {
  workspaceId: string;
  projectId?: string;
  defaultFilesId: string;
  name: string;
  intendedUse: "source" | "digital" | "print" | "custom";
  intendedUseLabel: string;
  width?: number;
  height?: number;
  source?: VerifiedRasterSource;
}

export interface DocumentMutationInput {
  workspaceId: string;
  documentId: string;
  baseRevision: number;
  mutation: EditorMutation;
  operationId?: string;
  leaseTokenHash: string;
}

export interface DocumentCommandResult<T> {
  value: T;
  replayed: boolean;
}

export interface DocumentMutationResult {
  document: EditorDocumentRecord;
  snapshot: EditorDocumentSnapshot;
  operationId: string;
  checkpoint: DocumentVersionRecord | null;
  replayed: boolean;
}

export interface DocumentHistoryResult {
  document: EditorDocumentRecord;
  snapshot: EditorDocumentSnapshot;
  canUndo: boolean;
  canRedo: boolean;
}

export interface EditorLeaseStatus {
  lease: EditorLeaseRecord;
  takeoverRequest: {
    actorId: string;
    actorDisplayName: string;
    reason: string;
    requestedAt: string;
  } | null;
}

export interface DocumentRepository {
  readonly recordsMutationsAtomically: boolean;
  create(context: CommandContext, input: CreateDocumentInput): Promise<DocumentCommandResult<DocumentReadModel>>;
  list(actorId: string, workspaceId: string): Promise<EditorDocumentRecord[]>;
  get(actorId: string, workspaceId: string, documentId: string): Promise<DocumentReadModel | null>;
  mutate(context: CommandContext, input: DocumentMutationInput): Promise<DocumentMutationResult>;
  undo(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    leaseTokenHash: string,
  ): Promise<DocumentCommandResult<DocumentHistoryResult>>;
  redo(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    leaseTokenHash: string,
  ): Promise<DocumentCommandResult<DocumentHistoryResult>>;
  createVersion(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    name: string,
  ): Promise<DocumentCommandResult<DocumentVersionRecord>>;
  restoreVersion(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    versionId: string,
    leaseTokenHash: string,
  ): Promise<DocumentCommandResult<DocumentReadModel>>;
  saveAs(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    name: string,
    projectId: string | undefined,
    defaultFilesId: string,
    recoveredSnapshot?: EditorDocumentSnapshot,
  ): Promise<DocumentCommandResult<DocumentReadModel>>;
  acquireLease(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
  ): Promise<EditorLeaseGrant>;
  heartbeatLease(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    leaseTokenHash: string,
  ): Promise<EditorLeaseRecord>;
  releaseLease(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    leaseTokenHash: string,
  ): Promise<EditorLeaseRecord>;
  requestTakeover(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    reason: string,
  ): Promise<LeaseTakeoverResult>;
  denyTakeover(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    leaseTokenHash: string,
    reason: string,
  ): Promise<EditorLeaseRecord>;
  forceTakeover(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    reason: string,
  ): Promise<LeaseTakeoverResult>;
  leaseStatus(
    actorId: string,
    workspaceId: string,
    documentId: string,
    leaseTokenHash: string,
  ): Promise<EditorLeaseStatus>;
  compatibilityReports(
    actorId: string,
    workspaceId: string,
    documentId: string,
  ): Promise<ImportCompatibilityReport[]>;
  close(): Promise<void>;
}

export const DOCUMENT_REPOSITORY = Symbol("DOCUMENT_REPOSITORY");
