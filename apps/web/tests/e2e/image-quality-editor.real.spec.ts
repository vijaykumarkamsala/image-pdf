import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const fixture = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
  "data/fixtures/images/synthetic-noise-64.png",
);
const canonicalLinux = process.env["IPW_CANONICAL_LINUX"] === "1";

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}

function flatCurvePng(size: number, transparentBackground = false): Buffer {
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  const centre = size / 2;
  const outerRadius = size * 0.35;
  const innerRadius = size * 0.14;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const distance = Math.hypot(x - centre, y - centre);
      const blue = distance <= outerRadius && distance >= innerRadius;
      const backgroundNoise = (x * 17 + y * 29) % 7 - 3;
      scanlines[offset] = blue ? 16 : 244 + backgroundNoise;
      scanlines[offset + 1] = blue ? 112 : 244 + backgroundNoise;
      scanlines[offset + 2] = blue ? 228 : 244 + backgroundNoise;
      scanlines[offset + 3] = blue || !transparentBackground ? 255 : 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function warmIllustrationPng(size: number): Buffer {
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  const centre = size / 2;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const subject = Math.hypot(x - centre, y - centre) < size * 0.36;
      const backgroundNoise = (x * 11 + y * 7) % 3 - 1;
      const subjectTexture = (x * 37 + y * 53 + x * y * 3) % 81 - 40;
      scanlines[offset] = subject ? 121 + subjectTexture : 232 + backgroundNoise;
      scanlines[offset + 1] = subject ? 82 + Math.round(subjectTexture * 0.7) : 218 + backgroundNoise;
      scanlines[offset + 2] = subject ? 54 + Math.round(subjectTexture * 0.45) : 194 + backgroundNoise;
      scanlines[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function progressiveStrengthPng(width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const gradient = 58 + x / (width - 1) * 118 + y / (height - 1) * 24;
      const region = x > width * 0.52 ? 34 : 0;
      const texture = (x * 37 + y * 53 + x * y * 7) % 31 - 15;
      scanlines[offset] = byte(gradient + region + texture + 10);
      scanlines[offset + 1] = byte(gradient + region + texture * 0.72);
      scanlines[offset + 2] = byte(gradient + region + texture * 0.46 - 13);
      scanlines[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function clippingHistogramPng(width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const value = x < width / 4 ? 0 : x >= width * 3 / 4 ? 255 : 112;
      scanlines[offset] = value;
      scanlines[offset + 1] = value;
      scanlines[offset + 2] = value;
      scanlines[offset + 3] = y === height - 1 ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("histogram analyses exact current preview bytes without changing image output", async ({ page }) => {
  const source = clippingHistogramPng(64, 48);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "histogram-clipping.png",
    mimeType: "image/png",
    buffer: source,
  });
  await expect(page.getByTestId("image-quality-editor")).toBeVisible();

  const histogram = page.getByTestId("image-histogram");
  await expect(histogram).toHaveAttribute("data-preview-sha256", sourceSha256);
  await expect(histogram).toContainText("Immutable original preview");
  await expect(histogram.locator(".quality-histogram-chart")).toBeVisible();
  await expect(histogram).toContainText("3,008 visible pixels analysed · 64 fully transparent pixels excluded.");
  await expect(histogram.locator(".quality-clipping-summary > div").nth(0)).toContainText("752 (25.00%)");
  await expect(histogram.locator(".quality-clipping-summary > div").nth(1)).toContainText("752 (25.00%)");
  await expect(histogram.locator('[data-material="true"]')).toHaveCount(2);
  const accessibility = await new AxeBuilder({ page }).include(".quality-histogram-panel").analyze();
  expect(accessibility.violations).toEqual([]);
  const originalUrl = await page.getByTestId("original-image").getAttribute("src");
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeDisabled();

  await page.getByRole("button", { name: "Enhance quality", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeEnabled();
  await expect(histogram).toContainText("Enhanced preview");
  await expect(histogram).not.toHaveAttribute("data-preview-sha256", sourceSha256);
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", originalUrl!);
});

test("face detail stays opt-in and unavailable without affecting enhancement, originals or downloads", async ({ page }, testInfo) => {
  // Includes the ordinary editor and real-worker synthetic selection/export/cancel/revocation flows.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1760, height: 900 });
  const modelRequests: string[] = [];
  page.on("request", (request) => {
    if (/\.(?:onnx|pth)(?:\?|$)/i.test(request.url())) modelRequests.push(request.url());
  });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByTestId("image-quality-editor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enhance quality", exact: true })).toBeEnabled();
  const panel = page.locator(".quality-face-detail");
  await expect(panel).not.toHaveAttribute("open", "");
  const originalUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Enhance quality", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeEnabled();
  const enhancedUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  expect(enhancedUrl).not.toBe(originalUrl);
  const resultDigest = await page.evaluate(async (url) => {
    const digest = await crypto.subtle.digest("SHA-256", await (await fetch(url!)).arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }, enhancedUrl);
  await panel.locator("summary").click();
  const consent = panel.getByRole("checkbox");
  await expect(consent).not.toBeChecked();
  await consent.check();
  await expect(panel).toContainText("No face model has run and no pixels have changed.");
  await expect(panel).toContainText("Commercial execution and distribution rights have not been approved.");
  await expect(panel.getByRole("button", { name: "Generate face candidates (unavailable)" })).toBeDisabled();
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", originalUrl!);
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", enhancedUrl!);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download enhanced image" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(resultDigest);
  await panel.locator("summary").click();
  await panel.locator("summary").click();
  await expect(consent).not.toBeChecked();
  await consent.check();
  await page.getByRole("button", { name: "Reset all", exact: true }).click();
  await expect(panel).not.toHaveAttribute("open", "");
  await panel.locator("summary").click();
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", originalUrl!);
  await panel.getByRole("checkbox").check();
  await page.getByLabel("Choose replacement image").setInputFiles(fixture);
  await expect(page.getByRole("button", { name: "Enhance quality", exact: true })).toBeEnabled();
  await expect(panel).not.toHaveAttribute("open", "");
  await panel.locator("summary").click();
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  expect(modelRequests).toEqual([]);
  const accessibility = await new AxeBuilder({ page }).include(".quality-face-detail").analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("face-detail-availability.png"), fullPage: true });
  // Same focused journey, separate synthetic adapter + the real worker renderer.
  // This proves UI/pixel/export mechanics, not approval or quality of any face model.
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves this test-only module; never part of src/production.
    const harness = await import("/tests/browser/faceReviewHarness.tsx");
    await harness.mountFaceReviewHarness();
  });
  const harness = page.locator("#face-review-harness");
  await harness.locator("summary").first().click();
  const permission = harness.getByRole("checkbox").first();
  const generate = harness.getByRole("button", { name: "Generate face candidates", exact: true });
  await expect(generate).toBeDisabled(); await permission.check(); await generate.click();
  await expect(harness.getByRole("radio")).toHaveCount(3);
  const approve = harness.getByRole("button", { name: "Create reviewed face image" });
  await expect(approve).toBeDisabled();
  const radios = harness.getByRole("radio");
  await radios.nth(1).check();
  const acknowledgement = harness.getByRole("checkbox", { name: /I reviewed this candidate/ });
  await expect(approve).toBeDisabled(); await acknowledgement.check();
  await radios.nth(2).check(); await expect(acknowledgement).not.toBeChecked();
  const metricsBeforeZoom = await page.evaluate(async () => {
    // @ts-expect-error Vite-served test module.
    return (await import("/tests/browser/faceReviewHarness.tsx")).getMetrics();
  });
  await harness.getByRole("button", { name: "400% face", exact: true }).click();
  await harness.getByRole("group", { name: /^Proposed reconstructed face\./ }).press("ArrowLeft");
  const transforms = await harness.locator("img[data-face-transform]").evaluateAll((images) => images.map((image) => image.getAttribute("data-face-transform")));
  expect(new Set(transforms).size).toBe(1);
  expect(transforms[0]).toMatch(/^4:/);
  const metricsAfterZoom = await page.evaluate(async () => {
    // @ts-expect-error Vite-served test module.
    return (await import("/tests/browser/faceReviewHarness.tsx")).getMetrics();
  });
  expect(metricsAfterZoom).toEqual(metricsBeforeZoom);
  const reviewAccessibility = await new AxeBuilder({ page }).include("#face-review-harness").analyze();
  expect(reviewAccessibility.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("face-candidate-review.png"), fullPage: true });
  await acknowledgement.check(); await approve.click();
  const faceDownload = harness.getByRole("button", { name: "Download face-restored image" });
  await expect(faceDownload).toBeVisible();
  await harness.getByText("View complete reviewed face image", { exact: true }).click();
  const fullUrl = await harness.getByRole("img", { name: "Complete reviewed face-restored image" }).getAttribute("src");
  const decoded = await page.evaluate(async (url) => {
    const blob = await (await fetch(url!)).blob(); const bitmap = await createImageBitmap(blob);
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height); const context = surface.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
    const all = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let outsideChanged = 0;
    for (let y = 0; y < bitmap.height; y += 1) for (let x = 0; x < bitmap.width; x += 1) {
      if (x >= 128 && x < 384 && y >= 128 && y < 384) continue;
      const offset = (y * bitmap.width + x) * 4;
      if (all[offset] !== 80 || all[offset + 1] !== 60 || all[offset + 2] !== 45 || all[offset + 3] !== 255) outsideChanged += 1;
    }
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return { width: bitmap.width, height: bitmap.height, outside: pixel(10, 10), masked: pixel(128, 128),
      inside: pixel(130, 130), outsideChanged, sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("") };
  }, fullUrl);
  expect(decoded.width).toBe(512); expect(decoded.height).toBe(512);
  expect(decoded.outside).toEqual([80, 60, 45, 255]); expect(decoded.masked).toEqual(decoded.outside);
  expect(decoded.inside).toEqual([140, 110, 105, 255]);
  expect(decoded.outsideChanged).toBe(0);
  const nextDownload = page.waitForEvent("download"); await faceDownload.click();
  const downloaded = await nextDownload; const faceStream = await downloaded.createReadStream();
  const faceChunks: Buffer[] = []; for await (const chunk of faceStream!) faceChunks.push(Buffer.from(chunk));
  const facePng = Buffer.concat(faceChunks);
  expect(createHash("sha256").update(facePng).digest("hex")).toBe(decoded.sha256);
  expect(facePng.includes(Buffer.from('"usage":"explicit-face-recreate"'))).toBe(true);
  expect(facePng.includes(Buffer.from('"kind":"explicit-face-recreate"'))).toBe(true);
  expect(facePng.includes(Buffer.from((await radios.nth(2).inputValue())))).toBe(true);
  expect(downloaded.suggestedFilename()).toBe("rights-free-test-face-recreated.png");
  await page.evaluate(async () => {
    // @ts-expect-error Vite-served test module.
    await (await import("/tests/browser/faceReviewHarness.tsx")).replaceBase();
  });
  await expect(permission).not.toBeChecked(); await expect(faceDownload).toHaveCount(0);
  await expect(radios).toHaveCount(0);
  await permission.check();
  await page.evaluate(async () => {
    // @ts-expect-error Vite-served test module.
    (await import("/tests/browser/faceReviewHarness.tsx")).failNextPreparation();
  });
  await generate.click(); await expect(harness.getByRole("alert")).toContainText("Synthetic preparation failure");
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", await page.getByTestId("enhanced-image").getAttribute("src") ?? "");
  await page.evaluate(async () => {
    // @ts-expect-error Vite-served test module.
    (await import("/tests/browser/faceReviewHarness.tsx")).setSlowGeneration();
  });
  await generate.click(); await harness.getByRole("button", { name: "Cancel face restoration" }).click();
  await expect(permission).not.toBeChecked(); await expect(radios).toHaveCount(0);
  await permission.check(); await generate.click(); await expect(radios).toHaveCount(3);
  await harness.locator("summary").first().click(); await harness.locator("summary").first().click();
  await expect(permission).not.toBeChecked(); await expect(radios).toHaveCount(0);
  await page.evaluate(async () => {
    // @ts-expect-error Vite-served test module.
    (await import("/tests/browser/faceReviewHarness.tsx")).revokeRelease();
  });
  await expect(permission).not.toBeChecked();
  await permission.check();
  await expect(harness.getByRole("button", { name: "Generate face candidates (unavailable)" })).toBeDisabled();
  const repository = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
  const privatePortrait = resolve(repository, "data/corpus/TestImagesUploadedBYVIjay/IMG_5100.png");
  const detectorArtifact = resolve(repository, ".tools/models/face_detection_yunet_2023mar.onnx");
  // Optional owner-authorized local evidence, never a required customer-content CI fixture.
  if (!existsSync(privatePortrait) || !existsSync(detectorArtifact)) {
    testInfo.annotations.push({ type: "private-evidence-not-run", description: "The optional private portrait/verified detector is unavailable. No real-face quality acceptance is claimed." });
    return;
  }
  const sourceBytes = await readFile(privatePortrait), detectorBytes = await readFile(detectorArtifact);
  expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe("4cd8c0eed7948ca9a390aed8f55842d95b33cab14a4618abdf5f07dcdd8f8ed0");
  expect(createHash("sha256").update(detectorBytes).digest("hex")).toBe("8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4");
  await page.evaluate(async ({ source, detector }) => {
    // @ts-expect-error Optional private-local test module; never registered by the application.
    await (await import("/tests/browser/automaticFaceHarness.tsx")).mountAutomaticFaceHarness(source, detector);
  }, { source: sourceBytes.toString("base64"), detector: detectorBytes.toString("base64") });
  const automatic = page.locator("#automatic-face-review-harness");
  await automatic.locator("summary").first().click();
  await automatic.getByRole("checkbox").first().check();
  await automatic.getByRole("button", { name: "Generate face candidates", exact: true }).click();
  await expect(automatic.getByRole("radio")).toHaveCount(3, { timeout: 60_000 });
  await automatic.getByRole("radio").nth(2).check();
  await automatic.getByRole("checkbox", { name: /I reviewed this candidate/ }).check();
  await automatic.getByRole("button", { name: "Create reviewed face image" }).click();
  await expect(automatic.getByRole("button", { name: "Download face-restored image" })).toBeVisible();
  const automaticEvidence = await page.evaluate(async () => {
    // @ts-expect-error Optional private-local test module.
    return (await import("/tests/browser/automaticFaceHarness.tsx")).automaticFaceEvidence();
  });
  expect(automaticEvidence.proposals).toHaveLength(3);
  expect(new Set(automaticEvidence.proposals.map((proposal: { fidelity: number }) => proposal.fidelity)).size).toBe(3);
  expect(automaticEvidence.proposals[0].alignment.detectorSha256).toBe("8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4");
  expect(automaticEvidence.proposals[0].alignment.sourceLandmarks).toHaveLength(5);
  expect(automaticEvidence.outputEvidence.changedPixels).toBeGreaterThan(0);
  expect(automaticEvidence.outputEvidence.alignment).toEqual(automaticEvidence.proposals[2].alignment);
  const beforeAutomaticZoom = automaticEvidence.metrics;
  await automatic.getByRole("button", { name: "400% face" }).click();
  const afterAutomaticZoom = await page.evaluate(async () => {
    // @ts-expect-error Optional private-local test module.
    return (await import("/tests/browser/automaticFaceHarness.tsx")).automaticFaceEvidence().metrics;
  });
  expect(afterAutomaticZoom).toEqual(beforeAutomaticZoom);
  const automaticFailures = await page.evaluate(async () => {
    // @ts-expect-error Optional private-local test module.
    return (await import("/tests/browser/automaticFaceHarness.tsx")).probeAutomaticFailures();
  });
  expect(automaticFailures[0]).toContain("No sufficiently confident face");
  expect(automaticFailures[1]).toContain("More than one possible face");
  expect(automaticFailures[2]).toContain("cancelled");
  const evidencePath = testInfo.outputPath("automatic-detector-private-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ ...automaticEvidence, automaticFailures,
    productionApproved: false, restorationQualityAccepted: false, restorer: "owned synthetic ONNX pixel bias, not a face restoration model" }, null, 2));
  await testInfo.attach("automatic-detector-private-evidence.json", { path: evidencePath, contentType: "application/json" });
  expect(createHash("sha256").update(await readFile(privatePortrait)).digest("hex")).toBe(createHash("sha256").update(sourceBytes).digest("hex"));
});

