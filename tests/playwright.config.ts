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

/**
 * Mobile coverage is two ENGINES, not two phones.
 *
 * The layout bugs this suite pins are CSS-structural (they break identically
 * everywhere), but the things that differ between phones are engine-level: the soft
 * keyboard's effect on the viewport, pull-to-refresh, the back button. So one Blink
 * project stands in for Chrome/Edge/Samsung Internet and one WebKit project stands in
 * for every browser on iOS.
 *
 * WebKit is **opt-in** with `PDMUX_WEBKIT=1`, following the same pattern as the UI
 * package's browser tests. It needs its own download AND ~20 system libraries (GTK4,
 * GStreamer, libavif, enchant …) that a plain server does not carry, so including it by
 * default would fail the run for a reason that is the machine's state rather than a
 * defect in the product. Presence of the binary is not enough to detect this — the
 * download succeeds and only the launch fails — so the switch is explicit rather than
 * probed.
 */
const mobileProjects = [
  {
    name: "ui-mobile",
    testMatch: /.*\.mobile\.spec\.ts/,
    dependencies: ["setup"],
    use: { ...devices["Pixel 7"], storageState: "playwright/.auth/admin.json" },
  },
  ...(process.env.PDMUX_WEBKIT === "1"
    ? [
        {
          name: "ui-mobile-webkit",
          testMatch: /.*\.mobile\.spec\.ts/,
          dependencies: ["setup"],
          use: { ...devices["iPhone 14"], storageState: "playwright/.auth/admin.json" },
        },
      ]
    : []),
];

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  // 30s is tight for a serial suite on a machine that is also somebody's
  // workstation: the failures it produced were timeouts in hydration-heavy
  // dialogs, not product defects. The budget is per test, so a healthy run costs
  // nothing extra.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  // One retry locally, two in CI. The suite drives a *shared* backend serially:
  // a handful of the inherited specs toggle global auth settings, and one of them
  // occasionally reads the previous value while the auth instance rebuilds. The
  // real races found this way were fixed (see helpers/auth-config.ts and the
  // hydration-aware retries); this covers the residue rather than letting a
  // known-order-sensitive spec fail the whole run. pdmux's own specs
  // (pdmux-*.ui.spec.ts) pass without retries.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [
    { name: "api", testMatch: /.*\.api\.spec\.ts/, dependencies: ["setup"] },
    /**
     * `setup` seeds sessions AND snapshots the dashboard layout of the account the browser
     * projects sign in as; its `teardown` puts that layout back once every dependent project
     * has finished, including after a failure. The specs restore what they change, so a green
     * run needs none of this — it exists because a run that died half way used to leave
     * somebody's screen rearranged ("my 4-split became a 9-split").
     */
    { name: "setup", testMatch: /.*\.setup\.ts/, teardown: "restore-layout" },
    { name: "restore-layout", testMatch: /layout-restore\.teardown\.ts/ },
    {
      name: "ui",
      testMatch: /.*\.ui\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: "playwright/.auth/admin.json" },
    },
    ...mobileProjects,
  ],
});
