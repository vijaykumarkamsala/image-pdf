import { defineConfig } from "@playwright/test";

// Test-only browser selection; never changes model approval or production authority.
const imageQualityChannel = process.env["IPW_PLAYWRIGHT_IMAGE_QUALITY_CHANNEL"] ?? "chrome";
if (imageQualityChannel !== "chrome" && imageQualityChannel !== "chromium") {
  throw new Error("IPW_PLAYWRIGHT_IMAGE_QUALITY_CHANNEL must be chrome or chromium");
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "image-quality-editor.real.spec.ts",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: process.env["IPW_PLAYWRIGHT_BASE_URL"] ?? "http://127.0.0.1:4317",
    browserName: "chromium",
    channel: imageQualityChannel,
    launchOptions: { args: ["--enable-unsafe-webgpu"] },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
});