test("image quality editor uploads, processes, compares, resets and downloads real pixels", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const researchModelRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/quality-models\/.*\.onnx(?:\?|$)/i.test(request.url())) researchModelRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    Object.defineProperty(window, "__qualityWorkerCount", { value: 0, writable: true });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as typeof window & { __qualityWorkerCount: number }).__qualityWorkerCount += 1;
      }
    };
  });
  await page.goto(canonicalLinux ? "/image-quality?engine=deterministic" : "/image-quality");
  await page.locator('input[type="file"]').setInputFiles(fixture);

  await expect(page).toHaveURL(/\/image-quality\/editor$/);
  await expect(page.getByTestId("image-quality-editor")).toBeVisible();
  await expect(page.getByRole("heading", { name: "synthetic-noise-64.png" })).toBeVisible();
  await expect(page.locator(".quality-inspector .quality-dimensions dd").first()).toHaveText("64 × 64 px");
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __qualityWorkerCount: number }).__qualityWorkerCount)).toBe(1);

  const original = page.getByTestId("original-image");
  const originalUrl = await original.getAttribute("src");
  expect(originalUrl).toMatch(/^blob:/);
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/(?:AI-restored|Enhanced) image ready/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(canonicalLinux
    ? /(?:Deterministic adaptive|Production-safe deterministic) restoration · Worker/
    : /Identity-constrained Real-ESRGAN x4v3 DNI 0\.5 · WebGPU/)).toBeVisible();
  if (canonicalLinux) expect(researchModelRequests).toEqual([]);

  const enhanced = page.getByTestId("enhanced-image");
  const enhancedUrl = await enhanced.getAttribute("src");
  expect(enhancedUrl).toMatch(/^blob:/);
  expect(enhancedUrl).not.toBe(originalUrl);
  await expect(enhanced).toHaveCSS("filter", "none");

  await page.locator('input[type="range"]').fill("80");
  await expect(page.getByText(/displayed result is still the verified 65% at 2×/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeDisabled();
  await page.locator('input[type="range"]').fill("65");
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeEnabled();

  const pixelEvidence = await page.evaluate(async ({ originalSrc, enhancedSrc }) => {
    const pixels = async (src: string) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        values: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
      };
    };
    const [before, after] = await Promise.all([pixels(originalSrc!), pixels(enhancedSrc!)]);
    let totalDifference = 0;
    let materiallyChanged = 0;
    for (let y = 0; y < before.height; y += 1) {
      for (let x = 0; x < before.width; x += 1) {
        const beforeOffset = (y * before.width + x) * 4;
        const outputX = Math.min(after.width - 1, Math.round(x * after.width / before.width));
        const outputY = Math.min(after.height - 1, Math.round(y * after.height / before.height));
        const afterOffset = (outputY * after.width + outputX) * 4;
        const difference = (
          Math.abs(after.values[afterOffset] - before.values[beforeOffset])
          + Math.abs(after.values[afterOffset + 1] - before.values[beforeOffset + 1])
          + Math.abs(after.values[afterOffset + 2] - before.values[beforeOffset + 2])
        ) / 3;
        totalDifference += difference;
        if (difference >= 2) materiallyChanged += 1;
      }
    }
    const pixelCount = before.values.length / 4;
    return {
      width: after.width,
      height: after.height,
      changed: materiallyChanged > 0,
      meanRgbDifference: totalDifference / pixelCount,
      materiallyChangedFraction: materiallyChanged / pixelCount,
    };
  }, { originalSrc: originalUrl, enhancedSrc: enhancedUrl });
  expect(pixelEvidence.width).toBeGreaterThanOrEqual(64);
  expect(pixelEvidence.height).toBeGreaterThanOrEqual(64);
  expect(pixelEvidence.changed).toBe(true);
  // The production-safe fallback is intentionally conservative in flat and
  // low-texture regions; this gate proves a visible decoded-pixel correction
  // without requiring the larger drift of the optional research model.
  expect(pixelEvidence.meanRgbDifference).toBeGreaterThan(0.5);
  expect(pixelEvidence.materiallyChangedFraction).toBeGreaterThan(0.25);

  const resultUrlBeforeZoom = enhancedUrl;
  await page.getByRole("button", { name: "200%" }).click();
  await expect(page.getByTestId("comparison-original")).toHaveAttribute("data-scale", "2.000000");
  await expect(page.getByTestId("comparison-enhanced")).toHaveAttribute("data-scale", "2.000000");
  expect(await enhanced.getAttribute("src")).toBe(resultUrlBeforeZoom);
  await page.getByTestId("comparison-original").hover();
  await page.mouse.down();
  await page.mouse.move(80, 80);
  await page.mouse.up();
  expect(await original.evaluate((node) => node.style.transform)).toBe(await enhanced.evaluate((node) => node.style.transform));

  await page.getByRole("button", { name: "Slider" }).click();
  const sliderOriginal = page.getByTestId("slider-original-image");
  const sliderEnhanced = page.getByTestId("slider-enhanced-image");
  expect(await sliderOriginal.evaluate((node) => node.style.transform)).toBe(await sliderEnhanced.evaluate((node) => node.style.transform));
  await page.getByLabel("Comparison position").fill("35");

  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Side by side" }).click();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", originalUrl!);
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();

  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/(?:AI-restored|Enhanced) image ready/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("enhanced-image")).not.toHaveAttribute("src", originalUrl!);
  await page.screenshot({ path: testInfo.outputPath("image-quality-editor.png"), fullPage: true });
  await page.getByText("Result details and provenance").click();
  const expectedDigest = await page.locator(".quality-provenance div", {
    hasText: "Output SHA-256",
  }).locator("code").textContent();
  expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download enhanced image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("synthetic-noise-64-enhanced-2x.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(expectedDigest);
  const pngMetadata = { types: [] as string[], provenance: "" };
  for (let offset = 8; offset + 12 <= downloaded.length;) {
    const length = downloaded.readUInt32BE(offset);
    const type = downloaded.toString("ascii", offset + 4, offset + 8);
    pngMetadata.types.push(type);
    if (type === "iTXt") {
      pngMetadata.provenance = downloaded.toString("utf8", offset + 8, offset + 8 + length);
    }
    offset += length + 12;
    if (type === "IEND") break;
  }
  expect(pngMetadata.types).toContain("sRGB");
  expect(pngMetadata.types).toContain("gAMA");
  expect(pngMetadata.types).toContain("iTXt");
  expect(pngMetadata.provenance).toContain("ipw.image-quality.provenance.v1");
  await page.screenshot({ path: testInfo.outputPath("image-quality-editor.png"), fullPage: true });
  await page.close();
});

