import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createProductManifest } from "../src/pwa/manifest.ts";

const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const offlineFallback = readFileSync(new URL("../public/offline.html", import.meta.url), "utf8");

test("web manifest uses provisional configurable branding and installable icon purposes", () => {
  const manifest = createProductManifest({ productName: "Configured Product" });
  assert.equal(manifest.name, "Configured Product");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.deepEqual(manifest.icons.map((icon) => icon.purpose), ["any", "maskable"]);
});

test("service worker caches only shell assets and bypasses protected customer traffic", () => {
  assert.match(serviceWorker, /ipw-shell-2c-v1/);
  assert.match(serviceWorker, /request\.headers\.has\("authorization"\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/v1\/"\)/);
  assert.match(serviceWorker, /signature\|credential\|token\|x-goog/i);
  assert.doesNotMatch(serviceWorker, /cache\.put\([^\n]*\/v1/);
  assert.match(serviceWorker, /CLEAR_PRIVATE_CACHES/);
  assert.match(serviceWorker, /SKIP_WAITING/);
  assert.match(serviceWorker, /offline\.html/);
});

test("offline fallback makes no claim that unaccepted cloud work continues", () => {
  assert.match(offlineFallback, /Work already accepted by the server remains durable/);
  assert.doesNotMatch(offlineFallback, /processing continues|upload continues/i);
});
