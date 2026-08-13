import { defineConfig, devices } from '@playwright/test';

const AUDIO_LIFECYCLE_TEST = /resumes the same session after Chrome audio idle cutoff/;

/**
 * Playwright configuration for Chrome Extension E2E testing
 */
export default defineConfig({
	testDir: './tests/e2e',
	globalSetup: './tests/e2e/global_setup.ts',
	globalTeardown: './tests/e2e/global_teardown.ts',
	/* Maximum time one test can run for. */
	timeout: 30 * 1000,
	expect: {
		/**
		 * Maximum time expect() should wait for the condition to be met. Workers run several
		 * extension browsers at once, so a round trip through the background service worker can
		 * take considerably longer than it does when one browser has the machine to itself.
		 */
		timeout: 15_000,
	},
	/* Files run in parallel across workers; tests within one file stay ordered. */
	fullyParallel: false,
	/**
	 * Every test already gets its own profile directory, so parallelism is bounded by machine
	 * size rather than by isolation. Measured on a 12-core machine: 4 workers ran the suite clean
	 * twice at 5.4 min against 18.1 min serial, while Playwright's default of 6 reached 4.5 min
	 * but started dropping synthesized input events under the extra contention. CI runners have
	 * four cores, so they take a correspondingly smaller share.
	 */
	workers: process.env.CI ? 2 : 4,
	/* Fail the build on CI if you accidentally left test.only in the source code. */
	forbidOnly: !!process.env.CI,
	/* Retry on CI only */
	retries: process.env.CI ? 2 : 0,
	/* Reporter to use. See https://playwright.dev/docs/test-reporters */
	reporter: 'html',
	/* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
	use: {
		/* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
		trace: 'on-first-retry',
		/* Video recording options if needed */
		video: 'on-first-retry',
	},

	/* Configure projects for major browsers */
	projects: [
		{
			name: 'chromium',
			grepInvert: AUDIO_LIFECYCLE_TEST,
			use: {
				...devices['Desktop Chrome'],
			},
		},
		{
			name: 'chromium-cleanup',
			testMatch: /chromium_cleanup\.ts/,
			dependencies: ['chromium'],
		},
		{
			name: 'chromium-audio',
			testMatch: /reading-state\.spec\.ts/,
			grep: AUDIO_LIFECYCLE_TEST,
			dependencies: ['chromium-cleanup'],
			use: {
				...devices['Desktop Chrome'],
				headless: false,
			},
		},
	],
});