test("enhancement strength produces neutral, balanced and strong pixels from the immutable original", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-strength.png",
    mimeType: "image/png",
    buffer: progressiveStrengthPng(320, 256),
  });
  await expect(page.getByTestId("image-quality-editor")).toBeVisible();

  const slider = page.locator('.quality-strength input[type="range"]');
  const capture = async (strength: 0 | 50 | 100, key: string) => {
    await slider.fill(String(strength));
    await expect(page.locator(".quality-strength output")).toContainText(`${strength}%`);
    if (strength === 0) await expect(page.locator(".quality-strength output")).toContainText("Neutral");
    await page.getByRole("button", { name: "Enhance quality", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeEnabled({ timeout: 120_000 });
    await expect(page.locator(".quality-provenance")).toContainText(`Applied strength${strength}%`);
    return page.evaluate(async ({ selectedStrength, storageKey }) => {
      const image = document.querySelector<HTMLImageElement>('[data-testid="enhanced-image"]');
      if (!image?.src) throw new Error("Enhanced preview is missing.");
      await image.decode();
      const bytes = await (await fetch(image.src)).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Pixel evidence canvas is unavailable.");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const scope = window as typeof window & { __strengthPixels?: Record<string, Uint8ClampedArray> };
      scope.__strengthPixels ??= {};
      scope.__strengthPixels[storageKey] = new Uint8ClampedArray(pixels);
      return {
        digest: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""),
        height: canvas.height,
        strength: selectedStrength,
        width: canvas.width,
      };
    }, { selectedStrength: strength, storageKey: key });
  };

  const neutral = await capture(0, "neutral");
  const balanced = await capture(50, "balanced");
  const strong = await capture(100, "strong");
  const repeatedBalanced = await capture(50, "balanced-repeat");

  for (const result of [neutral, balanced, strong, repeatedBalanced]) {
    expect(result.width).toBe(640);
    expect(result.height).toBe(512);
  }
  expect(repeatedBalanced.digest).toBe(balanced.digest);

  const separation = await page.evaluate(() => {
    const values = (window as typeof window & { __strengthPixels: Record<string, Uint8ClampedArray> }).__strengthPixels;
    const compare = (first: Uint8ClampedArray, second: Uint8ClampedArray) => {
      let total = 0;
      let changed = 0;
      const pixels = first.length / 4;
      for (let offset = 0; offset < first.length; offset += 4) {
        const difference = (
          Math.abs(first[offset] - second[offset])
          + Math.abs(first[offset + 1] - second[offset + 1])
          + Math.abs(first[offset + 2] - second[offset + 2])
        ) / 3;
        total += difference;
        if (difference >= 1) changed += 1;
      }
      return { changedFraction: changed / pixels, meanRgbDifference: total / pixels };
    };
    return {
      balancedFromNeutral: compare(values.neutral, values.balanced),
      strongFromBalanced: compare(values.balanced, values.strong),
      strongFromNeutral: compare(values.neutral, values.strong),
    };
  });
  expect(separation.balancedFromNeutral.meanRgbDifference).toBeGreaterThan(0.05);
  expect(separation.strongFromNeutral.meanRgbDifference).toBeGreaterThan(
    separation.balancedFromNeutral.meanRgbDifference * 1.5,
  );
  expect(separation.strongFromBalanced.changedFraction).toBeGreaterThan(0.1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download enhanced image" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(repeatedBalanced.digest);
  await page.close();
});

