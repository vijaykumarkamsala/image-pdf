import { Body, Controller, Get, Headers, Param, Patch, Post } from "@nestjs/common";

import { ProductKernelService } from "../../kernel/kernel.service.js";

@Controller("workspaces/:workspaceId/files")
export class FilesController {
  constructor(private readonly kernel: ProductKernelService) {}

  @Get()
  list(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
  ) {
    return this.kernel.listFiles(headers, workspaceId);
  }

  @Post()
  register(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.kernel.registerFile(headers, workspaceId, body);
  }

  @Post(":fileId/source-versions")
  registerSource(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
    @Param("fileId") fileId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.kernel.registerSource(headers, workspaceId, fileId, body);
  }

  @Patch(":fileId/location")
  move(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
    @Param("fileId") fileId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.kernel.moveFile(headers, workspaceId, fileId, body);
  }

  @Get(":fileId/references")
  references(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
    @Param("fileId") fileId: string,
  ) {
    return this.kernel.listReferences(headers, workspaceId, fileId);
  }

  @Post(":fileId/references")
  addReference(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
    @Param("fileId") fileId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.kernel.addReference(headers, workspaceId, fileId, body);
  }
}
