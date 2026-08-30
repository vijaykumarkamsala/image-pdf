import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { loadConfig } from "./common/config.js";
import { SensitiveLogger } from "./common/logger.js";
import { ProductErrorFilter } from "./common/product-error.filter.js";

export async function bootstrap() {
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule, {
    logger: new SensitiveLogger(),
  });

  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProductErrorFilter());
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  return app;
}

if (process.env["NODE_ENV"] !== "test") {
  void bootstrap();
}
