import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A message with a placeholder must go through `fmt()`.
 *
 * THE BUG THIS LOCKS DOWN: `dash.enroll.title` is `"Install the agent on {label}"` — a
 * DIALOG TITLE — and it was interpolated straight into a button as `{i18n.t.dash.enroll.title}`.
 * The card's settings panel then offered a button reading literally
 * "{label} 에 에이전트 설치". Nothing failed: the string is real, the key exists, and the
 * only thing wrong is that the placeholder was never substituted.
 *
 * So this walks the markup for direct interpolations of a catalogue key and fails when the
 * value behind it carries a placeholder. Either pass it through `fmt(...)` with the value,
 * or — usually the better answer for a button — use the short label that has no
 * placeholder, the way `enroll.menu` sits beside `enroll.title`.
 */

const WEB = new URL("..", import.meta.url).pathname;
const CATALOGS = ["src/lib/i18n/catalogs/app/en.json", "src/lib/i18n/catalogs/app/ko.json"];

/**
 * Messages whose braces are LITERAL, not placeholders.
 *
 * A hint that teaches a template syntax has to show the braces — substituting them is what
 * would break it ("Optional. 127.0.0.1 and 8080 are replaced." says nothing). Kept as an
 * explicit list so adding one is a decision rather than a widening of the rule.
 */
const LITERAL_BRACES = new Set([
  // Explains what to type into the service URL field, where `{address}`/`{port}` are the
  // syntax the product itself substitutes later, on the server.
  "dash.services.urlTemplateHint",
]);

function flatten(node: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (!node || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

function svelteFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFiles(full, found);
    else if (entry.endsWith(".svelte")) found.push(full);
  }
  return found;
}

/** Catalogue keys interpolated directly into markup, i.e. `{i18n.t.a.b}` and not `fmt(...)`. */
function directKeys(source: string): string[] {
  const keys: string[] = [];
  // `{i18n.t.dash.enroll.title}` — a lone interpolation with nothing wrapping it. A call
  // like `fmt(i18n.t.x.y, {...})` does not match, which is exactly the distinction.
  for (const match of source.matchAll(/\{\s*i18n\.t\.([A-Za-z0-9_.]+)\s*\}/g)) {
    keys.push(match[1]!);
  }
  // Attribute form: `title={i18n.t.a.b}` is caught by the same shape above.
  return keys;
}

describe("[TC-PDWEB-009] a message with a placeholder is never rendered raw", () => {
  const messages = flatten(JSON.parse(readFileSync(join(WEB, CATALOGS[0]!), "utf8")));

  it("finds catalogue entries and markup to check at all", () => {
    // A silent zero on either side would make the assertion below vacuous.
    expect(Object.keys(messages).length).toBeGreaterThan(50);
    expect(svelteFiles(join(WEB, "src")).length).toBeGreaterThan(5);
  });

  it("every catalogue key is spelled the same in both locales", () => {
    // A placeholder present in one locale and missing from the other is the same bug with
    // a narrower blast radius — it only shows for some readers.
    const ko = flatten(JSON.parse(readFileSync(join(WEB, CATALOGS[1]!), "utf8")));
    const mismatched = Object.keys(messages).filter((key) => {
      const a = (messages[key]!.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(",");
      const b = ((ko[key] ?? "").match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(",");
      return a !== b;
    });
    expect(mismatched, "these keys carry different placeholders per locale").toEqual([]);
  });

  it("no component interpolates a templated message without formatting it", () => {
    const offenders: string[] = [];
    for (const file of svelteFiles(join(WEB, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const key of directKeys(source)) {
        const value = messages[key];
        if (value === undefined) continue; // not a leaf, or a computed path
        if (LITERAL_BRACES.has(key)) continue;
        if (/\{[a-zA-Z0-9_]+\}/.test(value)) {
          offenders.push(`${file.slice(WEB.length)} renders '${key}' raw: ${JSON.stringify(value)}`);
        }
      }
    }
    expect(offenders, "pass these through fmt(), or use the placeholder-free label").toEqual([]);
  });
});
