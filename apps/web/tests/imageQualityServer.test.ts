import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createImageQualityServer } from "../server.mjs";

async function fixture() {
  const root = join(tmpdir(), `ipw-image-quality-server-${process.pid}-${Date.now()}`);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>Image Quality Editor</title>");
  await writeFile(join(root, "assets", "app-12345678.js"), "export {};\n");
  const server = createImageQualityServer({ root, logger: { error() {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("isolated runtime redirects root and serves editor deep links with security headers", async () => {
  const app = await fixture();
  try {
    const root = await fetch(app.origin, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/image-quality");

    const editor = await fetch(`${app.origin}/image-quality/editor`);
    assert.equal(editor.status, 200);
    assert.match(await editor.text(), /Image Quality Editor/);
    assert.match(editor.headers.get("content-security-policy") ?? "", /object-src 'none'/);
    assert.equal(editor.headers.get("x-content-type-options"), "nosniff");
    assert.equal(editor.headers.get("x-frame-options"), "DENY");
  } finally {
    await app.close();
  }
});

test("isolated runtime exposes health and immutable hashed assets but no unrelated routes", async () => {
  const app = await fixture();
  try {
    const health = await fetch(`${app.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");

    const asset = await fetch(`${app.origin}/assets/app-12345678.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

    assert.equal((await fetch(`${app.origin}/projects`)).status, 404);
    assert.equal((await fetch(`${app.origin}/..%2fserver.mjs`)).status, 404);
    assert.equal((await fetch(`${app.origin}/image-quality`, { method: "POST" })).status, 405);
  } finally {
    await app.close();
  }
});
