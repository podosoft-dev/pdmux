import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Browser geometry checks — OPT-IN.
 *
 * They need a browser binary, so they are gated behind `PDMUX_BROWSER_TEST=1`
 * (`bun run --cwd packages/ui test:geometry` sets it). Without the flag no dev server is
 * started and every spec skips, so a plain `playwright test` in CI cannot fail on a
 * missing download.
 */
const enabled = Boolean(process.env.PDMUX_BROWSER_TEST);
/**
 * Escape hatch for a machine that already has a browser: `PDMUX_BROWSER_CHANNEL=chrome`
 * runs against the installed Google Chrome instead of downloading Playwright's own
 * build (`bunx playwright install chromium`).
 */
const channel = process.env.PDMUX_BROWSER_CHANNEL;

export default defineConfig({
	testDir: './geometry',
	testMatch: /.*\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:5199',
		...devices['Desktop Chrome'],
		viewport: { width: 1280, height: 800 },
		...(channel ? { channel } : {}),
	},
	...(enabled
		? {
				webServer: {
					// Playwright defaults to this config's directory, not Bun's working
					// directory. Pin the package root for the command's relative paths.
					cwd: fileURLToPath(new URL('../', import.meta.url)),
					//
					// ⚠ `--host 127.0.0.1` IS NOT OPTIONAL, AND ITS ABSENCE FAILED AS A
					// TIMEOUT RATHER THAN AS AN ERROR. On this Mac vite's default bind
					// resolves to IPv6 only — `lsof` shows `TCP [::1]:5199` and nothing on
					// 127.0.0.1 — so the `url` below could never be reached and the run died
					// with "Timed out waiting 60000ms from config.webServer", which reads as
					// a slow machine. Naming the address makes the server bind where this
					// config already says to look, on either stack.
					command: 'bunx vite --config test/geometry/vite.config.ts --host 127.0.0.1',
					url: 'http://127.0.0.1:5199',
					reuseExistingServer: true,
					timeout: 60_000,
				},
			}
		: {}),
});
