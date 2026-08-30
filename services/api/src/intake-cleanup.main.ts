import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { SensitiveLogger } from "./common/logger.js";
import { IntakeService } from "./domains/intake/intake.service.js";

const app = await NestFactory.createApplicationContext(AppModule, { logger: new SensitiveLogger() });
try {
  const result = await app.get(IntakeService).cleanupExpired();
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.failed) process.exitCode = 1;
} finally {
  await app.close();
}
