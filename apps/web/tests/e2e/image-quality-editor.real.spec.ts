import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { expect, test } from "@playwright/test";

const fixture = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
  "data/fixtures/images/synthetic-noise-64.png",
);

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

function flatCurvePng(size: number): Buffer {
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

test("image quality editor uploads, processes, compares, resets and downloads real pixels", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
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
  await page.goto("/image-quality");
  await page.locator('input[type="file"]').setInputFiles(fixture);

  await expect(page).toHaveURL(/\/image-quality\/editor$/);
  await expect(page.getByTestId("image-quality-editor")).toBeVisible();
  await expect(page.getByRole("heading", { name: "synthetic-noise-64.png" })).toBeVisible();
  await expect(page.getByText("64 × 64 px")).toBeVisible();
  await expect(page.getByText("Original ready. Choose a strength and enhance quality.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __qualityWorkerCount: number }).__qualityWorkerCount)).toBe(1);

  const original = page.getByTestId("original-image");
  const originalUrl = await original.getAttribute("src");
  expect(originalUrl).toMatch(/^blob:/);
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \(Real-ESRGAN General x4v3 · WebGPU\)/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("256 × 256 px")).toBeVisible();

  const enhanced = page.getByTestId("enhanced-image");
  const enhancedUrl = await enhanced.getAttribute("src");
  expect(enhancedUrl).toMatch(/^blob:/);
  expect(enhancedUrl).not.toBe(originalUrl);
  await expect(enhanced).toHaveCSS("filter", "none");

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
  expect(pixelEvidence.width).toBe(256);
  expect(pixelEvidence.height).toBe(256);
  expect(pixelEvidence.changed).toBe(true);
  expect(pixelEvidence.meanRgbDifference).toBeGreaterThan(5);
  expect(pixelEvidence.materiallyChangedFraction).toBeGreaterThan(0.9);

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
  await expect(page.getByText("Original ready. Choose a strength and enhance quality.")).toBeVisible();

  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \(Real-ESRGAN General x4v3 · WebGPU\)/)).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: testInfo.outputPath("image-quality-editor.png"), fullPage: true });
  const finalUrl = await page.getByTestId("enhanced-image").getAttribute("src");
  const expectedDigest = await page.evaluate(async (url) => {
    const bytes = await (await fetch(url!)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }, finalUrl);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download enhanced image" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("synthetic-noise-64-enhanced.png");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(expectedDigest);
  await page.screenshot({ path: testInfo.outputPath("image-quality-editor.png"), fullPage: true });
  await page.goto("about:blank");
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
  await expect(page.getByText("Original ready. Choose a strength and enhance quality.")).toBeVisible();
  await page.locator('input[type="range"]').fill("100");
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \(Background-aware Bézier reconstruction · Worker\)/)).toBeVisible();
  await expect(page.getByText("256 × 256 px")).toBeVisible();
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
    }
    return {
      maximum,
      minimum,
      falseBackgroundMarks,
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
  expect(evidence.transparentFraction).toBeLessThan(0.02);
  await expect(page.getByTestId("enhanced-image")).toHaveCSS("filter", "none");
  await page.getByRole("button", { name: "400%" }).click();
  await page.screenshot({ path: testInfo.outputPath("flat-vector-comparison.png"), fullPage: true });
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
  await expect(page.getByText("Original ready. Choose a strength and enhance quality.")).toBeVisible();
  await page.getByRole("button", { name: "Enhance quality" }).click();
  await expect(page.getByText(/Enhanced image ready \(Background-aware Bézier reconstruction · Worker\)/)).toBeVisible({ timeout: 180_000 });
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
