import { defineConfig, devices } from "@playwright/test";
import { e2eRunSettings, loadPlaywrightProjects, withExclusivePhase } from "./playwright.extensions";

// admin-dashboard overlay: adds a `setup` project that seeds admin/user sessions
// (storageState) which the `ui` project reuses, and a `cleanup` project that
// removes the users the suite created. Runs against a live stack on
// E2E_BASE_URL. Tests share one backend and database: E2E_WORKERS sets the
// worker count (default 1), and tests tagged @exclusive, which change state the
// others rely on, run one at a time in `<project>-exclusive` twins after the
// others, in a second run when run-e2e.ts starts the suite on more workers (see
// playwright.extensions.ts). Each file runs on one worker in order.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const run = e2eRunSettings();
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
  workers: run.workers,
  outputDir: run.outputDir,
  globalSetup: "./playwright.extensions.ts",
  reporter: [["list"], ["html", { open: "never", outputFolder: run.reportFolder }]],
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: withExclusivePhase([...coreProjects, ...loadPlaywrightProjects(coreProjects)], run.workers, run.phase),
});
