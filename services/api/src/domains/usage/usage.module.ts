import { Module } from "@nestjs/common";

import { UsageController } from "./usage.controller.js";

@Module({ controllers: [UsageController] })
export class UsageModule {}
