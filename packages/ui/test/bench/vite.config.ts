import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/** Dev server for the terminal latency bench only — it ships nothing.
 *  Port 5198 so it can run beside the geometry harness on 5199. */
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [svelte()],
	// ⚠ `host` IS EXPLICIT. Vite's default binds localhost, which resolves to ::1
	// here — so the config's `http://127.0.0.1:5198` health check never answers and
	// Playwright waits out its full timeout with no error to show for it.
	server: { host: '127.0.0.1', port: 5198, strictPort: true },
});
