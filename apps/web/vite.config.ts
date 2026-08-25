import { readFileSync } from "node:fs";
import adapter from "@sveltejs/adapter-bun";
import { fileURLToPath } from "node:url";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { type Plugin, defineConfig, loadEnv } from "vite";

// pdmux's own SemVer, inlined at build time so the running app can say what it is.
// The ROOT package.json is the repo version — the one the changelog and the release
// tag agree on — and reading it here keeps the number in exactly one file. The agent
// has a SEPARATE version (agent/internal/cli/version.go) on purpose; do not conflate
// them, or a web-only release marks every host outdated.
const repoVersion = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: string;
  }
).version;

// Inside the dev container, bind to all interfaces and accept local gateway or
// HTTPS tunnel hostnames. Vite derives HMR's protocol, host, and port from the
// browser origin so the same configuration works for both entry points.
const inDocker = process.env.VITE_DOCKER === "1";
const publicOrigin = process.env.PODOKIT_BUILD_ORIGIN;

// A WebSocket upgrade is the one thing that cannot go through a SvelteKit server
// route: `+server.ts` handlers answer HTTP requests and never see the upgrade. Vite
// proxies these two in development so the caller keeps dialling its own origin, which
// is what makes the session cookie authenticate the terminal socket — and what lets an
// agent reach the API's gateway through the public origin it was pointed at.
//
// In production the packaged edge gateway routes the same exact paths directly to
// the API. This proxy is the development equivalent. Keep both path lists in step:
// a path added here and not to Caddy/k3s works in development and is dead once built.
const backendOrigin = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:5002";
const upgradeProxy = {
  "/terminal/ws": { target: backendOrigin.replace(/^http/, "ws"), ws: true },
  "/agent/ws": { target: backendOrigin.replace(/^http/, "ws"), ws: true },
};

/**
 * Never let the dev server tell a browser to cache anything for a year.
 *
 * ⚠ THIS IS THE OTHER HALF OF THE `optimizeDeps.exclude` NOTE BELOW, AND IT IS THE HALF
 * THAT REACHED A REAL USER'S PHONE.
 *
 * Excluding the workspace packages stopped a REBUILD from minting a new `browserHash`. It
 * does nothing about the other ways that hash moves: a new dependency getting optimized
 * (`zod`, observed 2026-07-28), or the dep cache being cleared during a restart. And every
 * optimized dep is served as `<file>?v=<browserHash>` with:
 *
 *     Cache-Control: max-age=31536000,immutable      (measured)
 *
 * `immutable` means the browser may use its copy for a YEAR without ever asking again. That
 * is sound on a laptop, where the hash only moves while you are looking at it. Through a
 * public URL it is not: a phone that loaded the page once holds that graph, the hash moves
 * here, and the two are mixed on the next visit — two copies of the Svelte runtime, and
 * hydration dies in the instance where `init_operations()` never ran. The page paints once
 * and then shows 500, and NOTHING the server does afterwards reaches that browser, because
 * it has been told not to ask.
 *
 * Reported from an iPhone, where there is no "hard reload" to fall back on. Telling a user
 * to clear their cache is not a fix — this is.
 *
 * So `immutable` is downgraded to `no-cache` for dev responses. The browser still keeps its
 * copy and still gets a 304 when nothing changed, so the cost is one conditional request per
 * module rather than a re-download; what it loses is the right to skip asking. Vite's own
 * issue for this is vitejs/vite#4736 — the dev server not sending `no-store` is a known
 * hazard, and this is the narrow version of that fix (revalidate, don't re-download).
 *
 * ⚠ THIS DOES NOT RESCUE A BROWSER THAT IS ALREADY HOLDING AN IMMUTABLE COPY — nothing
 * served can, by definition. Recovery is to mint a hash it has never seen: clear
 * `node_modules/.vite` and restart, which makes every URL new to it.
 *
 * ⚠ AND IT IS NOT A LICENCE TO SERVE `vite dev` TO REAL USERS. A dev page is ~293 module
 * requests where a production build is ~10, and every one of them is a chance to be stale
 * or to be redirected by an auth gateway. This removes the sharpest edge; the actual answer
 * for a public hostname is a built app.
 */
