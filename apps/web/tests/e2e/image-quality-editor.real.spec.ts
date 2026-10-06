import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const fixture = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
  "data/fixtures/images/synthetic-noise-64.png",
);
const canonicalLinux = process.env["IPW_CANONICAL_LINUX"] === "1";

async function retainObjectUrlBlobs(page: Page) {
  await page.addInitScript(() => {
    const registry = new Map<string, Blob>();
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    testWindow.__ipwTestObjectUrlBlobs = registry;
    const createObjectUrl = URL.createObjectURL.bind(URL);
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = createObjectUrl(object);
      if (object instanceof Blob) registry.set(url, object);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      registry.delete(url);
      revokeObjectUrl(url);
    };
  });
}

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

function neutralCastPng(width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      scanlines[offset] = 180;
      scanlines[offset + 1] = 170;
      scanlines[offset + 2] = 160;
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

function pointColorPng(width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      scanlines[offset] = 16;
      scanlines[offset + 1] = 112;
      scanlines[offset + 2] = 228;
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

function protectedColorPng(width: number, height: number): Buffer {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const protectedRed = x >= Math.floor(width / 3) && x < Math.ceil(width * 2 / 3);
      scanlines[offset] = protectedRed ? 220 : 40;
      scanlines[offset + 1] = protectedRed ? 40 : 80;
      scanlines[offset + 2] = protectedRed ? 40 : 220;
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

const swapRedBlueCube = `# Rights-cleared synthetic 3D LUT
TITLE "Synthetic red blue swap"
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
LUT_3D_SIZE 2
0 0 0
0 0 1
0 1 0
0 1 1
1 0 0
1 0 1
1 1 0
1 1 1
`;

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

test("automatic tone correction is explainable and requires explicit use and apply actions", async ({ page }) => {
  const source = clippingHistogramPng(64, 48);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "automatic-tone-review.png",
    mimeType: "image/png",
    buffer: source,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  const analyse = page.getByRole("button", { name: "Analyse verified base" });
  await expect(analyse).toBeEnabled();
  await analyse.click();
  const suggestion = page.locator(".quality-auto-tone-result");
  await expect(suggestion).toContainText("Review suggested correction");
  await expect(suggestion).toContainText("cannot recreate detail already clipped");
  await expect(page.getByLabel("Shadow recovery", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("button", { name: "Apply adjustments" })).toBeDisabled();
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(immutableSourceUrl);
  const accessibility = await new AxeBuilder({ page }).include(".quality-auto-tone").analyze();
  expect(accessibility.violations).toEqual([]);

  await suggestion.getByRole("button", { name: "Dismiss" }).click();
  await expect(suggestion).toHaveCount(0);
  await expect(page.getByLabel("Shadow recovery", { exact: true })).toHaveValue("0");
  await analyse.click();
  await expect(suggestion).toContainText("Review suggested correction");
  await suggestion.getByRole("button", { name: "Use suggestion" }).click();
  await expect(suggestion).toContainText("Suggestion loaded into the controls");
  expect(Number(await page.getByLabel("Shadow recovery", { exact: true }).inputValue())).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Apply adjustments" })).toBeEnabled();
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(immutableSourceUrl);

  await page.getByRole("button", { name: "Apply adjustments" }).click();
  await expect(page.getByText(/Light-and-tone derivative ready/)).toBeVisible();
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).not.toBe(immutableSourceUrl);
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

test("built-in tone presets load versioned recipes without changing pixels before apply", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(64, 48);
  await retainObjectUrlBlobs(page);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "tone-preset.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");

  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Light and tone controls" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Built-in collection v1.0.0")).toBeVisible();
  const preset = panel.getByRole("button", { name: /Gentle detail/ });
  const accessibility = await new AxeBuilder({ page }).include(".quality-tone-presets").analyze();
  expect(accessibility.violations).toEqual([]);

  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("Local contrast", { exact: true })).toHaveValue("10");
  await expect(panel.getByLabel("Clarity", { exact: true })).toHaveValue("8");
  await expect(panel.getByLabel("Texture", { exact: true })).toHaveValue("6");
  await expect(panel.getByLabel("Contrast", { exact: true })).toHaveValue("4");
  await expect(page.getByRole("button", { name: "Apply adjustments" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Download adjusted image" })).toBeDisabled();
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(unchangedPreviewUrl);

  await page.getByRole("button", { name: "Apply adjustments" }).click();
  await expect(page.getByText(/Light-and-tone derivative ready/)).toBeVisible();
  await expect(preset).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Apply adjustments" })).toBeDisabled();
  const previewEvidence = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const resultUrl = (node as HTMLImageElement).src;
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(resultUrl);
    if (!previewBlob) throw new Error("Missing active preset preview blob");
    const bytes = await previewBlob.arrayBuffer();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    return { digest, byteLength: bytes.byteLength };
  });
  expect(previewEvidence.byteLength).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("tone-preset-adjusted-64x48.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(64);
  expect(downloaded.readUInt32BE(20)).toBe(48);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.tone.provenance.v8");
  expect(downloaded.toString("utf8")).toContain('"localContrast":10');
  expect(downloaded.toString("utf8")).toContain('"clarity":8');
  expect(downloaded.toString("utf8")).toContain('"texture":6');
  expect(downloaded.toString("utf8")).toContain('"contrast":4');
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);

  await panel.getByLabel("Clarity", { exact: true }).fill("9");
  await expect(preset).toHaveAttribute("aria-pressed", "false");
  await expect(panel.getByText("Custom settings", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download adjusted image" })).toBeDisabled();
});

test("customer tone presets persist locally and require explicit apply", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(64, 48);
  await retainObjectUrlBlobs(page);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "custom-tone.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Light and tone controls" });
  await panel.getByLabel("Clarity", { exact: true }).fill("17");
  await panel.getByLabel("Texture", { exact: true }).fill("9");
  await panel.getByLabel("Preset name", { exact: true }).fill("  Fine   detail  ");
  await panel.getByRole("button", { name: "Save current recipe" }).click();
  await expect(panel.getByText("Saved “Fine detail” in this browser profile.")).toBeVisible();
  const savedPreset = panel.locator(".quality-custom-preset-apply").filter({ hasText: "Fine detail" });
  await expect(savedPreset).toBeVisible();
  expect(await page.evaluate(() => {
    const envelope = JSON.parse(localStorage.getItem("ipw-image-tone-presets:v1") ?? "null");
    return {
      version: envelope?.version,
      count: envelope?.presets?.length,
      name: envelope?.presets?.[0]?.name,
      recipeVersion: envelope?.presets?.[0]?.recipeVersion,
      clarity: envelope?.presets?.[0]?.recipe?.clarity,
      texture: envelope?.presets?.[0]?.recipe?.texture,
    };
  })).toEqual({ version: 1, count: 1, name: "Fine detail", recipeVersion: 8, clarity: 17, texture: 9 });

  await panel.getByRole("button", { name: "Rename Fine detail" }).click();
  await panel.getByLabel("Rename Fine detail").fill("Texture lift");
  await panel.getByRole("button", { name: "Save name" }).click();
  await expect(panel.getByText("Renamed preset to “Texture lift”.")).toBeVisible();

  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "custom-tone.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  const reloadedPanel = page.getByRole("complementary", { name: "Light and tone controls" });
  const persistedPreset = reloadedPanel.locator(".quality-custom-preset-apply").filter({ hasText: "Texture lift" });
  await expect(persistedPreset).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include(".quality-custom-presets").analyze();
  expect(accessibility.violations).toEqual([]);

  await persistedPreset.click();
  await expect(persistedPreset).toHaveAttribute("aria-pressed", "true");
  await expect(reloadedPanel.getByLabel("Clarity", { exact: true })).toHaveValue("17");
  await expect(reloadedPanel.getByLabel("Texture", { exact: true })).toHaveValue("9");
  await expect(reloadedPanel.getByText("Loaded “Texture lift”. Choose Apply adjustments to change pixels.")).toBeVisible();
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(unchangedPreviewUrl);
  await expect(page.getByRole("button", { name: "Download adjusted image" })).toBeDisabled();

  await page.getByRole("button", { name: "Apply adjustments" }).click();
  await expect(page.getByText(/Light-and-tone derivative ready/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("custom-tone-adjusted-64x48.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.tone.provenance.v8");
  expect(downloaded.toString("utf8")).toContain('"clarity":17');
  expect(downloaded.toString("utf8")).toContain('"texture":9');
  expect(downloaded.toString("utf8")).not.toContain("Texture lift");

  await reloadedPanel.getByRole("button", { name: "Delete Texture lift" }).click();
  await expect(reloadedPanel.getByRole("button", { name: "Confirm delete Texture lift" })).toBeVisible();
  await reloadedPanel.getByRole("button", { name: "Confirm delete Texture lift" }).click();
  await expect(persistedPreset).toHaveCount(0);
  await expect(reloadedPanel.getByText("Deleted “Texture lift” from this browser profile.")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ipw-image-tone-presets:v1") ?? "null")?.presets?.length)).toBe(0);
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
  await page.getByLabel("Local contrast", { exact: true }).fill("35");
  await page.getByLabel("Clarity", { exact: true }).fill("40");
  await page.getByLabel("Texture", { exact: true }).fill("45");
  await page.getByLabel("Dehaze", { exact: true }).fill("30");
  await page.getByLabel("Exposure", { exact: true }).fill("0.5");
  await page.getByLabel("Shadows", { exact: true }).fill("30");
  await page.getByLabel("Highlights", { exact: true }).fill("-20");
  await expect(page.getByRole("button", { name: "Apply adjustments" })).toBeEnabled();
  const accessibility = await new AxeBuilder({ page })
    .include(".quality-tone-curve")
    .include(".quality-protected-recovery")
    .include(".quality-local-contrast")
    .include(".quality-clarity")
    .include(".quality-texture")
    .include(".quality-dehaze")
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
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.tone.provenance.v8");
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
  expect(downloaded.toString("utf8")).toContain('"localContrast":35');
  expect(downloaded.toString("utf8")).toContain('"clarity":40');
  expect(downloaded.toString("utf8")).toContain('"texture":45');
  expect(downloaded.toString("utf8")).toContain('"dehaze":30');
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

test("neutral-point white balance samples the verified base and requires explicit use and apply", async ({ page }) => {
  const sourceBytes = neutralCastPng(48, 40);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "white-balance.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");

  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await expect(page.getByLabel("Temperature", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Tint", { exact: true })).toHaveValue("0");
  await page.getByRole("button", { name: "Pick neutral point" }).click();
  await expect(page.getByText(/Select a point in the Result viewer/)).toBeVisible();
  await page.getByTestId("comparison-enhanced").click();

  const suggestion = page.getByTestId("white-balance-suggestion");
  await expect(suggestion).toContainText("Review white-balance suggestion");
  await expect(suggestion).toContainText("Measured RGB180, 170, 160");
  await expect(suggestion).toContainText("Proposed Temperature-54");
  await expect(suggestion).toContainText("Proposed Tint0");
  await expect(page.getByTestId("white-balance-marker")).toBeVisible();
  await expect(page.getByLabel("Temperature", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeDisabled();
  const accessibility = await new AxeBuilder({ page }).include(".quality-white-balance").analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Use suggestion" }).click();
  await expect(page.getByLabel("Temperature", { exact: true })).toHaveValue("-54");
  await expect(page.getByLabel("Tint", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeEnabled();
  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("white-balance-colour-adjusted-48x40.png");
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
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v10");
  expect(downloaded.toString("utf8")).toContain('"white_balance_sample":{"sourceX"');
  expect(downloaded.toString("utf8")).toContain('"red":180,"green":170,"blue":160');
  expect(downloaded.toString("utf8")).toContain('"temperature":-54,"tint":0');

  await page.getByRole("button", { name: "Pick neutral point" }).click();
  await expect(page.getByText("White-balance sampling base", { exact: true })).toBeVisible();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);
  await page.getByRole("button", { name: "Cancel neutral sampling" }).click();
});

test("point colour samples the verified base and applies one bounded source-bound hue target", async ({ page }) => {
  const sourceBytes = pointColorPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.setViewportSize({ width: 1760, height: 900 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "point-colour.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");

  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await expect(page.getByLabel("Point-colour hue", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Pick colour from image" }).click();
  await expect(page.getByText(/Select a coloured point in the Result viewer/)).toBeVisible();
  const resultViewer = page.getByTestId("comparison-enhanced");
  await resultViewer.focus();
  await resultViewer.press("Enter");

  const sample = page.getByTestId("point-color-sample");
  await expect(sample).toContainText("Sampled colour ready");
  await expect(sample).toContainText("Measured RGB16, 112, 228");
  await expect(sample).toContainText("Target hue213 degrees");
  await expect(page.getByTestId("point-color-marker")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeDisabled();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);

  await page.getByLabel("Point-colour target tolerance", { exact: true }).fill("16");
  await page.getByLabel("Point-colour edge feather", { exact: true }).fill("20");
  await page.getByLabel("Point-colour hue", { exact: true }).fill("45");
  await page.getByLabel("Point-colour saturation", { exact: true }).fill("30");
  await page.getByLabel("Point-colour lightness", { exact: true }).fill("-8");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeEnabled();
  const accessibility = await new AxeBuilder({ page }).include(".quality-point-color").analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();
  const previewDigest = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const resultUrl = (node as HTMLImageElement).src;
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(resultUrl);
    if (!previewBlob) throw new Error("The exact point-colour preview Blob was not retained by the test harness");
    const bytes = await previewBlob.arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
  });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("point-colour-colour-adjusted-48x40.png");
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
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewDigest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v10");
  expect(downloaded.toString("utf8")).toContain('"point_color_sample":{"sourceX":24,"sourceY":20');
  expect(downloaded.toString("utf8")).toContain('"red":16,"green":112,"blue":228,"hue":213');
  expect(downloaded.toString("utf8")).toContain('"pointColor":{"enabled":true,"targetHue":213,"tolerance":16,"feather":20,"hue":45,"saturation":30,"lightness":-8}');

  await page.getByRole("button", { name: "Clear sampled colour" }).click();
  await expect(page.getByTestId("point-color-sample")).toHaveCount(0);
  await expect(page.getByLabel("Point-colour hue", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
});

test("reviewed protected colour is proposal-first, source-bound and constrains the final colour result", async ({ page }) => {
  const sourceBytes = protectedColorPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "protected-colour.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await page.getByRole("button", { name: "Pick colour to protect" }).click();
  const resultViewer = page.getByTestId("comparison-enhanced");
  await resultViewer.focus();
  await resultViewer.press("Enter");

  const review = page.getByTestId("protected-color-review");
  await expect(review).toContainText("Protected-colour sample ready for review");
  await expect(review).toContainText("Measured RGB220, 40, 40");
  await expect(page.getByTestId("protected-color-marker")).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeDisabled();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);

  await page.getByLabel("Protected-colour purpose").selectOption("brand");
  await page.getByRole("button", { name: "Add protected colour" }).click();
  await expect(page.getByTestId("protected-color-review")).toHaveCount(0);
  const anchor = page.getByTestId("protected-color-anchor");
  await expect(anchor).toContainText("Brand colour");
  await expect(anchor).toContainText("RGB 220, 40, 40");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeDisabled();
  const accessibility = await new AxeBuilder({ page }).include(".quality-protected-colors").analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByLabel("Temperature", { exact: true }).fill("100");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeEnabled();
  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();

  const previewEvidence = await page.getByTestId("enhanced-image").evaluate(async (node, sourceUrl) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(image.src);
    if (!previewBlob) throw new Error("The exact protected-colour preview Blob was not retained by the test harness");
    const bytes = await previewBlob.arrayBuffer();
    const sourceImage = new Image();
    sourceImage.src = sourceUrl;
    await sourceImage.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(sourceImage, 0, 0);
    const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const resultPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let protectedChanged = 0;
    let unprotectedChanged = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        const changed = sourcePixels[index] !== resultPixels[index]
          || sourcePixels[index + 1] !== resultPixels[index + 1]
          || sourcePixels[index + 2] !== resultPixels[index + 2];
        const protectedBand = x >= Math.floor(canvas.width / 3) && x < Math.ceil(canvas.width * 2 / 3);
        if (changed && protectedBand) protectedChanged += 1;
        if (changed && !protectedBand) unprotectedChanged += 1;
        if (sourcePixels[index + 3] !== resultPixels[index + 3]) throw new Error("Protected-colour processing changed alpha");
      }
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { protectedChanged, unprotectedChanged, digest };
  }, immutableSourceUrl!);
  expect(previewEvidence.protectedChanged).toBe(0);
  expect(previewEvidence.unprotectedChanged).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  const provenance = downloaded.toString("utf8");
  expect(provenance).toContain("ipw.image-edit.color.provenance.v10");
  expect(provenance).toContain('"reviewed_protected_colour_blendback"');
  expect(provenance).toContain('"protectedColors":[{"enabled":true,"kind":"brand"');

  await page.getByLabel("Brand colour protection strength").fill("50");
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByLabel("Exposure", { exact: true }).fill("0.1");
  await page.getByRole("button", { name: "Apply adjustments" }).click();
  await expect(page.getByText(/Light-and-tone derivative ready/)).toBeVisible();
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await expect(page.getByTestId("protected-color-anchor")).toHaveCount(0);
  await expect(page.getByText(/source-bound reference match and protected colours were cleared/)).toBeVisible();
});

test("reviewed reference colour match is proposal-first, source-bound and preview-download identical", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  const referenceBytes = warmIllustrationPng(56);
  const referenceSha256 = createHash("sha256").update(referenceBytes).digest("hex");
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.addInitScript(() => {
    const registry = new Map<string, Blob>();
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    testWindow.__ipwTestObjectUrlBlobs = registry;
    const createObjectUrl = URL.createObjectURL.bind(URL);
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = createObjectUrl(object);
      if (object instanceof Blob) registry.set(url, object);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      registry.delete(url);
      revokeObjectUrl(url);
    };
  });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "colour-match-source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  const beforeProposalUrl = await page.getByTestId("enhanced-image").getAttribute("src");

  await page.getByLabel("Choose colour-match reference image").setInputFiles({
    name: "rights-cleared-warm-reference.png",
    mimeType: "image/png",
    buffer: referenceBytes,
  });
  const review = page.getByTestId("color-match-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText("rights-cleared-warm-reference.png");
  await expect(review).toContainText("56 Ã— 56 px");
  await expect(review).toContainText(`${referenceSha256.slice(0, 12)}â€¦`);
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", beforeProposalUrl!);
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeDisabled();
  const accessibility = await new AxeBuilder({ page }).include(".quality-color-match").analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Use colour match" }).click();
  await expect(page.getByLabel("Enable reference match", { exact: false })).toBeChecked();
  await page.getByLabel("Match strength", { exact: true }).fill("50");
  await page.getByLabel("Luminance match", { exact: true }).fill("55");
  await page.getByLabel("Colour intensity", { exact: true }).fill("80");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeEnabled();
  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();

  const previewEvidence = await page.getByTestId("enhanced-image").evaluate(async (node, sourceUrl) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const resultUrl = image.src;
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(resultUrl);
    if (!previewBlob) throw new Error("The exact colour-match preview Blob was not retained by the test harness");
    const bytes = await previewBlob.arrayBuffer();
    const sourceImage = new Image();
    sourceImage.src = sourceUrl;
    await sourceImage.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(sourceImage, 0, 0);
    const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const resultPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let changedPixels = 0;
    for (let index = 0; index < sourcePixels.length; index += 4) {
      if (sourcePixels[index] !== resultPixels[index]
        || sourcePixels[index + 1] !== resultPixels[index + 1]
        || sourcePixels[index + 2] !== resultPixels[index + 2]) changedPixels += 1;
      if (sourcePixels[index + 3] !== resultPixels[index + 3]) throw new Error("Colour match changed alpha");
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { width: image.naturalWidth, height: image.naturalHeight, changedPixels, digest };
  }, immutableSourceUrl!);
  expect(previewEvidence).toMatchObject({ width: 48, height: 40 });
  expect(previewEvidence.changedPixels).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("colour-match-source-colour-adjusted-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  const provenance = downloaded.toString("utf8");
  expect(provenance).toContain("ipw.image-edit.color.provenance.v10");
  expect(provenance).toContain('"reviewed_reference_colour_match"');
  expect(provenance).toContain(`"referenceSha256":"${referenceSha256}"`);
  expect(provenance).toContain('"method":"bounded-oklab-distribution-v1"');
  expect(provenance).not.toContain("rights-cleared-warm-reference.png");

  await page.getByLabel("Match strength", { exact: true }).fill("60");
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
  await page.getByRole("button", { name: "Remove active match" }).click();
  await expect(page.getByTestId("color-match-review")).toHaveCount(0);
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);
});

test("reviewed 3D LUT is the final creative transform and binds preview to download", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  const lutBytes = Buffer.from(swapRedBlueCube, "utf8");
  const lutSha256 = createHash("sha256").update(lutBytes).digest("hex");
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.addInitScript(() => {
    const registry = new Map<string, Blob>();
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    testWindow.__ipwTestObjectUrlBlobs = registry;
    const createObjectUrl = URL.createObjectURL.bind(URL);
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = createObjectUrl(object);
      if (object instanceof Blob) registry.set(url, object);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      registry.delete(url);
      revokeObjectUrl(url);
    };
  });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "lut-source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");

  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await page.getByLabel("Choose 3D LUT file").setInputFiles({
    name: "swap-red-blue.cube",
    mimeType: "text/plain",
    buffer: lutBytes,
  });
  await expect(page.getByText("3D LUT validated locally. Review its identity and intensity, then apply colour.")).toBeVisible();
  const review = page.getByTestId("cube-lut-review");
  await expect(review).toContainText("Reviewed 3D LUT ready");
  await expect(review).toContainText("swap-red-blue.cube");
  await expect(review).toContainText("Synthetic red blue swap");
  await expect(review).toContainText("2 × 2 × 2");
  await expect(review).toContainText("0, 0, 0 to 1, 1, 1");
  await expect(review).toContainText("Tetrahedral");
  await expect(review).toContainText(`${lutSha256.slice(0, 12)}…`);
  await expect(page.getByLabel("Enable imported LUT", { exact: false })).toBeChecked();
  await page.getByLabel("3D LUT intensity", { exact: true }).fill("50");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeEnabled();
  const accessibility = await new AxeBuilder({ page }).include(".quality-cube-lut").analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();
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
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(resultUrl);
    if (!previewBlob) throw new Error("The exact colour preview Blob was not retained by the test harness");
    const [source, result, bytes] = await Promise.all([
      decode(sourceUrl),
      decode(resultUrl),
      previewBlob.arrayBuffer(),
    ]);
    let changedPixels = 0;
    for (let index = 0; index < source.pixels.length; index += 4) {
      if (source.pixels[index] !== result.pixels[index]
        || source.pixels[index + 1] !== result.pixels[index + 1]
        || source.pixels[index + 2] !== result.pixels[index + 2]) changedPixels += 1;
      if (source.pixels[index + 3] !== result.pixels[index + 3]) throw new Error("3D LUT changed alpha");
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { width: result.width, height: result.height, changedPixels, digest };
  }, immutableSourceUrl!);
  expect(previewEvidence).toMatchObject({ width: 48, height: 40 });
  expect(previewEvidence.changedPixels).toBeGreaterThan(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("lut-source-colour-adjusted-48x40.png");
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
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v10");
  expect(downloaded.toString("utf8")).toContain('"reviewed_3d_lut_tetrahedral"');
  expect(downloaded.toString("utf8")).toContain(`"cubeLut":{"enabled":true,"intensity":50,"sha256":"${lutSha256}","title":"Synthetic red blue swap","size":2,"domainMin":[0,0,0],"domainMax":[1,1,1],"interpolation":"tetrahedral"}`);

  await page.getByLabel("3D LUT intensity", { exact: true }).fill("60");
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
  await page.getByRole("button", { name: "Remove LUT" }).click();
  await expect(page.getByTestId("cube-lut-review")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);
});

test("built-in colour looks load deterministic recipes without changing pixels before apply", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "colour-preset.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");

  await page.getByRole("button", { name: "Colour", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Colour controls" });
  await expect(panel.getByText("Built-in collection v1.0.0")).toBeVisible();
  const preset = panel.getByRole("button", { name: /Natural vibrance/ });
  const accessibility = await new AxeBuilder({ page }).include(".quality-color-presets").analyze();
  expect(accessibility.violations).toEqual([]);

  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("Temperature", { exact: true })).toHaveValue("4");
  await expect(panel.getByLabel("Tint", { exact: true })).toHaveValue("1");
  await expect(panel.getByLabel("Saturation", { exact: true })).toHaveValue("2");
  await expect(panel.getByLabel("Vibrance", { exact: true })).toHaveValue("12");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(unchangedPreviewUrl);

  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();
  await expect(preset).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Apply colour" })).toBeDisabled();
  const previewEvidence = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(image.src);
    if (!previewBlob) throw new Error("Missing active colour-preset preview blob");
    const bytes = await previewBlob.arrayBuffer();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    return { width: image.naturalWidth, height: image.naturalHeight, digest };
  });
  expect(previewEvidence).toMatchObject({ width: 48, height: 40 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("colour-preset-colour-adjusted-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v10");
  expect(downloaded.toString("utf8")).toContain('"temperature":4');
  expect(downloaded.toString("utf8")).toContain('"tint":1');
  expect(downloaded.toString("utf8")).toContain('"saturation":2');
  expect(downloaded.toString("utf8")).toContain('"vibrance":12');
  expect(downloaded.toString("utf8")).toContain('"colorMatch":null');
  expect(downloaded.toString("utf8")).toContain('"cubeLut":null');
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);

  await panel.getByLabel("Saturation", { exact: true }).fill("3");
  await expect(preset).toHaveAttribute("aria-pressed", "false");
  await expect(panel.getByText("Custom colour", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
});

test("customer colour presets persist portable recipes locally and require explicit apply", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "custom-colour.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Colour controls" });
  await panel.getByLabel("Temperature", { exact: true }).fill("13");
  await panel.getByLabel("Vibrance", { exact: true }).fill("17");
  await panel.getByLabel("Colour preset name", { exact: true }).fill("  Warm   detail  ");
  await panel.getByRole("button", { name: "Save current colour recipe" }).click();
  await expect(panel.getByText('Saved "Warm detail" in this browser profile.')).toBeVisible();
  const savedPreset = panel.locator(".quality-custom-preset-apply").filter({ hasText: "Warm detail" });
  await expect(savedPreset).toBeVisible();
  expect(await page.evaluate(() => {
    const envelope = JSON.parse(localStorage.getItem("ipw-image-color-presets:v1") ?? "null");
    return {
      version: envelope?.version,
      count: envelope?.presets?.length,
      name: envelope?.presets?.[0]?.name,
      recipeVersion: envelope?.presets?.[0]?.recipeVersion,
      temperature: envelope?.presets?.[0]?.recipe?.temperature,
      vibrance: envelope?.presets?.[0]?.recipe?.vibrance,
      pointColor: envelope?.presets?.[0]?.recipe?.pointColor,
      colorMatch: envelope?.presets?.[0]?.recipe?.colorMatch,
      cubeLut: envelope?.presets?.[0]?.recipe?.cubeLut,
      protectedColors: envelope?.presets?.[0]?.recipe?.protectedColors,
    };
  })).toEqual({
    version: 1,
    count: 1,
    name: "Warm detail",
    recipeVersion: 10,
    temperature: 13,
    vibrance: 17,
    pointColor: {
      enabled: false,
      targetHue: 0,
      tolerance: 18,
      feather: 18,
      hue: 0,
      saturation: 0,
      lightness: 0,
    },
    colorMatch: null,
    cubeLut: null,
    protectedColors: [],
  });

  await panel.getByRole("button", { name: "Rename Warm detail" }).click();
  await panel.getByLabel("Rename Warm detail").fill("Warm finish");
  await panel.getByRole("button", { name: "Save name" }).click();
  await expect(panel.getByText('Renamed colour preset to "Warm finish".')).toBeVisible();

  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "custom-colour.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  const reloadedPanel = page.getByRole("complementary", { name: "Colour controls" });
  const persistedPreset = reloadedPanel.locator(".quality-custom-preset-apply").filter({ hasText: "Warm finish" });
  await expect(persistedPreset).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include(".quality-custom-color-presets").analyze();
  expect(accessibility.violations).toEqual([]);

  await persistedPreset.click();
  await expect(persistedPreset).toHaveAttribute("aria-pressed", "true");
  await expect(reloadedPanel.getByLabel("Temperature", { exact: true })).toHaveValue("13");
  await expect(reloadedPanel.getByLabel("Vibrance", { exact: true })).toHaveValue("17");
  await expect(reloadedPanel.getByText('Loaded "Warm finish". Choose Apply colour to change pixels.')).toBeVisible();
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(unchangedPreviewUrl);
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();

  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();
  const previewEvidence = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(image.src);
    if (!previewBlob) throw new Error("Missing active custom-colour preview blob");
    const bytes = await previewBlob.arrayBuffer();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    return { width: image.naturalWidth, height: image.naturalHeight, digest };
  });
  expect(previewEvidence).toMatchObject({ width: 48, height: 40 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("custom-colour-colour-adjusted-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v10");
  expect(downloaded.toString("utf8")).toContain('"temperature":13');
  expect(downloaded.toString("utf8")).toContain('"vibrance":17');
  expect(downloaded.toString("utf8")).not.toContain("Warm finish");
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);

  await reloadedPanel.getByRole("button", { name: "Delete Warm finish" }).click();
  await expect(reloadedPanel.getByRole("button", { name: "Confirm delete Warm finish" })).toBeVisible();
  await reloadedPanel.getByRole("button", { name: "Confirm delete Warm finish" }).click();
  await expect(persistedPreset).toHaveCount(0);
  await expect(reloadedPanel.getByText('Deleted "Warm finish" from this browser profile.')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ipw-image-color-presets:v1") ?? "null")?.presets?.length)).toBe(0);
});

test("vignette is an explicit deterministic stage with exact preview and download bytes", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "vignette-source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");

  await page.getByRole("button", { name: "Effects", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Effects controls" });
  await panel.getByLabel("Vignette amount", { exact: true }).fill("-60");
  await panel.getByLabel("Vignette midpoint", { exact: true }).fill("40");
  await panel.getByLabel("Vignette feather", { exact: true }).fill("65");
  await expect(panel.getByText("Dark 60", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Apply effects" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(unchangedPreviewUrl);

  await panel.getByRole("button", { name: "Apply effects" }).click();
  await expect(page.getByText(/Effects derivative ready/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Apply effects" })).toBeDisabled();
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
    const image = node as HTMLImageElement;
    await image.decode();
    const registry = (window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> }).__ipwTestObjectUrlBlobs;
    const blob = registry?.get(image.src);
    if (!blob) throw new Error("Missing exact effects preview Blob");
    const [source, result, bytes] = await Promise.all([decode(sourceUrl), decode(image.src), blob.arrayBuffer()]);
    const cornerChanged = source.pixels[0] !== result.pixels[0]
      || source.pixels[1] !== result.pixels[1]
      || source.pixels[2] !== result.pixels[2];
    const centreOffset = ((Math.floor(result.height / 2) * result.width) + Math.floor(result.width / 2)) * 4;
    const centreUnchanged = [0, 1, 2, 3].every((channel) => (
      source.pixels[centreOffset + channel] === result.pixels[centreOffset + channel]
    ));
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    return { width: result.width, height: result.height, cornerChanged, centreUnchanged, digest };
  }, immutableSourceUrl!);
  expect(previewEvidence).toMatchObject({
    width: 48,
    height: 40,
    cornerChanged: true,
    centreUnchanged: true,
  });

  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Effects controls"]').analyze();
  expect(accessibility.violations).toEqual([]);
  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download effects-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("vignette-source-effects-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(previewEvidence.digest);
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.effects.provenance.v3");
  expect(downloaded.toString("utf8")).toContain('"bloom":{"amount":0,"radius":8,"threshold":70}');
  expect(downloaded.toString("utf8")).toContain('"grain":{"amount":0,"size":2}');
  expect(downloaded.toString("utf8")).toContain('"vignette":{"amount":-60,"midpoint":40,"feather":65}');
  expect(await page.getByTestId("original-image").getAttribute("src")).toBe(immutableSourceUrl);

  await panel.getByLabel("Vignette amount", { exact: true }).fill("-70");
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);
});

test("film grain is an explicit deterministic stage with exact preview and download bytes", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "grain-source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Effects controls" });
  await panel.getByLabel("Film grain amount", { exact: true }).fill("55");
  await panel.getByLabel("Film grain size", { exact: true }).fill("3");
  await expect(panel.getByText("55%", { exact: true })).toBeVisible();
  await expect(panel.getByText("3 px", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Apply effects" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", immutableSourceUrl!);
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", unchangedPreviewUrl!);

  const renderAndInspect = async () => {
    await panel.getByRole("button", { name: "Apply effects" }).click();
    await expect(page.getByText(/Effects derivative ready/)).toBeVisible();
    return page.getByTestId("enhanced-image").evaluate(async (node, sourceUrl) => {
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
      const image = node as HTMLImageElement;
      await image.decode();
      const registry = (window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> }).__ipwTestObjectUrlBlobs;
      const blob = registry?.get(image.src);
      if (!blob) throw new Error("Missing exact grain preview Blob");
      const [source, result, bytes] = await Promise.all([decode(sourceUrl), decode(image.src), blob.arrayBuffer()]);
      let changedPixels = 0;
      for (let offset = 0; offset < result.pixels.length; offset += 4) {
        if (source.pixels[offset] !== result.pixels[offset]
          || source.pixels[offset + 1] !== result.pixels[offset + 1]
          || source.pixels[offset + 2] !== result.pixels[offset + 2]) changedPixels += 1;
      }
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      return { width: result.width, height: result.height, changedPixels, digest };
    }, immutableSourceUrl!);
  };

  const firstPreview = await renderAndInspect();
  expect(firstPreview.width).toBe(48);
  expect(firstPreview.height).toBe(40);
  expect(firstPreview.changedPixels).toBeGreaterThan(0);
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Effects controls"]').analyze();
  expect(accessibility.violations).toEqual([]);

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download effects-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("grain-source-effects-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(firstPreview.digest);
  const provenance = downloaded.toString("utf8");
  expect(provenance).toContain("ipw.image-edit.effects.provenance.v3");
  expect(provenance).toContain('"operation_order":["source_neighbourhood_highlight_bloom","source_coordinate_film_grain","source_coordinate_vignette"]');
  expect(provenance).toContain('"bloom":{"amount":0,"radius":8,"threshold":70}');
  expect(provenance).toContain('"grain":{"amount":55,"size":3}');
  expect(provenance).toContain('"vignette":{"amount":0,"midpoint":50,"feather":50}');
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", immutableSourceUrl!);

  await panel.getByRole("button", { name: "Reset effects" }).click();
  await panel.getByLabel("Film grain amount", { exact: true }).fill("55");
  await panel.getByLabel("Film grain size", { exact: true }).fill("3");
  const repeatedPreview = await renderAndInspect();
  expect(repeatedPreview.digest).toBe(firstPreview.digest);

  await panel.getByLabel("Film grain amount", { exact: true }).fill("65");
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);
});

