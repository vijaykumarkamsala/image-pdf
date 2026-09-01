import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const databaseUrl = process.env["IPW_TEST_DATABASE_URL"];
if (!databaseUrl) throw new Error("IPW_TEST_DATABASE_URL is required for Recovery 2D real-stack acceptance");
const storageRoot = resolve("test-results/recovery-2d-private-storage");
process.env["IPW_RECOVERY_2D_STORAGE_ROOT"] = storageRoot;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.real.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  outputDir: "test-results/recovery-2d-real",
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run build --workspace ipw-api && npm run start --workspace ipw-api",
      cwd: "../..",
      env: {
        ...process.env,
        NODE_ENV: "development",
        IPW_DEV_IDENTITY_ENABLED: "1",
        IPW_API_PORT: "8782",
        IPW_DATABASE_URL: databaseUrl,
        IPW_DATABASE_MIGRATE: "1",
        IPW_LOCAL_STORAGE_ROOT: storageRoot,
        IPW_EXTERNAL_DETERMINISTIC_WORKER: "1",
      },
      port: 8782,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run build --workspace ipw-web && npm run preview --workspace ipw-web -- --host 127.0.0.1 --port 4175",
      cwd: "../..",
      env: { ...process.env, IPW_API_ORIGIN: "http://127.0.0.1:8782" },
      port: 4175,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
