import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SvelteKit route modules may export only SvelteKit's own vocabulary.
 *
 * THE BUG THIS LOCKS DOWN: `+layout.server.ts` exported a `looksLikePhone` helper — put
 * there for no reason except that a unit test needed to import it. SvelteKit validates
 * the export list of every route module at request time and rejects anything outside its
 * vocabulary, so **`/hosts` answered 500** (`Invalid export 'looksLikePhone'`) while `/`
 * kept working, which is exactly the shape that survives a casual check.
 *
 * A helper a test wants to reach belongs in `$lib`, not in a route module.
 */

const ROUTES = new URL("../src/routes", import.meta.url).pathname;

/** What SvelteKit accepts, by module kind. */
const ALLOWED: Record<string, ReadonlySet<string>> = {
  server: new Set(["load", "actions", "prerender", "ssr", "csr", "trailingSlash", "config", "entries"]),
  universal: new Set(["load", "prerender", "ssr", "csr", "trailingSlash", "config", "entries"]),
};

function routeModules(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routeModules(full, found);
    } else if (/^\+(page|layout)(\.server)?\.ts$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/** Top-level `export function|const|class|let` names, plus `export { … }` lists. */
function exportedNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.push(match[1]!);
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1]!.split(",")) {
      const name = part.split(/\s+as\s+/).pop()!.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("[TC-PDWEB-008] a route module exports only what SvelteKit accepts", () => {
  it("finds route modules to check at all", () => {
    // A silent zero here would make every assertion below vacuous.
    expect(routeModules(ROUTES).length).toBeGreaterThan(3);
  });

  it("exports no helper from any +page/+layout module", () => {
    const offenders: string[] = [];
    for (const file of routeModules(ROUTES)) {
      const kind = file.endsWith(".server.ts") ? "server" : "universal";
      // `export type` / `export interface` are erased and never reach the validator.
      const source = readFileSync(file, "utf8").replace(/^export\s+(type|interface)\s.*$/gm, "");
      for (const name of exportedNames(source)) {
        if (!ALLOWED[kind]!.has(name)) offenders.push(`${file.slice(ROUTES.length + 1)} exports '${name}'`);
      }
    }
    expect(offenders, "move these into $lib — a route module answers 500 for a stray export").toEqual([]);
  });
});
