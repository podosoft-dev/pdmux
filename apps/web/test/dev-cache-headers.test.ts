import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import config from "../vite.config";

/**
 * The dev server may never tell a browser to cache something it cannot be told to drop.
 *
 * ⚠ THIS IS A USER-FACING CONTRACT EVEN THOUGH IT ONLY APPLIES IN DEVELOPMENT, because this
 * deployment's dashboard is reached from real phones through a public URL while it runs the
 * dev server. Reported 2026-07-28 from an iPhone: the page painted once and then showed 500,
 * on a device with no hard reload to fall back on.
 *
 * The chain, measured: every optimized dep is served as `<name>.js?v=<hash of its own
 * content>` with `Cache-Control: max-age=31536000,immutable`. `immutable` means the browser
 * may use its copy for a YEAR without asking again — and the bytes it holds embed
 * `chunk-XXXX.js?v=<that generation>`, whose names move on every re-optimize. The browser
 * was asking for `chunk-QD4NIDXJ.js?v=26e4905b` while the server served that chunk at
 * `?v=220aff9f`; the import resolved to undefined and hydration died on
 * `Cannot read properties of undefined (reading 'call')`.
 *
 * Nothing served afterwards can reach such a browser — that is what `immutable` means. The
 * only escape was renaming `cacheDir` so every dep URL changed at once.
 *
 * ⚠ WHY A UNIT TEST AND NOT A LIVE ONE. A live assertion would have to run against a dev
 * server to be true, and the same assertion is WRONG against the built app — a production
 * container SHOULD serve fingerprinted assets as immutable, and that is the deployment that
 * actually serves users (`docs/OPERATIONS.md` §1). Testing the mechanism instead keeps the
 * claim exactly as narrow as it should be, and it fails the moment somebody drops the plugin.
 */

const PRODUCTION_STYLE = "max-age=31536000,immutable";

/** The plugin under test, found the way vite finds it: by name, in the config's own list. */
function devCachePlugin(): Plugin {
  const plugins = (config as { plugins?: unknown }).plugins;
  const flat = (Array.isArray(plugins) ? plugins : []).flat(Infinity) as Plugin[];
  const found = flat.find((plugin) => plugin?.name === "pdmux-no-immutable-dev-cache");
  expect(found, "the dev cache-header plugin is gone from vite.config.ts").toBeTruthy();
  return found as Plugin;
}

/**
 * Run the plugin's `configureServer` and hand back the middleware it installed, plus a
 * response object whose `setHeader` calls are recorded.
 */
function headersAfterMiddleware(): { set: (name: string, value: string) => void; seen: Map<string, unknown> } {
  const seen = new Map<string, unknown>();
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null = null;
  const server = {
    middlewares: {
      use: (fn: (req: unknown, res: unknown, next: () => void) => void) => {
        middleware = fn;
      },
    },
  };

  const hook = devCachePlugin().configureServer;
  const run = typeof hook === "function" ? hook : hook?.handler;
  expect(run, "configureServer is not callable").toBeTruthy();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (run as (s: unknown) => void).call(null, server as any);
  expect(middleware, "the plugin installed no middleware").toBeTruthy();

  const res = {
    setHeader(name: string, value: unknown) {
      seen.set(name.toLowerCase(), value);
      return res;
    },
  };
  let nexted = false;
  (middleware as unknown as (req: unknown, res: unknown, next: () => void) => void)({}, res, () => {
    nexted = true;
  });
  expect(nexted, "the middleware never called next() — every dev request would hang").toBe(true);

  return { set: (name, value) => res.setHeader(name, value), seen };
}

describe("[TC-PDWEB-016] the dev server never hands out immutable caching", () => {
  it("downgrades an immutable Cache-Control to no-cache", () => {
    const { set, seen } = headersAfterMiddleware();
    set("Cache-Control", PRODUCTION_STYLE);
    // `no-cache` rather than `no-store`: the browser keeps its copy and still gets a 304
    // when nothing changed, so the cost is a conditional request, not a re-download. What
    // it loses is the right to skip asking, which is the whole defect.
    expect(seen.get("cache-control")).toBe("no-cache");
  });

  it("catches the header whatever case vite spells it in", () => {
    const { set, seen } = headersAfterMiddleware();
    set("cache-control", PRODUCTION_STYLE);
    expect(seen.get("cache-control")).toBe("no-cache");
  });

  it("leaves every other header, and every other cache policy, alone", () => {
    const { set, seen } = headersAfterMiddleware();
    set("Content-Type", "application/javascript");
    set("Etag", 'W/"abc"');
    // Vite's own `no-cache` for source modules must pass through untouched — rewriting it
    // would be a second, silent policy change riding on a fix for a different one.
    set("Cache-Control", "no-cache");
    expect(seen.get("content-type")).toBe("application/javascript");
    expect(seen.get("etag")).toBe('W/"abc"');
    expect(seen.get("cache-control")).toBe("no-cache");
  });

  it("only applies while serving, never to a build", () => {
    // A built container SHOULD serve fingerprinted assets as immutable — that is the
    // deployment users actually reach. `apply: "serve"` is what keeps this dev-only.
    expect(devCachePlugin().apply).toBe("serve");
  });

  it("keeps the dep graph from moving under an open browser", () => {
    /**
     * The other half of the same incident: a dependency vite discovers late triggers a
     * re-optimize a few seconds into every start, which mints new chunk names and strands
     * whoever loaded during that window. `zod` is reached only through another package's
     * import, so the first scan misses it unless it is named here.
     */
    const optimize = (config as { optimizeDeps?: { include?: string[]; exclude?: string[] } }).optimizeDeps;
    expect(optimize?.include, "zod must be pre-bundled up front or the hash moves on every start").toContain("zod");
    // The workspace packages stay excluded for the reason documented in vite.config.ts.
    for (const linked of ["@pdmux/core", "@pdmux/ui", "@pdmux/protocol"]) {
      expect(optimize?.exclude).toContain(linked);
    }
  });
});
