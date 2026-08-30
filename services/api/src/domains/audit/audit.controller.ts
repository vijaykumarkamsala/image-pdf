import { Controller, Get, Headers, Param } from "@nestjs/common";

import { ProductKernelService } from "../../kernel/kernel.service.js";

@Controller("workspaces/:workspaceId/audit-events")
export class AuditController {
  constructor(private readonly kernel: ProductKernelService) {}

  @Get()
  list(
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Param("workspaceId") workspaceId: string,
  ) {
    return this.kernel.audit(headers, workspaceId);
  }
}
