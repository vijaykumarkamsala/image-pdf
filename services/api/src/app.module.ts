import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";

import { TraceMiddleware } from "./common/trace.middleware.js";
import { HealthController } from "./health.controller.js";
import { AssetsModule } from "./domains/assets/assets.module.js";
import { ConnectorsModule } from "./domains/connectors/connectors.module.js";
import { EsignModule } from "./domains/esign/esign.module.js";
import { ExportsModule } from "./domains/exports/exports.module.js";
import { IdentityModule } from "./domains/identity/identity.module.js";
import { JobsModule } from "./domains/jobs/jobs.module.js";
import { ProjectsModule } from "./domains/projects/projects.module.js";
import { SharingModule } from "./domains/sharing/sharing.module.js";
import { WorkspacesModule } from "./domains/workspaces/workspaces.module.js";

@Module({
  imports: [
    IdentityModule,
    WorkspacesModule,
    ProjectsModule,
    AssetsModule,
    JobsModule,
    ExportsModule,
    SharingModule,
    EsignModule,
    ConnectorsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes("*");
  }
}
