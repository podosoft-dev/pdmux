import { defineConfig, devices } from '@playwright/test';

/**
 * Browser geometry checks — OPT-IN.
 *
 * They need a browser binary, so they are gated behind `PDMUX_BROWSER_TEST=1`
 * (`npm run test:geometry -w @pdmux/ui` sets it). Without the flag no dev server is
 * started and every spec skips, so a plain `playwright test` in CI cannot fail on a
 * missing download.
 */
const enabled = Boolean(process.env.PDMUX_BROWSER_TEST);
/**
 * Escape hatch for a machine that already has a browser: `PDMUX_BROWSER_CHANNEL=chrome`
 * runs against the installed Google Chrome instead of downloading Playwright's own
 * build (`npx playwright install chromium`).
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
					// Paths are resolved from the package root, which is where npm runs the
					// script from.
					command: 'npx vite --config test/geometry/vite.config.ts',
					url: 'http://127.0.0.1:5199',
					reuseExistingServer: true,
					timeout: 60_000,
				},
			}
		: {}),
});