test("photo restoration preserves a warm low-texture background", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/image-quality");
  await page.locator('input[type="file"]').setInputFiles({
    name: "warm-illustration.png",
    mimeType: "image/png",
    buffer: warmIllustrationPng(64),
  });
  await page.getByRole("button", { name: "4×", exact: true }).click();
  await page.locator('input[type="range"]').fill("100");
  const originalUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \(Fidelity-constrained Real-ESRGAN x4v3 · WebGPU\)/)).toBeVisible({ timeout: 120_000 });
  const enhancedUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  const evidence = await page.evaluate(async ({ originalSrc, enhancedSrc }) => {
    const decode = async (src: string) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width };
    };
    const [before, after] = await Promise.all([decode(originalSrc!), decode(enhancedSrc!)]);
    const backgroundBefore = [0, 0, 0];
    const backgroundAfter = [0, 0, 0];
    let backgroundSamples = 0;
    let subjectDifference = 0;
    let subjectSamples = 0;
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const beforeOffset = (y * before.width + x) * 4;
        const afterOffset = ((y * 4 + 2) * after.width + x * 4 + 2) * 4;
        if (x < 12 && y < 12) {
          for (let channel = 0; channel < 3; channel += 1) {
            backgroundBefore[channel] += before.data[beforeOffset + channel];
            backgroundAfter[channel] += after.data[afterOffset + channel];
          }
          backgroundSamples += 1;
        }
        if (Math.hypot(x - 32, y - 32) < 18) {
          subjectDifference += (
            Math.abs(before.data[beforeOffset] - after.data[afterOffset])
            + Math.abs(before.data[beforeOffset + 1] - after.data[afterOffset + 1])
            + Math.abs(before.data[beforeOffset + 2] - after.data[afterOffset + 2])
          ) / 3;
          subjectSamples += 1;
        }
      }
    }
    return {
      backgroundChannelShift: backgroundBefore.map((sum, channel) => (
        Math.abs(sum - backgroundAfter[channel]) / backgroundSamples
      )),
      subjectMeanDifference: subjectDifference / subjectSamples,
    };
  }, { originalSrc: originalUrl, enhancedSrc: enhancedUrl });
  expect(Math.max(...evidence.backgroundChannelShift)).toBeLessThanOrEqual(2);
  expect(evidence.subjectMeanDifference).toBeGreaterThan(2);
  await page.goto("about:blank");
});

