import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    deps: {
      // Keep Vitest from applying Node's synthetic default wrapper a second time
      // when the suite runs under Bun.
      interopDefault: false,
    },
  },
});