test("highlight bloom is source-derived, deterministic and exact across preview and download", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "bloom-source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Effects controls" });
  await panel.getByLabel("Highlight bloom amount", { exact: true }).fill("75");
  await panel.getByLabel("Highlight bloom radius", { exact: true }).fill("5");
  await panel.getByLabel("Highlight bloom threshold", { exact: true }).fill("45");
  await expect(panel.getByText("75%", { exact: true })).toBeVisible();
  await expect(panel.getByText("5 px", { exact: true })).toBeVisible();
  await expect(panel.getByText("45% brightness", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Apply effects" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", immutableSourceUrl!);
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", unchangedPreviewUrl!);

  const renderAndInspect = async () => {
    await panel.getByRole("button", { name: "Apply effects" }).click();
    await expect(page.getByText(/Effects derivative ready/)).toBeVisible();
    return page.getByTestId("enhanced-image").evaluate(async (node, sourceUrl) => {
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
      const image = node as HTMLImageElement;
      await image.decode();
      const registry = (window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> }).__ipwTestObjectUrlBlobs;
      const blob = registry?.get(image.src);
      if (!blob) throw new Error("Missing exact bloom preview Blob");
      const [source, result, bytes] = await Promise.all([decode(sourceUrl), decode(image.src), blob.arrayBuffer()]);
      let changedPixels = 0;
      let brightenedPixels = 0;
      let newClippedChannels = 0;
      for (let offset = 0; offset < result.pixels.length; offset += 4) {
        let changed = false;
        let brightened = false;
        for (let channel = 0; channel < 3; channel += 1) {
          if (source.pixels[offset + channel] !== result.pixels[offset + channel]) changed = true;
          if (result.pixels[offset + channel] > source.pixels[offset + channel]) brightened = true;
          if (source.pixels[offset + channel] < 255 && result.pixels[offset + channel] === 255) {
            newClippedChannels += 1;
          }
        }
        if (changed) changedPixels += 1;
        if (brightened) brightenedPixels += 1;
      }
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      return {
        width: result.width,
        height: result.height,
        changedPixels,
        brightenedPixels,
        newClippedChannels,
        digest,
      };
    }, immutableSourceUrl!);
  };

  const firstPreview = await renderAndInspect();
  expect(firstPreview).toMatchObject({ width: 48, height: 40, newClippedChannels: 0 });
  expect(firstPreview.changedPixels).toBeGreaterThan(0);
  expect(firstPreview.brightenedPixels).toBeGreaterThan(0);
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Effects controls"]').analyze();
  expect(accessibility.violations).toEqual([]);

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download effects-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("bloom-source-effects-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(firstPreview.digest);
  const provenance = downloaded.toString("utf8");
  expect(provenance).toContain("ipw.image-edit.effects.provenance.v3");
  expect(provenance).toContain('"operation_order":["source_neighbourhood_highlight_bloom","source_coordinate_film_grain","source_coordinate_vignette"]');
  expect(provenance).toContain('"bloom":{"amount":75,"radius":5,"threshold":45}');
  expect(provenance).toContain('"grain":{"amount":0,"size":2}');
  expect(provenance).toContain('"vignette":{"amount":0,"midpoint":50,"feather":50}');
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", immutableSourceUrl!);

  await panel.getByRole("button", { name: "Reset effects" }).click();
  await panel.getByLabel("Highlight bloom amount", { exact: true }).fill("75");
  await panel.getByLabel("Highlight bloom radius", { exact: true }).fill("5");
  await panel.getByLabel("Highlight bloom threshold", { exact: true }).fill("45");
  const repeatedPreview = await renderAndInspect();
  expect(repeatedPreview.digest).toBe(firstPreview.digest);

  await panel.getByLabel("Highlight bloom threshold", { exact: true }).fill("55");
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);
});

