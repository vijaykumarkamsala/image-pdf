import { Module } from "@nestjs/common";
import { resolve } from "node:path";

import { IdentityModule } from "../identity/identity.module.js";
import { KernelModule } from "../../kernel/kernel.module.js";
import { INTAKE_REPOSITORY } from "./intake.types.js";
import { IntakeController } from "./intake.controller.js";
import { IntakeService } from "./intake.service.js";
import { MemoryIntakeRepository } from "./memory-intake.repository.js";
import { PostgresIntakeRepository } from "./postgres-intake.repository.js";
import { PRODUCT_REPOSITORY, type ProductKernelRepository } from "../../kernel/product.types.js";
import { MemoryProductKernelRepository } from "../../kernel/memory.repository.js";
import {
  GUEST_HANDOFF_REPOSITORY,
  MemoryGuestHandoffRepository,
  PostgresGuestHandoffRepository,
} from "./guest-handoff.repository.js";
import {
  LocalFilesystemPrivateObjectStore,
  MemoryPrivateObjectStore,
  PRIVATE_OBJECT_STORE,
} from "./private-object-store.js";

@Module({
  imports: [KernelModule, IdentityModule],
  controllers: [IntakeController],
  providers: [
    {
      provide: INTAKE_REPOSITORY,
      async useFactory() {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) {
          return PostgresIntakeRepository.connect(connectionString, process.env["IPW_DATABASE_MIGRATE"] === "1");
        }
        if (process.env["NODE_ENV"] === "production") throw new Error("IPW_DATABASE_URL is required in production");
        return new MemoryIntakeRepository();
      },
    },
    {
      provide: PRIVATE_OBJECT_STORE,
      useFactory() {
        if (process.env["NODE_ENV"] === "test") return new MemoryPrivateObjectStore();
        if (process.env["NODE_ENV"] === "production") {
          throw new Error("A configured private GCS object-store adapter is required in production");
        }
        return new LocalFilesystemPrivateObjectStore(
          resolve(process.env["IPW_LOCAL_STORAGE_ROOT"] ?? "data/local-storage/product-v2"),
        );
      },
    },
    {
      provide: GUEST_HANDOFF_REPOSITORY,
      async useFactory(intake: unknown, product: ProductKernelRepository) {
        const connectionString = process.env["IPW_DATABASE_URL"];
        if (connectionString) {
          return PostgresGuestHandoffRepository.connect(
            connectionString,
            process.env["IPW_DATABASE_MIGRATE"] === "1",
          );
        }
        if (!(intake instanceof MemoryIntakeRepository) || !(product instanceof MemoryProductKernelRepository)) {
          throw new Error("Local guest handoff requires memory repositories");
        }
        return new MemoryGuestHandoffRepository(intake, product);
      },
      inject: [INTAKE_REPOSITORY, PRODUCT_REPOSITORY],
    },
    IntakeService,
  ],
  exports: [GUEST_HANDOFF_REPOSITORY, IntakeService, INTAKE_REPOSITORY, PRIVATE_OBJECT_STORE],
})
export class IntakeModule {}
