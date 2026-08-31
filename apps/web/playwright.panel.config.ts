import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  grep: /internal panel harness/,
  use: {
    baseURL: "http://127.0.0.1:4194",
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev --workspace ipw-web -- --host 127.0.0.1 --port 4194",
    cwd: "../..",
    port: 4194,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
