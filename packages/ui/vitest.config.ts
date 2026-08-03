import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * Component tests run in jsdom, which has no layout engine: they cover props,
 * rendering, callbacks and empty states. Anything about POSITION or SIZE belongs in
 * the browser spec under `test/geometry` — a DOM assertion cannot see that an
 * element is drawn outside the viewport, which is exactly how a layout bug survived
 * three rounds of "fixes" in the product this package generalises.
 */
export default defineConfig({
	plugins: [svelte({ hot: false })],
	resolve: {
		// Components are compiled from source here, so the browser condition must win
		// over the default node one (which would give a server-rendering build).
		conditions: ['browser'],
	},
	test: {
		environment: 'jsdom',
		include: ['test/**/*.test.ts'],
		globals: false,
		restoreMocks: true,
	},
});