test("changing the image replaces a processor created under an earlier route", async ({ page }) => {
  await page.goto("/image-quality?engine=deterministic");
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "first-source.png",
    mimeType: "image/png",
    buffer: warmIllustrationPng(64),
  });
  await expect(page).toHaveURL(/\/image-quality\/editor$/);
  await expect(page.locator(".quality-inspector .quality-dimensions dd").first()).toHaveText("64 × 64 px");

  await input.setInputFiles({
    name: "replacement-source.png",
    mimeType: "image/png",
    buffer: warmIllustrationPng(64),
  });
  await page.locator('input[type="range"]').fill("100");
  await page.getByRole("button", { name: "Enhance quality" }).click();

  await expect(page.getByText(/Enhanced image ready \(Fidelity-constrained Real-ESRGAN x4v3 .* WebGPU\)/))
    .toBeVisible({ timeout: 120_000 });
});

test("flat graphics reconstruct curves without tracing background noise", async ({ page }, testInfo) => {
  const flatGraphic = flatCurvePng(64);
  await page.goto("/image-quality");
  await page.locator('input[type="file"]').setInputFiles({
    name: "flat-curves.png",
    mimeType: "image/png",
    buffer: flatGraphic,
  });
  await expect(page).toHaveURL(/\/image-quality\/editor$/);
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  await page.getByRole("button", { name: "4×", exact: true }).click();
  await page.locator('input[type="range"]').fill("100");
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \(Source-colour smooth-spline reconstruction · Worker\)/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("256 × 256 px")).toBeVisible();
  await page.getByRole("button", { name: "400%" }).click();
  await page.screenshot({ path: testInfo.outputPath("flat-vector-comparison.png"), fullPage: true });
  const evidence = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minimum = 255;
    let maximum = 0;
    let transparent = 0;
    let visible = 0;
    let falseBackgroundMarks = 0;
    let unexpectedEdgeColours = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 250) {
        transparent += 1;
        continue;
      }
      minimum = Math.min(minimum, pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      maximum = Math.max(maximum, pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      visible += 1;
      const pixel = offset / 4;
      const x = pixel % canvas.width;
      const y = Math.floor(pixel / canvas.width);
      if (Math.hypot(x - canvas.width / 2, y - canvas.height / 2) > canvas.width * 0.39
        && Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 225) {
        falseBackgroundMarks += 1;
      }
      const blueFraction = Math.max(0, Math.min(1, (244 - pixels[offset]) / (244 - 16)));
      const expectedGreen = 244 + (112 - 244) * blueFraction;
      const expectedBlue = 244 + (228 - 244) * blueFraction;
      if (Math.abs(pixels[offset + 1] - expectedGreen) > 7
        || Math.abs(pixels[offset + 2] - expectedBlue) > 7) {
        unexpectedEdgeColours += 1;
      }
    }
    const boundaryRadii: number[] = [];
    const centre = canvas.width / 2;
    for (let degrees = 0; degrees < 360; degrees += 5) {
      const radians = degrees * Math.PI / 180;
      for (let radius = canvas.width * 0.44; radius >= canvas.width * 0.25; radius -= 0.25) {
        const x = Math.max(0, Math.min(canvas.width - 1, Math.round(centre + Math.cos(radians) * radius)));
        const y = Math.max(0, Math.min(canvas.height - 1, Math.round(centre + Math.sin(radians) * radius)));
        const offset = (y * canvas.width + x) * 4;
        if (pixels[offset + 2] - pixels[offset] > 80 && pixels[offset] < 100) {
          boundaryRadii.push(radius);
          break;
        }
      }
    }
    return {
      maximum,
      minimum,
      falseBackgroundMarks,
      outerRadiusSpread: Math.max(...boundaryRadii) - Math.min(...boundaryRadii),
      sampledBoundaries: boundaryRadii.length,
      unexpectedEdgeColours,
      transparentFraction: transparent / (transparent + visible),
      width: canvas.width,
      height: canvas.height,
    };
  });
  expect(evidence.width).toBe(256);
  expect(evidence.height).toBe(256);
  expect(evidence.minimum).toBeGreaterThanOrEqual(12);
  expect(evidence.maximum).toBeLessThanOrEqual(252);
  expect(evidence.falseBackgroundMarks).toBe(0);
  expect(evidence.sampledBoundaries).toBe(72);
  expect(evidence.outerRadiusSpread).toBeLessThanOrEqual(2.5);
  expect(evidence.unexpectedEdgeColours).toBe(0);
  expect(evidence.transparentFraction).toBeLessThan(0.02);
  await expect(page.getByTestId("enhanced-image")).toHaveCSS("filter", "none");
  await page.goto("about:blank");
});

