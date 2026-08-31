import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  snapshotPathTemplate: "{testDir}/../__screenshots__/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:4173",
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
        IPW_API_PORT: "8780",
        IPW_LOCAL_STORAGE_ROOT: resolve("test-results/private-storage"),
      },
      port: 8780,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npm run dev --workspace ipw-web -- --host 127.0.0.1 --port 4173",
      cwd: "../..",
      port: 4173,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
