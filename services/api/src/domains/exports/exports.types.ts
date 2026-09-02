import type {
  EnhancementPreview,
  ExportOutputProfile,
  ExportZipBundle,
  ImageExportRequestRecord,
  ImageOperation,
  IntendedOutcome,
  ProcessingRecipeRecord,
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

export interface SubmitExportInput {
  workspaceId: string;
  documentId: string;
  documentVersionId: string;
  recipeId: string;
  recipeVersion: number;
  outputs: Array<{ artboardId: string; profile: ExportOutputProfile; filename: string }>;
}

export interface ExportDelivery {
  objectKey: string;
  byteSize: number;
  mediaType: string;
  filename: string;
}

export interface ImageExportRepository {
  readonly recordsMutationsAtomically: boolean;
  createRecipe(context: CommandContext, input: RecipeInput): Promise<ExportCommandResult<ProcessingRecipeRecord>>;
  listRecipes(actorId: string, workspaceId: string, documentId: string): Promise<ProcessingRecipeRecord[]>;
  getRecipe(actorId: string, workspaceId: string, recipeId: string, version?: number): Promise<ProcessingRecipeRecord | null>;
  recommend(context: CommandContext, input: RecommendationInput): Promise<ExportCommandResult<RecommendationSet>>;
  preview(
    actorId: string,
    workspaceId: string,
    documentId: string,
    recipe: ProcessingRecipeRecord,
    mode: EnhancementPreview["mode"],
  ): Promise<EnhancementPreview>;
  submit(context: CommandContext, input: SubmitExportInput): Promise<ExportCommandResult<ImageExportRequestRecord>>;
  list(actorId: string, workspaceId: string, documentId?: string): Promise<ImageExportRequestRecord[]>;
  get(actorId: string, workspaceId: string, exportRequestId: string): Promise<ImageExportRequestRecord | null>;
  cancel(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>>;
  retry(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ImageExportRequestRecord>>;
  createBundle(context: CommandContext, workspaceId: string, exportRequestId: string): Promise<ExportCommandResult<ExportZipBundle>>;
  getBundle(actorId: string, workspaceId: string, bundleId: string): Promise<ExportZipBundle | null>;
  delivery(actorId: string, workspaceId: string, outputId: string): Promise<ExportDelivery | null>;
  bundleDelivery(actorId: string, workspaceId: string, bundleId: string): Promise<ExportDelivery | null>;
  close(): Promise<void>;
}

export const IMAGE_EXPORT_REPOSITORY = Symbol("IMAGE_EXPORT_REPOSITORY");
