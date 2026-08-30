import { Global, Module } from "@nestjs/common";

import { MemoryProductKernelRepository } from "./memory.repository.js";
import { PostgresProductKernelRepository } from "./postgres.repository.js";
import { PRODUCT_REPOSITORY, RUNTIME_VALUES } from "./product.types.js";
import { DeterministicRuntimeValues, SystemRuntimeValues } from "./runtime.js";
import { ProductKernelService } from "./kernel.service.js";
import { IdentityBoundary } from "../domains/identity/identity.service.js";

@Global()
@Module({
  providers: [
    {
      provide: RUNTIME_VALUES,
      useFactory() {
        return process.env["NODE_ENV"] === "test"
          ? new DeterministicRuntimeValues()
          : new SystemRuntimeValues();
      },
    },
    {
      provide: PRODUCT_REPOSITORY,
      async useFactory(runtime: DeterministicRuntimeValues | SystemRuntimeValues) {
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
      inject: [RUNTIME_VALUES],
    },
    IdentityBoundary,
    ProductKernelService,
  ],
  exports: [PRODUCT_REPOSITORY, RUNTIME_VALUES, IdentityBoundary, ProductKernelService],
})
export class KernelModule {}
