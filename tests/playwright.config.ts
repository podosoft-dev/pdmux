import { defineConfig, devices } from "@playwright/test";
import { e2eWorkers, loadPlaywrightProjects, withExclusivePhase } from "./playwright.extensions";

// admin-dashboard overlay: adds a `setup` project that seeds admin/user sessions
// (storageState) which the `ui` project reuses, and a `cleanup` project that
// removes the users the suite created. Runs against a live stack on
// E2E_BASE_URL. Tests share one backend and database: E2E_WORKERS sets the
// worker count (default 1), and tests tagged @exclusive, which change state the
// others rely on, run one at a time in `<project>-exclusive` twins after the
// others (see playwright.extensions.ts). Each file runs on one worker in order.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const workers = e2eWorkers();
const coreProjects = [
  { name: "api", testMatch: /.*\.api\.spec\.ts/, dependencies: ["setup"] },
  { name: "setup", testMatch: /.*\.setup\.ts/, teardown: "cleanup" },
  { name: "cleanup", testMatch: /.*\.teardown\.ts/ },
  {
    name: "ui",
    testMatch: /.*\.ui\.spec\.ts/,
    dependencies: ["setup"],
    use: { ...devices["Desktop Chrome"], storageState: "playwright/.auth/admin.json" },
  },
];

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  globalSetup: "./playwright.extensions.ts",
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: withExclusivePhase([...coreProjects, ...loadPlaywrightProjects(coreProjects)], workers),
});