const revalidateInDev: Plugin = {
  name: "pdmux-no-immutable-dev-cache",
  apply: "serve",
  configureServer(server) {
    // Installed BEFORE vite's own middlewares (this hook returns nothing rather than a
    // thunk), so the wrapper is already in place when the transform middleware sets its
    // header — wrapping `setHeader` is what makes this independent of which middleware
    // decides to cache, now or after a vite upgrade.
    server.middlewares.use((_req, res, next) => {
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) =>
        setHeader(
          name,
          name.toLowerCase() === "cache-control" && String(value).includes("immutable") ? "no-cache" : value,
        );
      next();
    });
  },
};

/**
 * Extra hostnames the dev server will answer to, from `DEV_ALLOWED_HOSTS`
 * (comma-separated; a leading dot means "and its subdomains", Vite's own spelling).
 *
 * WHY IT IS NEEDED: Vite refuses a request whose Host header it does not recognise —
 * a DNS-rebinding defence that is right for a dev server on a laptop. But a pdmux
 * dashboard is routinely reached through a tunnel on a real hostname, and the refusal
 * arrives as a bare "Blocked request. This host is not allowed." with a 403, which
 * reads as the app being broken rather than as a host allowlist doing its job.
 *
 * It stays opt-in and per-deployment rather than `allowedHosts: true`, so the
 * protection is only lifted for names somebody named.
 */
/**
 * ⚠ READ FROM `.env` HERE, NOT JUST `process.env`.
 *
 * A Vite config is loaded before anything else and does NOT get the `.env` file that
 * SvelteKit later hands the application — so a value that is plainly present in `.env`
 * is simply absent here unless it was exported into the shell first. The failure is
 * loud in the worst way: the dev server comes up fine, and every request through the
 * tunnel gets `Blocked request. This host is not allowed`, which reads as the app being
 * broken. It happened twice — after a manual restart, and again after a reboot brought
 * the server back without the export.
 *
 * `loadEnv` is Vite's own reader for exactly this. The shell still wins when it defines
 * the variable, so a one-off override works; otherwise the checked-in `.env` is enough
 * and a bare `bun run dev` is correct from any shell.
 */
