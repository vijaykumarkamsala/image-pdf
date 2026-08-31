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

export interface DocumentRepository {
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
  ): Promise<DocumentCommandResult<DocumentReadModel>>;
  acquireLease(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
  ): Promise<EditorLeaseGrant>;
  heartbeatLease(
    actorId: string,
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
  takeoverLease(
    context: CommandContext,
    workspaceId: string,
    documentId: string,
    force: boolean,
  ): Promise<LeaseTakeoverResult>;
  compatibilityReports(
    actorId: string,
    workspaceId: string,
    documentId: string,
  ): Promise<ImportCompatibilityReport[]>;
  close(): Promise<void>;
}

export const DOCUMENT_REPOSITORY = Symbol("DOCUMENT_REPOSITORY");
