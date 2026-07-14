import { chromium } from '@playwright/test';

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const reportDir = join(root, '.tmp', 'vietnamese-performance');
const extensionDir = join(reportDir, 'extension');
const profileDir = join(reportDir, 'profile');
mkdirSync(reportDir, { recursive: true });
rmSync(profileDir, { recursive: true, force: true });

const build = spawnSync('pnpm', ['exec', 'rsbuild', 'build'], {
	cwd: root,
	env: { ...process.env, READIT_VI_BENCHMARK: '1' },
	stdio: 'inherit',
});
if (build.status !== 0) {
	process.exit(build.status ?? 1);
}

const context = await chromium.launchPersistentContext(profileDir, {
	headless: false,
	args: [
		`--disable-extensions-except=${extensionDir}`,
		`--load-extension=${extensionDir}`,
		'--no-first-run',
		'--no-default-browser-check',
	],
});
try {
	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
	const extensionId = new URL(worker.url()).hostname;
	const page = await context.newPage();
	const observedRuntimeRequests = new Set();
	page.on('request', (request) => {
		const url = request.url();
		if (/\.(?:mjs|wasm)(?:$|\?)/u.test(url)) {
			observedRuntimeRequests.add(new URL(url).pathname.split('/').at(-1));
		}
	});
	page.on('console', (message) => process.stderr.write(`[benchmark page] ${message.text()}\n`));
	page.on('requestfailed', (request) =>
		process.stderr.write(`[benchmark failed request] ${request.url()} ${request.failure()?.errorText ?? ''}\n`),
	);
	await page.goto(`chrome-extension://${extensionId}/src/offscreen/offscreen.html`);
	const result = await page.evaluate(() => globalThis.__READIT_VI_BENCHMARK__);
	const report = {
		generatedAt: new Date().toISOString(),
		browserVersion: await context.browser()?.version(),
		platform: process.platform,
		productionNumThreads: 1,
		threadDecision: 'keep-single-threaded-until-full-cpu-tts-benchmark-proves-at-least-15-percent',
		...result,
		ortRuntimeRequests: [...new Set([...(result.ortRuntimeRequests ?? []), ...observedRuntimeRequests])].filter(Boolean).sort(),
	};
	writeFileSync(join(reportDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
	await context.close();
}
