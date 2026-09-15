import { Module } from "@nestjs/common";

import { KernelModule } from "../../kernel/kernel.module.js";
import { PRODUCT_REPOSITORY, RUNTIME_VALUES, type ProductKernelRepository } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { IntakeModule } from "../intake/intake.module.js";
import { ImageQualityController } from "./image-quality.controller.js";
import { ImageQualityService } from "./image-quality.service.js";
import { IMAGE_QUALITY_REPOSITORY } from "./image-quality.types.js";
import { MemoryImageQualityRepository } from "./memory-image-quality.repository.js";
import { PostgresImageQualityRepository } from "./postgres-image-quality.repository.js";

@Module({
  imports: [KernelModule, IntakeModule],
  controllers: [ImageQualityController],
  providers: [
    {
      provide: IMAGE_QUALITY_REPOSITORY,
      async useFactory(runtime: RuntimeValues, product: ProductKernelRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) {
          return PostgresImageQualityRepository.connect(
            connectionString,
            runtime,
            process.env["IPW_DATABASE_MIGRATE"] === "1",
          );
        }
        if (!(product instanceof MemoryProductKernelRepository)) {
          throw new Error("Local image-quality jobs require the memory product repository");
        }
        if (process.env["NODE_ENV"] === "production") {
          throw new Error("IPW_DATABASE_URL is required in production");
        }
        return new MemoryImageQualityRepository(runtime);
      },
      inject: [RUNTIME_VALUES, PRODUCT_REPOSITORY],
    },
    ImageQualityService,
  ],
  exports: [IMAGE_QUALITY_REPOSITORY, ImageQualityService],
})
export class ImageQualityModule {}
