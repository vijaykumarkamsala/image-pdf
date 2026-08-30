import { Controller, Headers, Post } from "@nestjs/common";

import { ProductKernelService } from "../../kernel/kernel.service.js";

@Controller("session")
export class IdentityController {
  constructor(private readonly kernel: ProductKernelService) {}

  @Post("bootstrap")
  bootstrap(@Headers() headers: Record<string, string | string[] | undefined>) {
    return this.kernel.bootstrap(headers);
  }
}