test("built-in effect looks load complete reviewable recipes without silently applying pixels", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "effect-look-source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  const immutableSourceUrl = await page.getByTestId("original-image").getAttribute("src");
  const unchangedPreviewUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Effects controls" });
  await expect(panel.getByText("Neutral settings", { exact: true })).toBeVisible();
  await expect(panel.getByText("Built-in collection v1.0.0", { exact: true })).toBeVisible();

  const analog = panel.getByRole("button", { name: /Analog finish/ });
  await analog.click();
  await expect(analog).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".quality-tone-preset-status > span")).toHaveText("Analog finish");
  await expect(panel.getByLabel("Highlight bloom amount", { exact: true })).toHaveValue("16");
  await expect(panel.getByLabel("Highlight bloom radius", { exact: true })).toHaveValue("7");
  await expect(panel.getByLabel("Highlight bloom threshold", { exact: true })).toHaveValue("76");
  await expect(panel.getByLabel("Film grain amount", { exact: true })).toHaveValue("18");
  await expect(panel.getByLabel("Film grain size", { exact: true })).toHaveValue("2");
  await expect(panel.getByLabel("Vignette amount", { exact: true })).toHaveValue("-18");
  await expect(panel.getByLabel("Vignette midpoint", { exact: true })).toHaveValue("54");
  await expect(panel.getByLabel("Vignette feather", { exact: true })).toHaveValue("76");
  await expect(panel.getByRole("button", { name: "Apply effects" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("original-image")).toHaveAttribute("src", immutableSourceUrl!);
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", unchangedPreviewUrl!);

  await panel.getByRole("button", { name: "Apply effects" }).click();
  await expect(page.getByText(/Effects derivative ready/)).toBeVisible();
  await expect(page.getByTestId("enhanced-image")).not.toHaveAttribute("src", unchangedPreviewUrl!);
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Effects controls"]').analyze();
  expect(accessibility.violations).toEqual([]);

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download effects-adjusted image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("effect-look-source-effects-48x40.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  stream.destroy();
  const downloaded = Buffer.concat(chunks);
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(40);
  const provenance = downloaded.toString("utf8");
  expect(provenance).toContain("ipw.image-edit.effects.provenance.v3");
  expect(provenance).toContain('"bloom":{"amount":16,"radius":7,"threshold":76}');
  expect(provenance).toContain('"grain":{"amount":18,"size":2}');
  expect(provenance).toContain('"vignette":{"amount":-18,"midpoint":54,"feather":76}');
  expect(provenance).not.toContain("Analog finish");

  await panel.getByLabel("Film grain amount", { exact: true }).fill("19");
  await expect(panel.getByText("Custom settings", { exact: true })).toBeVisible();
  await expect(analog).toHaveAttribute("aria-pressed", "false");
  await expect(panel.getByRole("button", { name: "Download effects-adjusted image" })).toBeDisabled();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", immutableSourceUrl!);
});

test("colour applies after tone and binds preview and download to the exact verified base", async ({ page }) => {
  const sourceBytes = progressiveStrengthPng(48, 40);
  await retainObjectUrlBlobs(page);
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
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(image.src);
    if (!previewBlob) throw new Error("The exact tone preview Blob was not retained by the test harness");
    const bytes = await previewBlob.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { url: image.src, digest };
  });

  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Colour controls" })).toBeVisible();
  await page.getByLabel("Temperature", { exact: true }).fill("35");
  await page.getByLabel("Tint", { exact: true }).fill("-15");
  await page.getByLabel("Saturation", { exact: true }).fill("20");
  await page.getByLabel("Vibrance", { exact: true }).fill("30");
  await expect(page.getByRole("button", { name: "Red range, neutral", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Red hue", { exact: true }).fill("35");
  await page.getByLabel("Red saturation", { exact: true }).fill("25");
  await page.getByLabel("Red lightness", { exact: true }).fill("-10");
  await expect(page.getByRole("button", { name: "Red range, adjusted", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Blue range, neutral", exact: true }).click();
  await expect(page.getByLabel("Blue hue", { exact: true })).toHaveValue("0");
  await page.getByRole("button", { name: "Red range, adjusted", exact: true }).click();
  await expect(page.getByLabel("Red hue", { exact: true })).toHaveValue("35");
  await expect(page.getByRole("button", { name: "Shadows grade, neutral", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Shadows hue", { exact: true }).fill("220");
  await page.getByLabel("Shadows saturation", { exact: true }).fill("35");
  await page.getByLabel("Shadows luminance", { exact: true }).fill("10");
  await expect(page.getByRole("button", { name: "Shadows grade, adjusted", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Highlights grade, neutral", exact: true }).click();
  await expect(page.getByLabel("Highlights saturation", { exact: true })).toHaveValue("0");
  await page.getByRole("button", { name: "Shadows grade, adjusted", exact: true }).click();
  await expect(page.getByLabel("Shadows hue", { exact: true })).toHaveValue("220");
  await page.getByLabel("Enable black-and-white mixer", { exact: false }).check();
  await page.getByLabel("Black-and-white red mix", { exact: true }).fill("50");
  await page.getByLabel("Black-and-white green mix", { exact: true }).fill("35");
  await page.getByLabel("Black-and-white blue mix", { exact: true }).fill("15");
  await expect(page.getByText("Channel total: 100%.", { exact: false })).toBeVisible();
  await page.getByLabel("Enable duotone", { exact: false }).check();
  await page.getByLabel("Duotone shadow hue", { exact: true }).fill("225");
  await page.getByLabel("Duotone shadow saturation", { exact: true }).fill("42");
  await page.getByLabel("Duotone highlight hue", { exact: true }).fill("38");
  await page.getByLabel("Duotone highlight saturation", { exact: true }).fill("24");
  await page.getByLabel("Duotone balance", { exact: true }).fill("12");
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
    const testWindow = window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> };
    const previewBlob = testWindow.__ipwTestObjectUrlBlobs?.get(resultUrl);
    if (!previewBlob) throw new Error("The exact colour preview Blob was not retained by the test harness");
    const [base, result, bytes] = await Promise.all([
      decode(baseUrl),
      decode(resultUrl),
      previewBlob.arrayBuffer(),
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
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v10");
  expect(downloaded.toString("utf8")).toContain('"white_balance_sample":null');
  expect(downloaded.toString("utf8")).toContain('"point_color_sample":null');
  expect(downloaded.toString("utf8")).toContain('"base_kind":"tone"');
  expect(downloaded.toString("utf8")).toContain(toneEvidence.digest);
  expect(downloaded.toString("utf8")).toContain('"temperature":35');
  expect(downloaded.toString("utf8")).toContain('"tint":-15');
  expect(downloaded.toString("utf8")).toContain('"saturation":20');
  expect(downloaded.toString("utf8")).toContain('"vibrance":30');
  expect(downloaded.toString("utf8")).toContain('"red":{"hue":35,"saturation":25,"lightness":-10}');
  expect(downloaded.toString("utf8")).toContain('"shadows":{"hue":220,"saturation":35,"luminance":10}');
  expect(downloaded.toString("utf8")).toContain('"blackAndWhite":{"enabled":true,"red":50,"green":35,"blue":15}');
  expect(downloaded.toString("utf8")).toContain('"duotone":{"enabled":true,"shadowHue":225,"shadowSaturation":42,"highlightHue":38,"highlightSaturation":24,"balance":12}');

  await page.getByLabel("Saturation", { exact: true }).fill("25");
  await expect(page.getByRole("button", { name: "Download colour-adjusted image" })).toBeDisabled();
  await expect(colorProperty).toHaveText("Unapplied changes");
  await page.getByRole("button", { name: "Reset colour" }).click();
  await expect(colorProperty).toHaveText("None");
  expect(await page.getByTestId("enhanced-image").getAttribute("src")).toBe(toneEvidence.url);
});

test("colour-vision modes change only the result preview and never the downloadable derivative", async ({ page }) => {
  const sourceBytes = pointColorPng(48, 40);
  await retainObjectUrlBlobs(page);
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "colour-vision-source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await page.getByLabel("Temperature", { exact: true }).fill("25");
  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();

  const appliedEvidence = await page.getByTestId("enhanced-image").evaluate(async (node) => {
    const url = (node as HTMLImageElement).src;
    const registry = (window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> }).__ipwTestObjectUrlBlobs;
    const blob = registry?.get(url);
    if (!blob) throw new Error("The colour derivative Blob was not retained by the test harness");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
    return { url, digest, width: new DataView(bytes.buffer).getUint32(16), height: new DataView(bytes.buffer).getUint32(20) };
  });
  expect(appliedEvidence.width).toBe(48);
  expect(appliedEvidence.height).toBe(40);

  const modeDigests: string[] = [];
  for (const mode of ["Protanopia", "Deuteranopia", "Tritanopia"] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.getByText(new RegExp(`${mode} preview is active`))).toBeVisible();
    await expect(page.getByTestId("comparison-enhanced")).toContainText(`${mode} preview · Result only`);
    const evidence = await page.getByTestId("enhanced-image").evaluate(async (node) => {
      const url = (node as HTMLImageElement).src;
      const registry = (window as typeof window & { __ipwTestObjectUrlBlobs?: Map<string, Blob> }).__ipwTestObjectUrlBlobs;
      const blob = registry?.get(url);
      if (!blob) throw new Error("The simulated preview Blob was not retained by the test harness");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
      return { digest, width: new DataView(bytes.buffer).getUint32(16), height: new DataView(bytes.buffer).getUint32(20) };
    });
    expect(evidence.width).toBe(48);
    expect(evidence.height).toBe(40);
    expect(evidence.digest).not.toBe(appliedEvidence.digest);
    modeDigests.push(evidence.digest);
  }
  expect(new Set(modeDigests).size).toBe(3);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour-adjusted image" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks);
  expect(createHash("sha256").update(downloaded).digest("hex")).toBe(appliedEvidence.digest);
  expect(createHash("sha256").update(downloaded).digest("hex")).not.toBe(modeDigests.at(-1));
  expect(downloaded.toString("utf8")).toContain("ipw.image-edit.color.provenance.v10");

  const accessibility = await new AxeBuilder({ page }).include(".quality-color-vision").analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("button", { name: "Standard colour", exact: true }).click();
  await expect(page.getByTestId("enhanced-image")).toHaveAttribute("src", appliedEvidence.url);
});

test("export prepares PNG, rejects implicit JPEG flattening and preserves WebP alpha", async ({ page }) => {
  const sourceBytes = flatCurvePng(48, true);
  await page.setViewportSize({ width: 1760, height: 980 });
  await page.goto("/image-quality?engine=deterministic");
  await page.locator('input[type="file"]').setInputFiles({
    name: "transparent export source.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await expect(page.getByText(/Original ready\. Enhance quality uses disclosed Restore processing/)).toBeVisible();
  await page.getByRole("button", { name: "Colour", exact: true }).click();
  await page.getByLabel("Temperature", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Apply colour" }).click();
  await expect(page.getByText(/Colour derivative ready/)).toBeVisible();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export image" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("48 × 48 px", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.getByText("Export verified and ready")).toBeVisible();
  let downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download verified file" }).click();
  let download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("transparent-export-source-export-48x48.png");
  let stream = await download.createReadStream();
  let chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  let downloaded = Buffer.concat(chunks);
  expect(downloaded.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(downloaded.readUInt32BE(16)).toBe(48);
  expect(downloaded.readUInt32BE(20)).toBe(48);

  await dialog.getByRole("radio", { name: /JPEG/ }).check();
  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.getByText(/contains transparent pixels.*white or black JPEG background/i)).toBeVisible();
  await dialog.getByLabel("Transparent pixels").selectOption("white");
  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.getByText("Export verified and ready")).toBeVisible();
  downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download verified file" }).click();
  download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("transparent-export-source-export-48x48-q92.jpg");
  stream = await download.createReadStream();
  chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  downloaded = Buffer.concat(chunks);
  expect(downloaded.subarray(0, 2).toString("hex")).toBe("ffd8");
  const jpegEvidence = await page.evaluate(async ({ bytes }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("JPEG verification canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    const corner = Array.from(context.getImageData(0, 0, 1, 1).data);
    const evidence = { width: bitmap.width, height: bitmap.height, corner };
    bitmap.close();
    return evidence;
  }, { bytes: Array.from(downloaded) });
  expect(jpegEvidence).toEqual({ width: 48, height: 48, corner: expect.arrayContaining([255]) });
  expect(jpegEvidence.corner[3]).toBe(255);

  await dialog.getByRole("radio", { name: /WEBP/ }).check();
  await dialog.getByLabel("Export quality", { exact: true }).fill("73");
  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.getByText("Export verified and ready")).toBeVisible();
  downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download verified file" }).click();
  download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("transparent-export-source-export-48x48-q73.webp");
  stream = await download.createReadStream();
  chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  downloaded = Buffer.concat(chunks);
  expect(downloaded.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(downloaded.subarray(8, 12).toString("ascii")).toBe("WEBP");
  const webpEvidence = await page.evaluate(async ({ bytes }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/webp" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("WebP verification canvas unavailable");
    context.drawImage(bitmap, 0, 0);
    const alpha = context.getImageData(0, 0, 1, 1).data[3];
    const evidence = { width: bitmap.width, height: bitmap.height, alpha };
    bitmap.close();
    return evidence;
  }, { bytes: Array.from(downloaded) });
  expect(webpEvidence).toEqual({ width: 48, height: 48, alpha: 0 });

  const accessibility = await new AxeBuilder({ page }).include(".quality-export-dialog").analyze();
  expect(accessibility.violations).toEqual([]);
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
