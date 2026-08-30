import { Module } from "@nestjs/common";

import { IdentityController } from "./identity.controller.js";

@Module({ controllers: [IdentityController] })
export class IdentityModule {}
