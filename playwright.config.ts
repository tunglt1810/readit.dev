import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Chrome Extension E2E testing
 */
export default defineConfig({
	testDir: './tests/e2e',
	/* Maximum time one test can run for. */
	timeout: 30 * 1000,
	expect: {
		/**
		 * Maximum time expect() should wait for the condition to be met.
		 * For example in `await expect(locator).toBeVisible();`
		 */
		timeout: 5000,
	},
	/* Run tests in files in parallel */
	fullyParallel: false,
	/* Fail the build on CI if you accidentally left test.only in the source code. */
	forbidOnly: !!process.env.CI,
	/* Retry on CI only */
	retries: process.env.CI ? 2 : 0,
	/* Run tests sequentially to avoid Chrome profile locks when using local Chrome */
	workers: 1,
	/* Reporter to use. See https://playwright.dev/docs/test-reporters */
	reporter: 'html',
	/* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
	use: {
		/* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
		trace: 'on-first-retry',
		/* Video recording options if needed */
		video: 'on-first-retry',
		launchOptions: {
			args: ['--start-minimized'],
		},
		locale: 'vi-VN',
	},

	/* Configure projects for major browsers */
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
			},
		},
	],
});
