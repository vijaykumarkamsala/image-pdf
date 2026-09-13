import { Controller, Get, Headers, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { attachment } from "../../kernel/http-delivery.js";
import { PdfService } from "./pdf.service.js";

type RequestHeaders = Record<string, string | string[] | undefined>;

@Controller("workspaces/:workspaceId")
export class PdfController {
  constructor(private readonly pdf: PdfService) {}

  @Get("pdf-files")
  capabilityReports(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
  ) {
    return this.pdf.capabilityReports(headers, workspaceId);
  }

  @Get("pdf-files/:fileId/capability-report")
  capabilityReport(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Param("fileId") fileId: string,
  ) {
    return this.pdf.capabilityReport(headers, workspaceId, fileId);
  }

  @Get("documents/:documentId/pdf-preflight")
  preflight(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.pdf.preflight(headers, workspaceId, documentId);
  }

  @Post("documents/:documentId/pdf-exports")
  create(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.pdf.createExport(headers, workspaceId, documentId);
  }

  @Get("pdf-exports")
  list(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Query("document_id") documentId?: string) {
    return this.pdf.list(headers, workspaceId, documentId);
  }

  @Get("pdf-exports/:requestId")
  get(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("requestId") requestId: string) {
    return this.pdf.get(headers, workspaceId, requestId);
  }

  @Patch("pdf-exports/:requestId/cancel")
  cancel(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("requestId") requestId: string) {
    return this.pdf.cancel(headers, workspaceId, requestId);
  }

  @Post("pdf-exports/:requestId/retry")
  retry(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("requestId") requestId: string) {
    return this.pdf.retry(headers, workspaceId, requestId);
  }

  @Get("pdf-exports/:requestId/download")
  async download(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Param("requestId") requestId: string,
    @Res() response: Response,
  ) {
    const delivery = await this.pdf.download(headers, workspaceId, requestId);
    const bytes = Buffer.from(delivery.bytes);
    response
      .type("application/pdf")
      .setHeader("Cache-Control", "private, no-store, max-age=0")
      .setHeader("Pragma", "no-cache")
      .setHeader("X-Content-Type-Options", "nosniff")
      .setHeader("Content-Disposition", attachment(delivery.filename))
      .setHeader("Content-Length", String(bytes.byteLength))
      .send(bytes);
  }
}
