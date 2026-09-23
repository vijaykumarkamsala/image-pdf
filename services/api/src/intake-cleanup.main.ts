import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { SensitiveLogger } from "./common/logger.js";
import { FaceQualityService } from "./domains/image-quality/face-quality.service.js";
import { IntakeService } from "./domains/intake/intake.service.js";

const app = await NestFactory.createApplicationContext(AppModule, { logger: new SensitiveLogger() });
try {
  const intake = await app.get(IntakeService).cleanupExpired();
  const faceArtifacts = await app.get(FaceQualityService).cleanupExpiredArtifacts();
  const result = {
    cleaned: intake.cleaned,
    face_artifacts_cleaned: faceArtifacts.cleaned,
    face_artifact_objects_removed: faceArtifacts.objectsRemoved,
    failed: intake.failed + faceArtifacts.failed,
  };
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.failed) process.exitCode = 1;
} finally {
  await app.close();
}
