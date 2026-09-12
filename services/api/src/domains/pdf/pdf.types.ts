import type {
  PdfExportRequestRecord,
  PdfExportResult,
  PdfPreflightReport,
} from "ipw-contracts-ts/product";

import type { CommandContext } from "../../kernel/product.types.js";

export interface PdfExportReadModel {
  request: PdfExportRequestRecord;
  result: PdfExportResult | null;
}

export interface PdfExportDelivery {
  objectKey: string;
  storageGeneration: string;
  byteSize: number;
  mediaType: "application/pdf";
  filename: string;
  sha256: string;
}

export interface CreatePdfExportInput {
  workspaceId: string;
  preflight: PdfPreflightReport;
}

export interface PdfExportRepository {
  readonly recordsMutationsAtomically: boolean;
  create(
    context: CommandContext,
    input: CreatePdfExportInput,
  ): Promise<{ value: PdfExportReadModel; replayed: boolean }>;
  list(actorId: string, workspaceId: string, documentId?: string): Promise<PdfExportReadModel[]>;
  get(actorId: string, workspaceId: string, requestId: string): Promise<PdfExportReadModel | null>;
  cancel(
    context: CommandContext,
    workspaceId: string,
    requestId: string,
  ): Promise<{ value: PdfExportReadModel; replayed: boolean }>;
  retry(
    context: CommandContext,
    workspaceId: string,
    requestId: string,
  ): Promise<{ value: PdfExportReadModel; replayed: boolean }>;
  delivery(actorId: string, workspaceId: string, requestId: string): Promise<PdfExportDelivery | null>;
  close(): Promise<void>;
}

export const PDF_EXPORT_REPOSITORY = Symbol("PDF_EXPORT_REPOSITORY");
