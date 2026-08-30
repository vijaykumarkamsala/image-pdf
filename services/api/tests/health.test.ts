import assert from "node:assert/strict";
import test from "node:test";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { ProductErrorFilter } from "../src/common/product-error.filter.js";

test("health and readiness endpoints return v1 envelopes with trace propagation", async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new ProductErrorFilter());
  await app.listen(0, "127.0.0.1");

  try {
    const server = app.getHttpServer() as { address(): { port: number } };
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { "x-trace-id": "trace-test" },
    });
    const body = (await response.json()) as { ok: boolean; trace_id: string };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-trace-id"), "trace-test");
    assert.deepEqual(body, {
      ok: true,
      service: "ipw-api",
      version: "v1",
      trace_id: "trace-test",
    });

    const readyResponse = await fetch(`http://127.0.0.1:${port}/v1/ready`, {
      headers: { "x-trace-id": "trace-ready" },
    });
    const readyBody = (await readyResponse.json()) as {
      ok: boolean;
      service: string;
      dependencies: Record<string, string>;
      trace_id: string;
    };

    assert.equal(readyResponse.status, 200);
    assert.equal(readyResponse.headers.get("x-trace-id"), "trace-ready");
    assert.deepEqual(readyBody, {
      ok: true,
      service: "ipw-api",
      dependencies: {
        database: "deterministic_local",
        queue: "excluded_recovery_2a",
        object_storage: "reference_catalog_only",
      },
      trace_id: "trace-ready",
    });
  } finally {
    await app.close();
  }
});
