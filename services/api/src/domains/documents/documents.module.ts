import { Module } from "@nestjs/common";

import { KernelModule } from "../../kernel/kernel.module.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { PRODUCT_REPOSITORY, RUNTIME_VALUES, type ProductKernelRepository } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import { IdentityModule } from "../identity/identity.module.js";
import { IntakeModule } from "../intake/intake.module.js";
import { MemoryIntakeRepository } from "../intake/memory-intake.repository.js";
import { INTAKE_REPOSITORY, type IntakeRepository } from "../intake/intake.types.js";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";
import { DOCUMENT_REPOSITORY } from "./documents.types.js";
import { MemoryDocumentRepository } from "./memory-document.repository.js";
import { PostgresDocumentRepository } from "./postgres-document.repository.js";

@Module({
  imports: [KernelModule, IdentityModule, IntakeModule],
  controllers: [DocumentsController],
  providers: [
    {
      provide: DOCUMENT_REPOSITORY,
      async useFactory(runtime: RuntimeValues, product: ProductKernelRepository, intake: IntakeRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) return PostgresDocumentRepository.connect(connectionString, runtime, process.env["IPW_DATABASE_MIGRATE"] === "1");
        if (!(product instanceof MemoryProductKernelRepository) || !(intake instanceof MemoryIntakeRepository)) {
          throw new Error("Local document APIs require deterministic memory repositories");
        }
        if (process.env["NODE_ENV"] === "production") throw new Error("IPW_DATABASE_URL is required in production");
        return new MemoryDocumentRepository(runtime);
      },
      inject: [RUNTIME_VALUES, PRODUCT_REPOSITORY, INTAKE_REPOSITORY],
    },
    DocumentsService,
  ],
  exports: [DOCUMENT_REPOSITORY, DocumentsService],
})
export class DocumentsModule {}
