import { Module } from "@nestjs/common";

import { KernelModule } from "../../kernel/kernel.module.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { PRODUCT_REPOSITORY, RUNTIME_VALUES, type ProductKernelRepository } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import { DocumentsModule } from "../documents/documents.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { IntakeModule } from "../intake/intake.module.js";
import { MemoryPdfExportRepository } from "./memory-pdf-export.repository.js";
import { PdfController } from "./pdf.controller.js";
import { PdfService } from "./pdf.service.js";
import { PDF_EXPORT_REPOSITORY } from "./pdf.types.js";
import { PostgresPdfExportRepository } from "./postgres-pdf-export.repository.js";

@Module({
  imports: [KernelModule, IdentityModule, IntakeModule, DocumentsModule],
  controllers: [PdfController],
  providers: [
    {
      provide: PDF_EXPORT_REPOSITORY,
      async useFactory(runtime: RuntimeValues, product: ProductKernelRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) return PostgresPdfExportRepository.connect(connectionString, runtime, process.env["IPW_DATABASE_MIGRATE"] === "1");
        if (!(product instanceof MemoryProductKernelRepository)) throw new Error("Local PDF exports require the deterministic product repository");
        if (process.env["NODE_ENV"] === "production") throw new Error("IPW_DATABASE_URL is required in production");
        return new MemoryPdfExportRepository(runtime);
      },
      inject: [RUNTIME_VALUES, PRODUCT_REPOSITORY],
    },
    PdfService,
  ],
  exports: [PDF_EXPORT_REPOSITORY, PdfService],
})
export class PdfModule {}
