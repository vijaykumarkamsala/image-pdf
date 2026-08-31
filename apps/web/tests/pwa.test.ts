import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_PRODUCT_NAME, renderProductTemplate } from "../src/config/product.ts";
import { createProductManifest } from "../src/pwa/manifest.ts";
import { PRODUCTION_CONTENT_SECURITY_POLICY, PRODUCTION_SECURITY_HEADERS } from "../src/pwa/security.ts";

const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const offlineTemplate = readFileSync(new URL("../offline.template.html", import.meta.url), "utf8");
const indexTemplate = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("web manifest uses provisional configurable branding and installable icon purposes", () => {
  const manifest = createProductManifest({ productName: "Configured Product" });
  assert.equal(manifest.name, "Configured Product");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.deepEqual(manifest.icons.map((icon) => icon.purpose), ["any", "maskable"]);
});

test("service worker caches only shell assets and bypasses protected customer traffic", () => {
  assert.match(serviceWorker, /ipw-shell-2c-v2/);
  assert.match(serviceWorker, /request\.headers\.has\("authorization"\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/v1\/"\)/);
  assert.match(serviceWorker, /signature\|credential\|token\|x-goog/i);
  assert.doesNotMatch(serviceWorker, /cache\.put\([^\n]*\/v1/);
  assert.match(serviceWorker, /CLEAR_PRIVATE_CACHES/);
  assert.match(serviceWorker, /SKIP_WAITING/);
  assert.match(serviceWorker, /offline\.html/);
  assert.match(serviceWorker, /offline\.css/);
  assert.match(serviceWorker, /name\.startsWith\(PRIVATE_CACHE_PREFIX\)/);
});

test("offline fallback makes no claim that unaccepted cloud work continues", () => {
  const offlineFallback = renderProductTemplate(offlineTemplate, "Configured Product");
  assert.match(offlineFallback, /Configured Product/);
  assert.match(offlineFallback, /Work already accepted by the server remains durable/);
  assert.doesNotMatch(offlineFallback, /processing continues|upload continues/i);
  assert.doesNotMatch(offlineFallback, /<style|onclick=/i);
  assert.match(offlineFallback, /href="\/offline\.css"/);
  assert.match(offlineFallback, /href="\/"/);
});

test("production CSP permits required assets without inline or eval allowances", () => {
  assert.equal(PRODUCTION_SECURITY_HEADERS["Content-Security-Policy"], PRODUCTION_CONTENT_SECURITY_POLICY);
  assert.match(PRODUCTION_CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.match(PRODUCTION_CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(PRODUCTION_CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.doesNotMatch(PRODUCTION_CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval/);
});

test("one provisional product name configures runtime, metadata, offline and manifest output", () => {
  const configured = "Configured Product";
  assert.equal(createProductManifest().name, DEFAULT_PRODUCT_NAME);
  assert.match(renderProductTemplate(indexTemplate, configured), /<title>Configured Product<\/title>/);
  assert.match(renderProductTemplate(indexTemplate, configured), /name="application-name" content="Configured Product"/);
  assert.match(renderProductTemplate(offlineTemplate, configured), /Offline \| Configured Product/);
  assert.equal(createProductManifest({ productName: configured }).name, configured);
});