test("2048px flat artwork is curve-fitted into an 8192px PNG", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/image-quality");
  await page.locator('input[type="file"]').setInputFiles({
    name: "large-flat-curves.png",
    mimeType: "image/png",
    buffer: flatCurvePng(2_048),
  });
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  await page.getByRole("button", { name: "4×", exact: true }).click();
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \(Source-colour smooth-spline reconstruction · Worker\)/)).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText("8192 × 8192 px")).toBeVisible();
  const header = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const bytes = new Uint8Array(await (await fetch((node as HTMLImageElement).src)).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      height: view.getUint32(20),
      signature: Array.from(bytes.slice(0, 8)),
      width: view.getUint32(16),
    };
  });
  expect(header.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(header.width).toBe(8_192);
  expect(header.height).toBe(8_192);
  await page.goto("about:blank");
});

test("explicit output scale produces exact 2× and 4× dimensions and names the downloaded scale", async ({ page }) => {
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "dimension-contract.png",
    mimeType: "image/png",
    buffer: flatCurvePng(64),
  });
  const scaleGroup = page.getByRole("group", { name: "Output scale" });
  const two = scaleGroup.getByRole("button", { name: "2×", exact: true });
  const four = scaleGroup.getByRole("button", { name: "4×", exact: true });
  await expect(two).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("128 × 128 px selected", { exact: true })).toBeVisible();

  await four.click();
  await expect(four).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("256 × 256 px selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enhance quality", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeEnabled();
  expect(await page.getByTestId("enhanced-image").evaluate(async (node) => {
    await (node as HTMLImageElement).decode();
    return [(node as HTMLImageElement).naturalWidth, (node as HTMLImageElement).naturalHeight];
  })).toEqual([256, 256]);
  let downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download enhanced image" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("dimension-contract-enhanced-4x.png");

  await two.click();
  await expect(page.getByText(/Enhancement settings changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeDisabled();
  await page.getByRole("button", { name: "Enhance quality", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeEnabled();
  expect(await page.getByTestId("enhanced-image").evaluate(async (node) => {
    await (node as HTMLImageElement).decode();
    return [(node as HTMLImageElement).naturalWidth, (node as HTMLImageElement).naturalHeight];
  })).toEqual([128, 128]);
  downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download enhanced image" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("dimension-contract-enhanced-2x.png");
});

test("659 by 710 source downloads exact 2636 by 2840 PNG bytes at 4×", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "dimension-regression-659x710.png",
    mimeType: "image/png",
    buffer: progressiveStrengthPng(659, 710),
  });
  await expect(page.locator(".quality-inspector .quality-dimensions dd").first()).toHaveText("659 × 710 px");
  await page.getByRole("group", { name: "Output scale" })
    .getByRole("button", { name: "4×", exact: true })
    .click();
  await expect(page.getByText("2636 × 2840 px selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enhance quality", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeEnabled({ timeout: 150_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download enhanced image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("dimension-regression-659x710-enhanced-4x.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const png = Buffer.concat(chunks);
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(2_636);
  expect(png.readUInt32BE(20)).toBe(2_840);
});

test("crop perspective rotate flip resize and download use one source-bound recipe and identical verified PNG bytes", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sourceBytes = progressiveStrengthPng(96, 80);
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "geometry-workspace.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();

  await page.getByRole("button", { name: "Crop", exact: true }).click();
  await expect(page.getByTestId("crop-selection-editor")).toBeVisible();
  await page.getByLabel("Left").fill("8");
  await page.getByLabel("Top").fill("10");
  await page.getByLabel("Width", { exact: true }).fill("64");
  await page.getByLabel("Height", { exact: true }).fill("48");
  await page.getByLabel("Enable four-corner correction").check();
  const topLeftPerspective = page.getByRole("button", { name: "Perspective top left point" });
  await topLeftPerspective.press("Shift+ArrowRight");
  await topLeftPerspective.press("Shift+ArrowDown");
  await page.getByRole("button", { name: "90° right" }).click();
  await page.getByRole("button", { name: "Horizontal", exact: true }).click();
  await page.getByRole("button", { name: "Vertical", exact: true }).click();
  await page.locator(".quality-straighten input").fill("5");
  await page.getByLabel("Use exact pixel dimensions").check();
  await page.getByLabel("Output width").fill("120");
  await expect(page.getByLabel("Output height")).toHaveValue("160");
  await page.screenshot({ path: testInfo.outputPath("crop-rotate-workspace.png"), fullPage: true });
  const accessibility = await new AxeBuilder({ page }).include(".quality-workspace").analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("button", { name: "Apply geometry" }).click();
  await expect(page.getByText(/Geometry derivative ready from the immutable original/)).toBeVisible();
  await expect(page.locator(".quality-inspector .quality-dimensions dd").filter({ hasText: "120 × 160 px" })).toBeVisible();

  const preview = page.getByTestId("enhanced-image");
  await expect(preview).toBeVisible();
  const previewEvidence = await preview.evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const bytes = await (await fetch(image.src)).arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const cornerOffsets = [
      3,
      (canvas.width - 1) * 4 + 3,
      ((canvas.height - 1) * canvas.width) * 4 + 3,
      (canvas.width * canvas.height - 1) * 4 + 3,
    ];
    return { width: image.naturalWidth, height: image.naturalHeight, digest,
      minimumCornerAlpha: Math.min(...cornerOffsets.map((offset) => pixels[offset])) };
  });
  expect(previewEvidence).toMatchObject({ width: 120, height: 160 });
  expect(previewEvidence.minimumCornerAlpha).toBe(255);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download edited image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("geometry-workspace-edited-120x160.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(120);
  expect(downloaded.readUInt32BE(20)).toBe(160);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.geometry.provenance.v1");
  expect(downloaded.toString("utf8")).toContain('"perspective":{"topLeft":{"x":0.05,"y":0.05}');
  expect(downloaded.toString("utf8")).toContain('"flip_horizontal":true');
  expect(downloaded.toString("utf8")).toContain('"flip_vertical":true');
  expect(downloaded.toString("utf8")).toContain('"resize":{"width":120,"height":160}');
  expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(sourceDigest);

  await page.getByRole("button", { name: "Edit corner points" }).click();
  await expect(page.getByRole("button", { name: "Perspective top left point" })).toBeVisible();
  await page.getByLabel("Output width").fill("20000");
  await page.getByRole("button", { name: "Apply geometry" }).click();
  await expect(page.getByText(/beyond this browser's 16384px canvas edge/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download edited image" })).toBeDisabled();
});

test("light and tone applies from the verified base and preview matches downloaded PNG bytes", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(64, 48);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "tone-workspace.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");

  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Light and tone controls" })).toBeVisible();
  await page.getByLabel("Black point", { exact: true }).fill("12");
  await page.getByLabel("Levels midtone", { exact: true }).fill("1.2");
  await page.getByLabel("White point", { exact: true }).fill("238");
  await page.getByLabel("Curve black", { exact: true }).fill("5");
  await page.getByLabel("Curve shadows", { exact: true }).fill("18");
  await page.getByLabel("Curve highlights", { exact: true }).fill("82");
  await page.getByLabel("Curve white", { exact: true }).fill("95");
  await page.getByLabel("Shadow recovery", { exact: true }).fill("65");
  await page.getByLabel("Highlight recovery", { exact: true }).fill("45");
  await page.getByLabel("Exposure", { exact: true }).fill("0.5");
  await page.getByLabel("Shadows", { exact: true }).fill("30");
  await page.getByLabel("Highlights", { exact: true }).fill("-20");
  await expect(page.getByRole("button", { name: "Apply adjustments" })).toBeEnabled();
  const accessibility = await new AxeBuilder({ page })
    .include(".quality-tone-curve")
    .include(".quality-protected-recovery")
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Apply adjustments" }).click();
  await expect(page.getByText(/Light-and-tone derivative ready/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download adjusted image" })).toBeEnabled();
  const toneProperty = page.locator(".quality-inspector .quality-dimensions div").filter({ hasText: "Light & tone" }).locator("dd");
  await expect(toneProperty).toHaveText("Applied");
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);

  const previewEvidence = await page.getByTestId("enhanced-image").evaluate(async (node, sourceUrl) => {
    const decode = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    };
    const resultUrl = (node as HTMLImageElement).src;
    const [source, result, bytes] = await Promise.all([
      decode(sourceUrl),
      decode(resultUrl),
      (await fetch(resultUrl)).arrayBuffer(),
    ]);
    let changedChannels = 0;
    for (let index = 0; index < source.pixels.length; index += 4) {
      if (source.pixels[index] !== result.pixels[index]
        || source.pixels[index + 1] !== result.pixels[index + 1]
        || source.pixels[index + 2] !== result.pixels[index + 2]) changedChannels += 1;
      if (source.pixels[index + 3] !== result.pixels[index + 3]) throw new Error("Tone changed alpha");
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { width: result.width, height: result.height, changedChannels, digest };
  }, immutableSourceUrl!);
  expect(previewEvidence).toMatchObject({ width: 64, height: 48 });
  expect(previewEvidence.changedChannels).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("tone-workspace-adjusted-64x48.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(64);
  expect(downloaded.readUInt32BE(20)).toBe(48);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.tone.provenance.v4");
  expect(downloaded.toString("utf8")).toContain('"base_kind":"original"');
  expect(downloaded.toString("utf8")).toContain(createHash("sha256").update(sourceBytes).digest("hex"));
  expect(downloaded.toString("utf8")).toContain('"exposure":0.5');
  expect(downloaded.toString("utf8")).toContain('"levelBlack":12');
  expect(downloaded.toString("utf8")).toContain('"levelWhite":238');
  expect(downloaded.toString("utf8")).toContain('"levelMidtone":1.2');
  expect(downloaded.toString("utf8")).toContain('"curveBlack":5');
  expect(downloaded.toString("utf8")).toContain('"curveShadows":18');
  expect(downloaded.toString("utf8")).toContain('"curveMidtones":50');
  expect(downloaded.toString("utf8")).toContain('"curveHighlights":82');
  expect(downloaded.toString("utf8")).toContain('"curveWhite":95');
  expect(downloaded.toString("utf8")).toContain('"shadowRecovery":65');
  expect(downloaded.toString("utf8")).toContain('"highlightRecovery":45');
  expect(downloaded.toString("utf8")).toContain('"shadows":30');
  expect(downloaded.toString("utf8")).toContain('"highlights":-20');

  await expect(page.getByRole("button", { name: "Reset curve" })).toBeEnabled();
  await page.getByRole("button", { name: "Reset curve" }).click();
  await expect(page.getByLabel("Curve shadows", { exact: true })).toHaveValue("25");
  await expect(page.getByLabel("Curve highlights", { exact: true })).toHaveValue("75");
  await page.getByLabel("Brightness", { exact: true }).fill("25");
  await expect(page.getByRole("button", { name: "Download adjusted image" })).toBeDisabled();
  await expect(toneProperty).toHaveText("Unapplied changes");
  await page.getByRole("button", { name: "Reset adjustments" }).click();
  await expect(page.getByRole("button", { name: "Download adjusted image" })).toBeDisabled();
  await expect(toneProperty).toHaveText("None");
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(immutableSourceUrl);
});

test("colour applies after tone and binds preview and download to the exact verified base", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "colour-chain.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");

  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByLabel("Exposure", { exact: true }).fill("0.3");
  await page.getByRole("button", { name: "Apply adjustments" }).click();
  await expect(page.getByText(/Light-and-tone derivative ready/)).toBeVisible();
  const toneEvidence = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const bytes = await (await fetch(image.src)).arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { url: image.src, digest };
  });

  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Colour controls" })).toBeVisible();
  await page.getByLabel("Temperature", { exact: true }).fill("35");
  await page.getByLabel("Tint", { exact: true }).fill("-15");
  await page.getByLabel("Saturation", { exact: true }).fill("20");
  await page.getByLabel("Vibrance", { exact: true }).fill("30");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeEnabled();
  const accessibility = await new AxeBuilder({ page }).include(".quality-workspace").analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeEnabled();
  const colorProperty = page.locator(".quality-inspector .quality-dimensions div").filter({ hasText: "Colour" }).locator("dd");
  await expect(colorProperty).toHaveText("Applied");
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);

  const previewEvidence = await page.getByTestId("enhanced-image").evaluate(async (node, baseUrl) => {
    const decode = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return { width: image.naturalWidth, height: image.naturalHeight,
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const resultUrl = (node as HTMLImageElement).src;
    const [base, result, bytes] = await Promise.all([
      decode(baseUrl),
      decode(resultUrl),
      (await fetch(resultUrl)).arrayBuffer(),
    ]);
    let changedPixels = 0;
    for (let index = 0; index < base.pixels.length; index += 4) {
      if (base.pixels[index] !== result.pixels[index]
        || base.pixels[index + 1] !== result.pixels[index + 1]
        || base.pixels[index + 2] !== result.pixels[index + 2]) changedPixels += 1;
      if (base.pixels[index + 3] !== result.pixels[index + 3]) throw new Error("Colour changed alpha");
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { width: result.width, height: result.height, changedPixels, digest };
  }, toneEvidence.url);
  expect(previewEvidence).toMatchObject({ width: 48, height: 40 });
  expect(previewEvidence.changedPixels).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("colour-chain-colour-adjusted-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  if (!stream.closed) {
    const closed = new Promise<void>((resolve, reject) => {
      stream.once("close", resolve);
      stream.once("error", reject);
    });
    stream.destroy();
    await closed;
  }
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v1");
  expect(downloaded.toString("utf8")).toContain('"base_kind":"tone"');
  expect(downloaded.toString("utf8")).toContain(toneEvidence.digest);
  expect(downloaded.toString("utf8")).toContain('"temperature":35');
  expect(downloaded.toString("utf8")).toContain('"tint":-15');
  expect(downloaded.toString("utf8")).toContain('"saturation":20');
  expect(downloaded.toString("utf8")).toContain('"vibrance":30');

  await page.getByLabel("Saturation", { exact: true }).fill("25");
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
  await expect(colorProperty).toHaveText("Unapplied changes");
  await page.getByRole("button", { name: "Reset colour" }).click();
  await expect(colorProperty).toHaveText("None");
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(toneEvidence.url);
});

test("perspective worker samples the moved source corner instead of only recording metadata", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(64, 64);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "perspective-sampling.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Crop", exact: true }).click();
  await page.getByLabel("Enable four-corner correction").check();
  const topLeft = page.getByRole("button", { name: "Perspective top left point" });
  await topLeft.press("Shift+ArrowRight");
  await topLeft.press("Shift+ArrowDown");
  await page.getByRole("button", { name: "Apply geometry" }).click();
  await expect(page.getByText(/Geometry derivative ready from the immutable original/)).toBeVisible();

  const evidence = await page.getByTestId("enhanced-image").evaluate(async (node, sourceUrl) => {
    const decode = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return { width: canvas.width, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [source, result] = await Promise.all([decode(sourceUrl), decode((node as HTMLImageElement).src)]);
    const mapped = 0.05 * (source.width - 1);
    const x0 = Math.floor(mapped);
    const x1 = Math.min(source.width - 1, x0 + 1);
    const fraction = mapped - x0;
    const weights = [(1 - fraction) ** 2, fraction * (1 - fraction), (1 - fraction) * fraction, fraction ** 2];
    const offsets = [
      (x0 * source.width + x0) * 4,
      (x0 * source.width + x1) * 4,
      (x1 * source.width + x0) * 4,
      (x1 * source.width + x1) * 4,
    ];
    const expected = [0, 1, 2].map((channel) => Math.round(offsets.reduce(
      (total, offset, index) => total + source.pixels[offset + channel] * weights[index],
      0,
    )));
    return {
      actual: Array.from(result.pixels.subarray(0, 3)),
      expected,
      immutableCorner: Array.from(source.pixels.subarray(0, 3)),
      width: (node as HTMLImageElement).naturalWidth,
      height: (node as HTMLImageElement).naturalHeight,
    };
  }, immutableSourceUrl!);
  expect(evidence).toMatchObject({ width: 64, height: 64 });
  expect(Math.max(...evidence.actual.map((value, index) => Math.abs(value - evidence.expected[index])))).toBeLessThanOrEqual(2);
  expect(evidence.actual).not.toEqual(evidence.immutableCorner);
});

