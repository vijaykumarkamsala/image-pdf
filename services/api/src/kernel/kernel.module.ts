import { Global, Module } from "@nestjs/common";

import { MemoryProductKernelRepository } from "./memory.repository.js";
import { PostgresProductKernelRepository } from "./postgres.repository.js";
import { PRODUCT_REPOSITORY } from "./product.types.js";
import { DeterministicRuntimeValues, SystemRuntimeValues } from "./runtime.js";
import { ProductKernelService } from "./kernel.service.js";
import { IdentityBoundary } from "../domains/identity/identity.service.js";

@Global()
@Module({
  providers: [
    {
      provide: PRODUCT_REPOSITORY,
      async useFactory() {
        const deterministic = process.env["NODE_ENV"] === "test";
        const runtime = deterministic ? new DeterministicRuntimeValues() : new SystemRuntimeValues();
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) {
          return PostgresProductKernelRepository.connect(
            connectionString,
            runtime,
            process.env["IPW_DATABASE_MIGRATE"] === "1",
          );
        }
        if (process.env["NODE_ENV"] === "production") {
          throw new Error("IPW_DATABASE_URL is required in production");
        }
        return new MemoryProductKernelRepository(runtime);
      },
    },
    IdentityBoundary,
    ProductKernelService,
  ],
  exports: [PRODUCT_REPOSITORY, ProductKernelService],
})
export class KernelModule {}
