import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The app must SAY which theme it resolved, in both directions.
 *
 * ⚠ `@pdmux/ui` follows a `.dark` or `.light` class on an ancestor and the OS only when
 * neither is there (an installer without a class system still gets dark from the OS).
 * mode-watcher adds `dark` by default but no class at all for light, which leaves "the
 * person chose light" indistinguishable from "nobody chose" — and on a dark OS the
 * package then painted pastel names on the app's white card.
 */
describe("[TC-PDUI-233] the app names its resolved theme for the package", () => {
  const source = readFileSync(new URL("../src/lib/components/site-runtime.svelte", import.meta.url), "utf8");

  it("mounts mode-watcher with a light class as well as the dark one", () => {
    const tag = source.match(/<ModeWatcher\b[^>]*\/>/)?.[0] ?? "";
    expect(tag, "the ModeWatcher mount").not.toBe("");
    expect(tag).toMatch(/lightClassNames=\{\[\s*"light"\s*\]\}/);
    // `dark` stays mode-watcher's default; overriding it would break the app's own
    // `@custom-variant dark` and PodoKit's `:root.dark` theme overrides.
    expect(tag).not.toMatch(/darkClassNames=/);
  });
});
