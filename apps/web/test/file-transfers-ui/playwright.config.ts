import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "pdmux-file-transfers.ui.spec.ts",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:5217", viewport: { width: 1280, height: 800 } },
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: "bunx --bun vite --config test/file-transfers-ui/vite.config.ts",
    url: "http://127.0.0.1:5217",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
