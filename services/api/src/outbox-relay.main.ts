import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { SensitiveLogger } from "./common/logger.js";
import { OutboxDispatcher } from "./domains/jobs/outbox-dispatcher.js";

const app = await NestFactory.createApplicationContext(AppModule, { logger: new SensitiveLogger() });
try {
  const dispatched = await app.get(OutboxDispatcher).dispatchOnce(100);
  process.stdout.write(JSON.stringify({ dispatched }) + "\n");
} finally {
  await app.close();
}