test("transparent artwork preserves alpha without opaque seams", async ({ page }) => {
  await page.goto("/image-quality");
  await page.locator('input[type="file"]').setInputFiles({
    name: "transparent-curves.png",
    mimeType: "image/png",
    buffer: flatCurvePng(64, true),
  });
  await expect(page).toHaveURL(/\/image-quality\/editor$/);
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready/)).toBeVisible({ timeout: 90_000 });
  const alpha = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0;
    let opaque = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] <= 5) transparent += 1;
      if (pixels[offset] >= 250) opaque += 1;
    }
    return { transparentFraction: transparent / (pixels.length / 4), opaqueFraction: opaque / (pixels.length / 4) };
  });
  expect(alpha.transparentFraction).toBeGreaterThan(0.4);
  expect(alpha.opaqueFraction).toBeGreaterThan(0.1);
});

test("the deterministic fallback performs real correction without a neural engine", async ({ page }) => {
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "no-webgpu-photo.png",
    mimeType: "image/png",
    buffer: warmIllustrationPng(64),
  });
  const originalUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \((?:Deterministic adaptive|Production-safe deterministic) restoration · Worker\)/)).toBeVisible({ timeout: 30_000 });
  const result = await page.getByTestId("enhanced-image").evaluate(async (node, sourceUrl) => {
    const decode = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
    };
    const [before, after] = await Promise.all([decode(sourceUrl!), decode((node as HTMLImageElement).src)]);
    return { different: before.some((value, index) => value !== after[index]) };
  }, originalUrl);
  expect(result.different).toBe(true);
});

