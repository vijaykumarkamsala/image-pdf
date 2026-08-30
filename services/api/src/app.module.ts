import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";

import { TraceMiddleware } from "./common/trace.middleware.js";
import { HealthController } from "./health.controller.js";
import { AuditModule } from "./domains/audit/audit.module.js";
import { FilesModule } from "./domains/files/files.module.js";
import { IdentityModule } from "./domains/identity/identity.module.js";
import { ProjectsModule } from "./domains/projects/projects.module.js";
import { UsageModule } from "./domains/usage/usage.module.js";
import { WorkspacesModule } from "./domains/workspaces/workspaces.module.js";
import { KernelModule } from "./kernel/kernel.module.js";

@Module({
  imports: [
    KernelModule,
    IdentityModule,
    WorkspacesModule,
    ProjectsModule,
    FilesModule,
    AuditModule,
    UsageModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes("*");
  }
}
