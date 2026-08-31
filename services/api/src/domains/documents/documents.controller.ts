import { Body, Controller, Get, Headers, Param, Patch, Post, Res } from "@nestjs/common";
import type { Response } from "express";

import { DocumentsService } from "./documents.service.js";

type RequestHeaders = Record<string, string | string[] | undefined>;
type RequestBody = Record<string, unknown>;

@Controller("workspaces/:workspaceId/documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string) {
    return this.documents.list(headers, workspaceId);
  }

  @Post()
  create(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Body() body: RequestBody) {
    return this.documents.create(headers, workspaceId, body);
  }

  @Get(":documentId")
  get(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.documents.get(headers, workspaceId, documentId);
  }

  @Patch(":documentId")
  mutate(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.documents.mutate(headers, workspaceId, documentId, body);
  }

  @Post(":documentId/lease")
  lease(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.documents.acquireLease(headers, workspaceId, documentId);
  }

  @Post(":documentId/lease/heartbeat")
  heartbeat(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.documents.heartbeat(headers, workspaceId, documentId);
  }

  @Post(":documentId/lease/release")
  release(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.documents.releaseLease(headers, workspaceId, documentId);
  }

  @Post(":documentId/lease/takeover")
  takeover(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.documents.takeover(headers, workspaceId, documentId, body);
  }

  @Post(":documentId/undo")
  undo(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.documents.undo(headers, workspaceId, documentId);
  }

  @Post(":documentId/redo")
  redo(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.documents.redo(headers, workspaceId, documentId);
  }

  @Post(":documentId/versions")
  version(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.documents.createVersion(headers, workspaceId, documentId, body);
  }

  @Post(":documentId/versions/:versionId/restore")
  restore(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Param("versionId") versionId: string) {
    return this.documents.restore(headers, workspaceId, documentId, versionId);
  }

  @Post(":documentId/save-as")
  saveAs(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string, @Body() body: RequestBody) {
    return this.documents.saveAs(headers, workspaceId, documentId, body);
  }

  @Get(":documentId/compatibility-reports")
  compatibility(@Headers() headers: RequestHeaders, @Param("workspaceId") workspaceId: string, @Param("documentId") documentId: string) {
    return this.documents.compatibility(headers, workspaceId, documentId);
  }

  @Get(":documentId/source")
  async source(
    @Headers() headers: RequestHeaders,
    @Param("workspaceId") workspaceId: string,
    @Param("documentId") documentId: string,
    @Res() response: Response,
  ) {
    const source = await this.documents.source(headers, workspaceId, documentId);
    response.type(source.mediaType).setHeader("Content-Disposition", "inline").send(Buffer.from(source.bytes));
  }
}