test("disguised non-image bytes fail before decode without trapping the customer", async ({ page }) => {
  await page.goto("/image-quality");
  await page.locator('input[type="file"]').setInputFiles({
    name: "disguised.png",
    mimeType: "image/png",
    buffer: Buffer.from("<script>not an image</script>"),
  });
  await expect(page.getByText(/file signature is not a valid JPEG, PNG or WebP/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Change image" })).toBeEnabled();
  await expect(page.getByText("Not created yet")).toBeVisible();
});

test("genuine browser-encoded JPEG and WebP files pass signature-first intake", async ({ page }) => {
  for (const mediaType of ["image/jpeg", "image/webp"] as const) {
    await page.goto("/image-quality");
    const values = await page.evaluate(async (type) => {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 32;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#d2a36f";
      context.fillRect(0, 0, 48, 32);
      context.fillStyle = "#153f82";
      context.fillRect(8, 6, 30, 18);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("encode failed")), type, 0.9));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    }, mediaType);
    await page.locator('input[type="file"]').setInputFiles({
      name: mediaType === "image/jpeg" ? "genuine.jpg" : "genuine.webp",
      mimeType: mediaType,
      buffer: Buffer.from(values),
    });
    await expect(page.locator(".quality-inspector .quality-dimensions dd").first()).toHaveText("48 × 32 px");
    await expect(page.getByText(new RegExp(`Verified ${mediaType.split("/")[1].toUpperCase()}`))).toBeVisible();
  }
});

test("an in-flight enhancement can be cancelled without losing the original", async ({ page }) => {
  await page.goto("/image-quality");
  await page.locator('input[type="file"]').setInputFiles({
    name: "cancel-photo.png",
    mimeType: "image/png",
    buffer: warmIllustrationPng(512),
  });
  const originalUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", originalUrl!);
  await expect(page.getByRole("button", { name: "Download enhanced image" })).toBeDisabled();
});

test("upload and editor remain accessible at a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/image-quality");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator('input[type="file"]').setInputFiles({
    name: "mobile-photo.png",
    mimeType: "image/png",
    buffer: warmIllustrationPng(64),
  });
  await expect(page.getByRole("button", { name: "Enhance quality" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change image" })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("[data-testid=image-quality-editor]").analyze()).violations).toEqual([]);
});
