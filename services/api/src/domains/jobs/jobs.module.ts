import { Module } from "@nestjs/common";

import { IntakeModule } from "../intake/intake.module.js";
import { MemoryIntakeRepository } from "../intake/memory-intake.repository.js";
import { INTAKE_REPOSITORY, type IntakeRepository } from "../intake/intake.types.js";
import { KernelModule } from "../../kernel/kernel.module.js";
import { JOB_DISPATCH_QUEUE, LocalJobDispatchQueue } from "./dispatch.js";
import { DURABLE_JOB_REPOSITORY } from "./durable-job.types.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { MemoryDurableJobRepository } from "./memory-durable-job.repository.js";
import { OutboxDispatcher } from "./outbox-dispatcher.js";
import { PostgresDurableJobRepository } from "./postgres-durable-job.repository.js";

@Module({
  imports: [KernelModule, IntakeModule],
  controllers: [JobsController],
  providers: [
    {
      provide: DURABLE_JOB_REPOSITORY,
      async useFactory(intake: IntakeRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) {
          return PostgresDurableJobRepository.connect(connectionString, process.env["IPW_DATABASE_MIGRATE"] === "1");
        }
        if (!(intake instanceof MemoryIntakeRepository)) throw new Error("Local jobs require the memory intake repository");
        if (process.env["NODE_ENV"] === "production") throw new Error("IPW_DATABASE_URL is required in production");
        return new MemoryDurableJobRepository(intake);
      },
      inject: [INTAKE_REPOSITORY],
    },
    { provide: JOB_DISPATCH_QUEUE, useFactory: () => new LocalJobDispatchQueue() },
    OutboxDispatcher,
    JobsService,
  ],
  exports: [DURABLE_JOB_REPOSITORY, JOB_DISPATCH_QUEUE, JobsService, OutboxDispatcher],
})
export class JobsModule {}
