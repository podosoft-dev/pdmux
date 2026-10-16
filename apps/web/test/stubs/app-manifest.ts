/**
 * `$app/manifest` for the node test runner.
 *
 * Like `app-environment.ts`, this stands in for a module the SvelteKit runtime
 * generates. `hooks.server.ts` looks up the matched route here to tell a `+page`
 * from a `+server` under `APP_ASSET_PATHS`. With no routes listed, every route is
 * treated as one that may render a page, so the hook loads the session and site
 * settings — the behaviour `src/hooks.server.test.ts` exercises.
 */
export const immutable: Array<{ path: string }> = [];
export const assets: Array<{ path: string }> = [];
export const prerendered: Array<{ path: string }> = [];
export const routes: Array<{ id: string; page: boolean; endpoint: boolean }> = [];
