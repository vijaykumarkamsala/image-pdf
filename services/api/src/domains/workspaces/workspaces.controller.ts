import { Controller, Get, Headers, Param } from "@nestjs/common";

import { ProductKernelService } from "../../kernel/kernel.service.js";

@Controller()
export class WorkspacesController {
  constructor(private readonly kernel: ProductKernelService) {}

  @Get("me/workspaces")
  list(@Headers() headers: Record<string, string | string[] | undefined>) {
    return this.kernel.listWorkspaces(headers);
  }

  @Get("workspaces/:workspaceId/context")
  context(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
  ) {
    return this.kernel.context(headers, workspaceId);
  }
}
