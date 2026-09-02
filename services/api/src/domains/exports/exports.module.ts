import { Module } from "@nestjs/common";

import { KernelModule } from "../../kernel/kernel.module.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { PRODUCT_REPOSITORY, RUNTIME_VALUES, type ProductKernelRepository } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { IntakeModule } from "../intake/intake.module.js";
import { ExportsController } from "./exports.controller.js";
import { ExportsService } from "./exports.service.js";
import { IMAGE_EXPORT_REPOSITORY } from "./exports.types.js";
import { MemoryImageExportRepository } from "./memory-image-export.repository.js";
import { PostgresImageExportRepository } from "./postgres-image-export.repository.js";

@Module({
  imports: [KernelModule, IdentityModule, IntakeModule, DocumentsModule],
  controllers: [ExportsController],
  providers: [
    {
      provide: IMAGE_EXPORT_REPOSITORY,
      async useFactory(runtime: RuntimeValues, product: ProductKernelRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) return PostgresImageExportRepository.connect(connectionString, runtime, process.env["IPW_DATABASE_MIGRATE"] === "1");
        if (!(product instanceof MemoryProductKernelRepository)) throw new Error("Local image exports require the deterministic product repository");
        if (process.env["NODE_ENV"] === "production") throw new Error("IPW_DATABASE_URL is required in production");
        return new MemoryImageExportRepository(runtime);
      },
      inject: [RUNTIME_VALUES, PRODUCT_REPOSITORY],
    },
    ExportsService,
  ],
  exports: [IMAGE_EXPORT_REPOSITORY, ExportsService],
})
export class ExportsModule {}
