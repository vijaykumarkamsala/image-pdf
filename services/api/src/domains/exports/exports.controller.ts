import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { ExportsService } from "./exports.service.js";

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

  @Post("documents/:documentId/enhancement-previews")
  preview(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.exports.preview(headers, workspaceId, documentId, body);
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
    response.type(delivery.mediaType).setHeader("Content-Disposition", attachment(delivery.filename)).send(Buffer.from(delivery.bytes));
  }

  @Get("export-bundles/:bundleId/download")
  async bundleDownload(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("bundleId") bundleId: string, @Res() response: Response) {
    const delivery = await this.exports.bundleDownload(headers, workspaceId, bundleId);
    response.type(delivery.mediaType).setHeader("Content-Disposition", attachment(delivery.filename)).send(Buffer.from(delivery.bytes));
  }
}

function attachment(filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 240);
  return `attachment; filename="${safe}"`;
}
