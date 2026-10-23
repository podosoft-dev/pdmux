import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { previewAsset } from "./preview-assets.ts";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Keep fixture optimization separate from the live application and consume freshly built packages.
  cacheDir: "node_modules/.vite-file-transfers",
  optimizeDeps: { force: true },
  plugins: [svelte(), tailwindcss(), {
    name: "transfer-download-fixture",
    configureServer(server): void {
      // Chromium download attributes bypass page.route (Playwright issue 22650).
      // Serve a real attachment from the isolated harness instead.
      server.middlewares.use((request, response, next): void => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (/\/files\/download$/.test(url.pathname)) {
          const name = (url.searchParams.get("path") ?? "").split("/").pop() ?? "";
          const asset = previewAsset(name);
          if (!asset) { response.statusCode = 404; response.end(); return; }
          const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ""));
          const start = Number(range?.[1] ?? 0); const end = Math.min(asset.bytes.length - 1, Number(range?.[2] || asset.bytes.length - 1));
          response.statusCode = range ? 206 : 200;
          response.setHeader("Content-Type", asset.mime); response.setHeader("Accept-Ranges", "bytes");
          response.setHeader("Content-Length", end - start + 1);
          response.setHeader("Content-Disposition", `${url.searchParams.has("inline") ? "inline" : "attachment"}; filename="${name}"`);
          if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${asset.bytes.length}`);
          response.end(asset.bytes.subarray(start, end + 1)); return;
        }
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
  // Linked local packages must stay under node_modules so Vite prebundles their CommonJS exports.
  resolve: { preserveSymlinks: true, alias: {
    "#lib": fileURLToPath(new URL("../../src/lib", import.meta.url)),
    "$app/state": fileURLToPath(new URL("./page.ts", import.meta.url)),
    "$app/env": fileURLToPath(new URL("../stubs/app-environment.ts", import.meta.url)),
  } },
  server: { host: "127.0.0.1", port: 5217, strictPort: true },
});
