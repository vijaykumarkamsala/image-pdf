import { Module } from "@nestjs/common";

import { KernelModule } from "../../kernel/kernel.module.js";
import { AuthService } from "./auth.service.js";
import { IdentityController } from "./identity.controller.js";
import { DeterministicOidcProvider, DiscoveryOidcProvider, loadOidcConfig } from "./oidc.provider.js";
import { OIDC_PROVIDER } from "./auth.types.js";

@Module({
  imports: [KernelModule],
  controllers: [IdentityController],
  providers: [
    {
      provide: OIDC_PROVIDER,
      useFactory() {
        const config = loadOidcConfig(process.env);
        if (config) return new DiscoveryOidcProvider(config);
        if (process.env["NODE_ENV"] === "production") throw new Error("OIDC configuration is required in production");
        return new DeterministicOidcProvider();
      },
    },
    AuthService,
  ],
  exports: [AuthService],
})
export class IdentityModule {}
