import { Module } from "@nestjs/common";

import { IntakeModule } from "../intake/intake.module.js";
import { MemoryIntakeRepository } from "../intake/memory-intake.repository.js";
import { INTAKE_REPOSITORY, type IntakeRepository } from "../intake/intake.types.js";
import { KernelModule } from "../../kernel/kernel.module.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import { PRODUCT_REPOSITORY, type ProductKernelRepository } from "../../kernel/product.types.js";
import { JOB_DISPATCH_QUEUE } from "./dispatch.js";
import { createJobDispatchQueue } from "./cloud-tasks-client.js";
import { DURABLE_JOB_REPOSITORY } from "./durable-job.types.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { MemoryDurableJobRepository } from "./memory-durable-job.repository.js";
import { OutboxDispatcher } from "./outbox-dispatcher.js";
import { PostgresDurableJobRepository } from "./postgres-durable-job.repository.js";
import {
  DeterministicMalwareScanner,
  HeaderFirstInspectionAdapter,
  INSPECTION_ADAPTER,
  MALWARE_SCANNER,
  RequiredScannerUnavailable,
} from "../intake/inspection-adapter.js";
import { LocalInspectionExecutor } from "./local-inspection-executor.js";
import { LocalJobRuntime } from "./local-job-runtime.js";

@Module({
  imports: [KernelModule, IntakeModule],
  controllers: [JobsController],
  providers: [
    {
      provide: DURABLE_JOB_REPOSITORY,
      async useFactory(intake: IntakeRepository, product: ProductKernelRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) {
          return PostgresDurableJobRepository.connect(connectionString, process.env["IPW_DATABASE_MIGRATE"] === "1");
        }
        if (!(intake instanceof MemoryIntakeRepository)) throw new Error("Local jobs require the memory intake repository");
        if (!(product instanceof MemoryProductKernelRepository)) throw new Error("Local jobs require the memory product repository");
        if (process.env["NODE_ENV"] === "production") throw new Error("IPW_DATABASE_URL is required in production");
        return new MemoryDurableJobRepository(intake, product);
      },
      inject: [INTAKE_REPOSITORY, PRODUCT_REPOSITORY],
    },
    { provide: JOB_DISPATCH_QUEUE, useFactory: () => createJobDispatchQueue(process.env) },
    {
      provide: MALWARE_SCANNER,
      useFactory: () => process.env["NODE_ENV"] === "production"
        ? new RequiredScannerUnavailable()
        : new DeterministicMalwareScanner(),
    },
    { provide: INSPECTION_ADAPTER, useFactory: () => new HeaderFirstInspectionAdapter() },
    OutboxDispatcher,
    LocalInspectionExecutor,
    LocalJobRuntime,
    JobsService,
  ],
  exports: [DURABLE_JOB_REPOSITORY, JOB_DISPATCH_QUEUE, JobsService, LocalInspectionExecutor, OutboxDispatcher],
})
export class JobsModule {}
