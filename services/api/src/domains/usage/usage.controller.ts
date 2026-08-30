import { Controller, Get, Headers, Param } from "@nestjs/common";

import { ProductKernelService } from "../../kernel/kernel.service.js";

@Controller("workspaces/:workspaceId/usage-summary")
export class UsageController {
  constructor(private readonly kernel: ProductKernelService) {}

  @Get()
  summary(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
  ) {
    return this.kernel.usage(headers, workspaceId);
  }
}
