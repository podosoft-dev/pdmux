import { defineConfig, devices } from "@playwright/test";
import { loadPlaywrightProjects } from "./playwright.extensions";

// admin-dashboard overlay: adds a `setup` project that seeds admin/user sessions
// (storageState) which the `ui` project reuses. Serial + single worker because
// tests share one backend/DB. Runs against a live stack on E2E_BASE_URL.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5001";
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
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [...coreProjects, ...loadPlaywrightProjects(coreProjects)],
});
