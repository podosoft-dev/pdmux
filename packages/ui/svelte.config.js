import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Preprocessing only — this package ships components, not an app, so there is no
 * adapter and no SvelteKit here. `vitePreprocess` is what lets the components use
 * `<script lang="ts">`.
 *
 * ⚠ THIS FILE IS PASSED TO `svelte-check` EXPLICITLY (`--config`, see `package.json`), and
 * that is not decoration. `svelte-check` picks a config PER DIRECTORY, walking up from each
 * `.svelte` file and preferring a `vite.config.*` over a `svelte.config.*` in the same
 * folder. `test/geometry/` has one — the dev server for the browser geometry harness — so
 * `Harness.svelte` bound to it, and the extraction then failed outright:
 *
 *   ERROR "test/geometry/Harness.svelte" 1:1 "No Svelte configuration found in vite config.
 *   Is @sveltejs/vite-plugin-svelte configured?"
 *
 * The harness config DOES configure the plugin. The mismatch is a version one, and worth
 * writing down because the message accuses the wrong file: `svelte-check` 4.7.3 bundles
 * `@sveltejs/load-config` 0.2.1, which finds the options by looking for a resolved plugin
 * named **`vite-plugin-svelte:config`** — a name that only exists in vite-plugin-svelte v5.
 * This package is on v4, which emits `vite-plugin-svelte`, so the lookup returns undefined
 * and `bun run lint` failed on a file with nothing wrong with it. Upgrading the plugin means
 * Vite 6 and a vitest bump with it, which is not a trade this harness is worth.
 *
 * Naming this file explicitly is also just true: it IS the config for every `.svelte` in the
 * package, and an explicit one wins for every file under it — so a future nested
 * `vite.config.*` cannot bring the failure back.
 *
 * @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig}
 */
export default {
	preprocess: vitePreprocess(),
};
