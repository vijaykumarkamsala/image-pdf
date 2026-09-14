import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const fixture = resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
  "data/fixtures/images/synthetic-noise-64.png",
);

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
  await expect(page.getByText(/AI-restored image ready \(Real-ESRGAN General x4v3 · WebGPU\)/)).toBeVisible({ timeout: 120_000 });
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
  await expect(page.getByText(/AI-restored image ready \(Real-ESRGAN General x4v3 · WebGPU\)/)).toBeVisible({ timeout: 120_000 });
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
