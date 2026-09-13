import { defineConfig, devices } from "@playwright/test";

/** Owns an ephemeral SQLite stack and agent container; never uses E2E_BASE_URL. */
export default defineConfig({
  testDir: "./readiness",
  testMatch: /.*\.runtime\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], screenshot: "only-on-failure" },
});
