import { defineConfig, devices } from '@playwright/test';

/**
 * The terminal latency bench — OPT-IN and MANUAL.
 *
 * ⚠ NOT PART OF ANY SUITE, on purpose. It measures wall-clock time on the machine it
 * runs on, so a threshold that passes here fails on a busy laptop and passes on an
 * idle server regardless of the code. It is a reproduction tool: run it, read the
 * table, write the numbers down. `test:geometry` is the gate; this is the microscope.
 */
const enabled = Boolean(process.env.PDMUX_BROWSER_TEST);
const channel = process.env.PDMUX_BROWSER_CHANNEL;

export default defineConfig({
	testDir: './bench',
	testMatch: /.*\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	// A retry would average two runs of a timing measurement into nonsense.
	retries: 0,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:5198',
		...devices['Desktop Chrome'],
		viewport: { width: 1440, height: 900 },
		...(channel ? { channel } : {}),
	},
	...(enabled
		? {
				webServer: {
					command: 'bunx vite --config test/bench/vite.config.ts',
					url: 'http://127.0.0.1:5198',
					reuseExistingServer: true,
					timeout: 60_000,
				},
			}
		: {}),
});
