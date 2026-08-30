import { Body, Controller, Get, Headers, Param, Post } from "@nestjs/common";

import { ProductKernelService } from "../../kernel/kernel.service.js";

@Controller("workspaces/:workspaceId/projects")
export class ProjectsController {
  constructor(private readonly kernel: ProductKernelService) {}

  @Get()
  list(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
  ) {
    return this.kernel.listProjects(headers, workspaceId);
  }

  @Post()
  create(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.kernel.createProject(headers, workspaceId, body);
  }
}