const fileEnv = loadEnv(process.env.NODE_ENV ?? "development", fileURLToPath(new URL("../..", import.meta.url)), "");
const devAllowedHosts = (process.env.DEV_ALLOWED_HOSTS ?? fileEnv.DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter((host) => host !== "");

export default defineConfig({
  /**
   * ⚠ THE DIRECTORY NAME IS LOAD-BEARING. RENAME IT TO EVICT A POISONED BROWSER.
   *
   * Optimized deps are served from this directory, so its name is part of every dep URL.
   * That is the only lever that can rescue a browser which cached those URLs before the
   * `immutable` downgrade above existed, and it is worth writing down why nothing else can:
   *
   *   - a dep's URL is `<name>.js?v=<hash of its own content>`, so it does NOT change when
   *     anything else does — the poisoned browser asks for exactly the URL it already has;
   *   - its cached copy was served `immutable`, so it never revalidates and the fresh bytes
   *     on this server are never seen;
   *   - the bytes it holds embed `chunk-XXXX.js?v=<that generation>`, and those chunk names
   *     move on every re-optimize. The result is a dep entry pointing at chunks that no
   *     longer exist: the import resolves to undefined and hydration dies on
   *     `Cannot read properties of undefined (reading 'call')`.
   *   - `Clear-Site-Data: "cache"` would work on Chrome and Firefox and NOT on Safari or
   *     anything on iOS, which is where this was reported from.
   *
   * Renaming the directory changes every dep URL at once, so a poisoned browser has nothing
   * cached under the new names and fetches clean — no cache clearing asked of the user, on
   * any platform. Bump the suffix again if this is ever needed a third time.
   *
   * Rotated on 2026-07-28 (`.vite` -> `.vite-2`) after an iPhone and a desktop Chrome were
   * both stuck on a pre-fix generation.
   */
  cacheDir: "node_modules/.vite-2",
  plugins: [
    revalidateInDev,
    tailwindcss(),
    sveltekit({
      adapter: adapter(),
      preprocess: vitePreprocess(),
      ...(publicOrigin ? { paths: { origin: publicOrigin } } : {}),
    }),
  ],
  // Read through `$lib/version.ts`, which is the only module that names it.
  define: { __PDMUX_VERSION__: JSON.stringify(repoVersion ?? "") },
  /**
   * The workspace packages are never pre-bundled.
   *
   * WHY, measured rather than guessed: `@pdmux/core` and `@pdmux/ui` are source-linked
   * and are rebuilt while the dev server runs. Each rebuild made vite re-optimize its
   * dependencies, which mints a new `browserHash` — the `?v=` on every optimized dep
   * URL. A browser tab that was already open keeps requesting the OLD hash, and vite
   * serves the file anyway (the parameter is only a cache-buster), so the tab ends up
   * with new chunk bytes mixed into an old module graph. Two copies of the Svelte
   * runtime then exist: hydration runs in the instance where `init_operations()` never
   * did, and dies on `first_child_getter` being undefined — "the page paints once and
   * goes blank", with a hash that keeps changing under it.
   *
   * Observed on 2026-07-27: the cache sat at `browserHash: b0b3c555` while the open tab
   * was still asking for `?v=7f71ef82`, three rebuilds behind. A fresh tab was always
   * fine, which is what made it look environmental for hours.
   *
   * Excluding them means a rebuild changes nothing about the dep graph: they are served
   * as ordinary source modules, no `?v=`, no re-optimization, nothing to strand.
   */
  /**
   * ⚠ `include` IS NOT A PERFORMANCE TWEAK HERE — IT STOPS THE HASH MOVING.
   *
   * `zod` is reached only through a dependency's own import, so vite does not find it in
   * its first scan. It discovers it on the first request that needs it, re-optimizes, and
   * logs:
   *
   *     ✨ new dependencies optimized: zod
   *     ✨ optimized dependencies changed. reloading
   *
   * That second pass mints a NEW `browserHash`, i.e. a new `?v=` on every optimized dep
   * URL — on EVERY server start, a few seconds in. A browser that loaded during those few
   * seconds is left pointing at the previous graph, which is the stranding this file's
   * other two notes are about. Naming it here means one optimize pass and one hash.
   *
   * If another `new dependencies optimized:` line ever appears in the dev log, add that
   * name here too rather than treating the reload as cosmetic.
   */
  optimizeDeps: { include: ["zod"], exclude: ["@pdmux/core", "@pdmux/ui", "@pdmux/protocol"] },
  server: inDocker
    ? {
        host: true,
        port: 5001,
        allowedHosts: true,
        proxy: upgradeProxy,
      }
    : {
        port: 5001,
        // Fail rather than silently move to 5002 — which is the API's port, and a web
        // app answering there would be a genuinely confusing half-hour.
        strictPort: true,
        /**
         * Naming external hostnames IS the statement that this dev server is reached
         * from somewhere else, so it also decides the bind address. Vite listens on
         * localhost only by default, which is right for a laptop but silently drops
         * every reverse proxy and container bridge in front of it — a host agent
         * dialling through one simply stops connecting, with nothing in any log to
         * say the port moved. With no `DEV_ALLOWED_HOSTS` the safe default stands.
         */
        host: devAllowedHosts.length > 0,
        proxy: upgradeProxy,
        ...(devAllowedHosts.length > 0 ? { allowedHosts: devAllowedHosts } : {}),
      },
});
