import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the app's own logic: the mappers that turn API JSON into what the
 * packages read, and the WebSocket adapter that carries terminal bytes.
 *
 * No browser and no SvelteKit runtime — everything under test here is deliberately
 * plain TypeScript, which is why the adapter takes an injectable socket factory and
 * the mappers take values rather than reading a store. Component behaviour is
 * verified where it can actually be seen: the Playwright specs in `tests/ui`.
 */
export default defineConfig({
  /**
   * The Svelte compiler, for the `.svelte.ts` modules only.
   *
   * Most of what is tested here is plain TypeScript by design (see above), but the
   * dashboard's stores are runes files: without this, `$state` is an undefined global
   * and importing one throws. No component is rendered here — that is what `tests/ui`
   * and `@pdmux/ui` are for.
   */
  plugins: [svelte()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Bun exposes `__esModule` on genuine ESM namespaces with an undefined
    // value. Vitest 4 otherwise applies CommonJS interop and loses named
    // exports such as Zod's `z` when a workspace package is imported.
    deps: { interopDefault: false },
  },
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      // The dashboard logic reads `browser` from here; see the stub for why it is false.
      "$app/env": fileURLToPath(new URL("./test/stubs/app-environment.ts", import.meta.url)),
    },
  },
});
