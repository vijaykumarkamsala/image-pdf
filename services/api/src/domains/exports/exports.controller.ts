import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { attachment } from "../../kernel/http-delivery.js";
import { ExportsService } from "./exports.service.js";

export { attachment } from "../../kernel/http-delivery.js";

type RequestHeaders = Record<string, string | string[] | undefined>;
type RequestBody = Record<string, unknown>;

@Controller("workspaces/:workspaceId")
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get("documents/:documentId/recipes")
  listRecipes(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.exports.listRecipes(headers, workspaceId, documentId);
  }

  @Post("documents/:documentId/recipes")
  createRecipe(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.exports.createRecipe(headers, workspaceId, documentId, body);
  }

  @Patch("documents/:documentId/recipes/:recipeId")
  updateRecipe(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Param("recipeId") recipeId: string, @Body() body: RequestBody) {
    return this.exports.updateRecipe(headers, workspaceId, documentId, recipeId, body);
  }

  @Post("documents/:documentId/recommendations")
  recommendations(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.exports.recommendations(headers, workspaceId, documentId, body);
  }

  @Patch("recommendation-sets/:recommendationSetId/decisions")
  decideRecommendations(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("recommendationSetId") recommendationSetId: string, @Body() body: RequestBody) {
    return this.exports.decideRecommendations(headers, workspaceId, recommendationSetId, body);
  }

  @Post("documents/:documentId/enhancement-previews")
  preview(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.exports.preview(headers, workspaceId, documentId, body);
  }

  @Get("enhancement-previews/:previewId")
  getPreview(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("previewId") previewId: string) {
    return this.exports.getPreview(headers, workspaceId, previewId);
  }

  @Post("documents/:documentId/exports")
  submit(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.exports.submit(headers, workspaceId, documentId, body);
  }

  @Get("exports")
  list(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Query("document_id") documentId?: string) {
    return this.exports.list(headers, workspaceId, documentId);
  }

  @Get("exports/:exportRequestId")
  get(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("exportRequestId") exportRequestId: string) {
    return this.exports.get(headers, workspaceId, exportRequestId);
  }

  @Post("exports/:exportRequestId/cancel")
  cancel(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("exportRequestId") exportRequestId: string) {
    return this.exports.cancel(headers, workspaceId, exportRequestId);
  }

  @Post("exports/:exportRequestId/retry")
  retry(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("exportRequestId") exportRequestId: string) {
    return this.exports.retry(headers, workspaceId, exportRequestId);
  }

  @Post("exports/:exportRequestId/bundles")
  bundle(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("exportRequestId") exportRequestId: string) {
    return this.exports.bundle(headers, workspaceId, exportRequestId);
  }

  @Get("export-bundles/:bundleId")
  getBundle(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("bundleId") bundleId: string) {
    return this.exports.getBundle(headers, workspaceId, bundleId);
  }

  @Get("export-outputs/:outputId/download")
  async outputDownload(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("outputId") outputId: string, @Res() response: Response) {
    const delivery = await this.exports.outputDownload(headers, workspaceId, outputId);
    sendDelivery(response, headers, delivery);
  }

  @Get("export-bundles/:bundleId/download")
  async bundleDownload(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("bundleId") bundleId: string, @Res() response: Response) {
    const delivery = await this.exports.bundleDownload(headers, workspaceId, bundleId);
    sendDelivery(response, headers, delivery);
  }

  @Post("batches/plan")
  planBatch(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Body() body: RequestBody) {
    return this.exports.planBatch(headers, workspaceId, body);
  }

  @Post("batches")
  submitBatch(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Body() body: RequestBody) {
    return this.exports.submitBatch(headers, workspaceId, body);
  }

  @Get("batches")
  listBatches(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string) {
    return this.exports.listBatches(headers, workspaceId);
  }

  @Get("batches/:batchId")
  getBatch(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("batchId") batchId: string) {
    return this.exports.getBatch(headers, workspaceId, batchId);
  }

  @Post("batches/:batchId/cancel")
  cancelBatch(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("batchId") batchId: string) {
    return this.exports.cancelBatch(headers, workspaceId, batchId);
  }

  @Post("batches/:batchId/retry")
  retryBatch(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("batchId") batchId: string) {
    return this.exports.retryBatch(headers, workspaceId, batchId);
  }

  @Get("batches/:batchId/report")
  batchReport(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("batchId") batchId: string) {
    return this.exports.batchReport(headers, workspaceId, batchId);
  }
}

function sendDelivery(
  response: Response,
  headers: RequestHeaders,
  delivery: { mediaType: string; filename: string; bytes: Uint8Array },
): void {
  const bytes = Buffer.from(delivery.bytes);
  response
    .type(delivery.mediaType)
    .setHeader("Cache-Control", "private, no-store, max-age=0")
    .setHeader("Pragma", "no-cache")
    .setHeader("X-Content-Type-Options", "nosniff")
    .setHeader("Accept-Ranges", "bytes")
    .setHeader("Content-Disposition", attachment(delivery.filename));
  const rawRange = Array.isArray(headers["range"]) ? headers["range"][0] : headers["range"];
  if (!rawRange) {
    response.setHeader("Content-Length", String(bytes.byteLength)).send(bytes);
    return;
  }
  const range = parseRange(rawRange, bytes.byteLength);
  if (!range) {
    response.status(416).setHeader("Content-Range", `bytes */${bytes.byteLength}`).send();
    return;
  }
  const selected = bytes.subarray(range.start, range.end + 1);
  response
    .status(206)
    .setHeader("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`)
    .setHeader("Content-Length", String(selected.byteLength))
    .send(selected);
}

export function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
