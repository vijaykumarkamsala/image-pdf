import { Module } from "@nestjs/common";

import { KernelModule } from "../../kernel/kernel.module.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { PRODUCT_REPOSITORY, type ProductKernelRepository } from "../../kernel/product.types.js";
import { INTAKE_REPOSITORY, type IntakeRepository } from "../intake/intake.types.js";
import { IntakeModule } from "../intake/intake.module.js";
import { MemoryIntakeRepository } from "../intake/memory-intake.repository.js";
import { DURABLE_JOB_REPOSITORY, type DurableJobRepository } from "../jobs/durable-job.types.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { MemoryDurableJobRepository } from "../jobs/memory-durable-job.repository.js";
import { DocumentsModule } from "../documents/documents.module.js";
import { DOCUMENT_REPOSITORY, type DocumentRepository } from "../documents/documents.types.js";
import { ExperienceController } from "./experience.controller.js";
import { ExperienceService } from "./experience.service.js";
import { EXPERIENCE_REPOSITORY } from "./experience.types.js";
import { MemoryExperienceRepository } from "./memory-experience.repository.js";
import { PostgresExperienceRepository } from "./postgres-experience.repository.js";

@Module({
  imports: [KernelModule, IntakeModule, JobsModule, DocumentsModule],
  controllers: [ExperienceController],
  providers: [
    {
      provide: EXPERIENCE_REPOSITORY,
      async useFactory(product: ProductKernelRepository, jobs: DurableJobRepository, intake: IntakeRepository, documents: DocumentRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) {
          return PostgresExperienceRepository.connect(connectionString, process.env["IPW_DATABASE_MIGRATE"] === "1");
        }
        if (!(product instanceof MemoryProductKernelRepository)
          || !(jobs instanceof MemoryDurableJobRepository)
          || !(intake instanceof MemoryIntakeRepository)) {
          throw new Error("Local experience APIs require deterministic memory repositories");
        }
        if (process.env["NODE_ENV"] === "production") throw new Error("IPW_DATABASE_URL is required in production");
        return new MemoryExperienceRepository(product, jobs, intake, documents);
      },
      inject: [PRODUCT_REPOSITORY, DURABLE_JOB_REPOSITORY, INTAKE_REPOSITORY, DOCUMENT_REPOSITORY],
    },
    ExperienceService,
  ],
  exports: [EXPERIENCE_REPOSITORY, ExperienceService],
})
export class ExperienceModule {}
