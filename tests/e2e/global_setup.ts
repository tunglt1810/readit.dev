import { chromium, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { MODEL_FILES } from '../../src/shared/constants';
import { resolveExtensionId } from './extension_id';
import { MODEL_CACHE_SEED_DIR, MODEL_CACHE_SEED_MARKER } from './model_cache_seed';

const MODEL_URLS = Object.values(MODEL_FILES);
// The six model files total ~400 MB; a generous ceiling tolerates slow/throttled
// network conditions since this is a one-time cost cached across test runs.
const SEED_TIMEOUT_MS = 900_000;

function isSeedFresh(): boolean {
	if (!fs.existsSync(MODEL_CACHE_SEED_MARKER)) {
		return false;
	}
	try {
		const marker = JSON.parse(fs.readFileSync(MODEL_CACHE_SEED_MARKER, 'utf8')) as { modelUrls?: string[] };
		return JSON.stringify(marker.modelUrls) === JSON.stringify(MODEL_URLS);
	} catch (_error) {
		return false;
	}
}

async function waitForModelsCached(page: Page): Promise<void> {
	const deadline = Date.now() + SEED_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const allCached = await page.evaluate(async (urls) => {
			const cache = await caches.open('supertonic-models');
			const results = await Promise.all(urls.map((url) => cache.match(url)));
			return results.every((response) => response !== undefined);
		}, MODEL_URLS);
		if (allCached) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error('Timed out waiting for Supertonic model files to warm into Cache Storage during e2e global setup.');
}

/**
 * Downloads the real Supertonic model files into a reusable Chrome profile
 * once, so per-test profiles (see fixtures.ts) can clone it instead of each
 * triggering their own ~400 MB download. Without this, the background
 * auto-warm cache (and any lazy per-Play model load) races real network I/O
 * against short e2e assertion timeouts and is unreliable. See
 * docs/plans/2026-07-24-e2e-model-cache-seed-fix.md for the full rationale.
 */
export default async function globalSetup(): Promise<void> {
	if (isSeedFresh()) {
		return;
	}

	fs.rmSync(MODEL_CACHE_SEED_DIR, { recursive: true, force: true });
	fs.mkdirSync(MODEL_CACHE_SEED_DIR, { recursive: true });

	const pathToExtension = path.join(process.cwd(), 'dist');
	const context = await chromium.launchPersistentContext(MODEL_CACHE_SEED_DIR, {
		channel: 'chromium',
		headless: true,
		args: [
			`--disable-extensions-except=${pathToExtension}`,
			`--load-extension=${pathToExtension}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-sync',
		],
	});

	try {
		const extensionId = await resolveExtensionId(context);
		const page = await context.newPage();
		await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await waitForModelsCached(page);
	} finally {
		await context.close();
	}

	fs.writeFileSync(MODEL_CACHE_SEED_MARKER, JSON.stringify({ modelUrls: MODEL_URLS }, null, 2));
}
