import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte(), tailwindcss(), {
    name: "transfer-download-fixture",
    configureServer(server): void {
      // Chromium download attributes bypass page.route (Playwright issue 22650).
      // Serve a real attachment from the isolated harness instead.
      server.middlewares.use((request, response, next): void => {
        if (!/^\/api\/hosts\/[^/]+\/file-transfers\/[^/]+\/download$/.test(request.url ?? "")) { next(); return; }
        const zip = Buffer.alloc(22);
        zip.writeUInt32LE(0x06054b50);
        response.setHeader("Content-Type", "application/zip");
        response.setHeader("Content-Disposition", 'attachment; filename="files.zip"');
        response.setHeader("Content-Length", zip.length);
        response.end(zip);
      });
    },
  }],
  resolve: { alias: {
    "#lib": fileURLToPath(new URL("../../src/lib", import.meta.url)),
    "$app/state": fileURLToPath(new URL("./page.ts", import.meta.url)),
    "$app/env": fileURLToPath(new URL("../stubs/app-environment.ts", import.meta.url)),
  } },
  server: { host: "127.0.0.1", port: 5217, strictPort: true },
});
