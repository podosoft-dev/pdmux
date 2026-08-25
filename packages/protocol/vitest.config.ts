import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    deps: {
      // Bun exposes CommonJS default exports directly; wrapping them again makes
      // `import { z } from "zod"` resolve against the wrong object in Vitest.
      interopDefault: false,
    },
  },
});
