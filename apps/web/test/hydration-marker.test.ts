import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync(new URL("../src/routes/+layout.svelte", import.meta.url), "utf8");

describe("browser hydration signal", () => {
  it("[TC-PDWEB-032] marks the document only from a client-side effect", () => {
    expect(layout).toContain("$effect(() =>");
    expect(layout).toContain('document.documentElement.dataset.hydrated = "true"');
    expect(layout).toContain("delete document.documentElement.dataset.hydrated");
  });
});
