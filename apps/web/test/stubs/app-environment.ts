/**
 * `$app/environment` for the node test runner.
 *
 * The unit tests here run without a SvelteKit runtime, so the one module the dashboard
 * logic reads from it is stubbed rather than pulling the framework in. `browser: false`
 * is the honest value: there is no `window`, and the code paths that need one (the
 * localStorage layout cache) are guarded by exactly this flag.
 */
export const browser = false;
export const building = false;
export const dev = true;
export const version = "test";
