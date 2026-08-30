import { Module } from "@nestjs/common";

import { WorkspacesController } from "./workspaces.controller.js";

@Module({ controllers: [WorkspacesController] })
export class WorkspacesModule {}
