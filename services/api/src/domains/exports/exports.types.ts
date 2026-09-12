import type {
  BatchGroupApproval,
  BatchPlan,
  BatchReport,
  BatchRunRecord,
  EnhancementPreview,
  ExportOutputProfile,
  ExportZipBundle,
  ImageExportRequestRecord,
  ImageOperation,
  IntendedOutcome,
  ProcessingRecipeRecord,
  RecommendationDecision,
  RecommendationSet,
} from "ipw-contracts-ts/product";

import type { CommandContext } from "../../kernel/product.types.js";

export interface ExportCommandResult<T> {
  value: T;
  replayed: boolean;
}

export interface RecipeInput {
  workspaceId: string;
  documentId: string;
  recipeId?: string;
  name: string;
  operations: ImageOperation[];
}

export interface RecommendationInput {
  workspaceId: string;
  documentId: string;
  documentVersionId: string;
  intendedOutcome: IntendedOutcome | null;
}

export interface PreviewInput {
  workspaceId: string;
  documentId: string;
  recipeId: string;
  recipeVersion: number | null;
  mode: "original" | "current" | "recommended";
  artboardId: string | null;
}

export interface RecommendationDecisionInput {
  workspaceId: string;
  recommendationSetId: string;
  decisions: Array<{ recommendationId: string; state: "accepted" | "declined" }>;
}

export interface SubmitExportInput {
  workspaceId: string;
  documentId: string;
  documentVersionId: string;
  recipeId: string;
  recipeVersion: number;
  outputs: Array<{ artboardId: string; profile: ExportOutputProfile; filename: string }>;
}

export interface BatchSubmissionInputItem {
  clientItemId: string;
  displayName: string;
  documentId: string;
  documentVersionId: string;
  recipeId: string;
  recipeVersion: number;
  outputs: Array<{ artboardId: string; profile: ExportOutputProfile; filename: string }>;
  included: boolean;
  exclusionReason: string | null;
}

export interface BatchPlanInput {
  workspaceId: string;
  name: string;
  items: BatchSubmissionInputItem[];
}

export interface BatchCreateInput extends BatchPlanInput {
  planSha256: string;
  groupApprovals: BatchGroupApproval[];
  confirmedClientItemIds: string[];
}

export interface ExportDelivery {
  objectKey: string;
  byteSize: number;
  mediaType: string;
  filename: string;
  sha256: string;
  storageGeneration: string;
}

export interface ImageExportRepository {
  readonly recordsMutationsAtomically: boolean;
  createRecipe(context: CommandContext, input: RecipeInput): Promise<ExportCommandResult<ProcessingRecipeRecord>>;
  listRecipes(actorId: string, workspaceId: string, documentId: string): Promise<ProcessingRecipeRecord[]>;
  getRecipe(actorId: string, workspaceId: string, recipeId: string, version?: number): Promise<ProcessingRecipeRecord | null>;
  recommend(context: CommandContext, input: RecommendationInput): Promise<ExportCommandResult<RecommendationSet>>;
  decideRecommendations(context: CommandContext, input: RecommendationDecisionInput): Promise<ExportCommandResult<RecommendationDecision[]>>;
  createPreview(context: CommandContext, input: PreviewInput): Promise<ExportCommandResult<EnhancementPreview>>;
  getPreview(actorId: string, workspaceId: string, previewId: string): Promise<EnhancementPreview | null>;
  submit(context: CommandContext, input: SubmitExportInput): Promise<ExportCommandResult<ImageExportRequestRecord>>;
  list(actorId: string, workspaceId: string, documentId?: string): Promise<ImageExportRequestRecord[]>;
  get(actorId: string, workspaceId: string, exportRequestId: string): Promise<ImageExportRequestRecord | null>;
  cancel(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>>;
  retry(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>>;
  createBundle(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ExportZipBundle>>;
  getBundle(actorId: string, workspaceId: string, bundleId: string): Promise<ExportZipBundle | null>;
  delivery(actorId: string, workspaceId: string, outputId: string): Promise<ExportDelivery | null>;
  bundleDelivery(actorId: string, workspaceId: string, bundleId: string): Promise<ExportDelivery | null>;
  planBatch(actorId: string, input: BatchPlanInput): Promise<BatchPlan>;
  submitBatch(context: CommandContext, input: BatchCreateInput): Promise<ExportCommandResult<BatchRunRecord>>;
  listBatches(actorId: string, workspaceId: string): Promise<BatchRunRecord[]>;
  getBatch(actorId: string, workspaceId: string, batchId: string): Promise<BatchRunRecord | null>;
  cancelBatch(context: CommandContext, workspaceId: string, batchId: string): Promise<ExportCommandResult<BatchRunRecord>>;
  retryBatch(context: CommandContext, workspaceId: string, batchId: string): Promise<ExportCommandResult<BatchRunRecord>>;
  batchReport(actorId: string, workspaceId: string, batchId: string): Promise<BatchReport | null>;
  close(): Promise<void>;
}

export const IMAGE_EXPORT_REPOSITORY = Symbol("IMAGE_EXPORT_REPOSITORY");
