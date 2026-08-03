import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/** Dev server for the browser geometry harness only — it ships nothing. */
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [svelte()],
	server: { port: 5199, strictPort: true },
});
