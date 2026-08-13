import type { BrowserContext } from '@playwright/test';

const EXTENSION_WAKE_URL = 'https://readit.test/extension-wakeup';

/**
 * Extension startup competes with every other worker's Chrome for CPU and disk, so an unpacked
 * MV3 extension can take far longer to come up than it does when one browser starts at a time.
 */
const EXTENSION_STARTUP_TIMEOUT_MS = 45_000;

/**
 * The service worker is frequently not registered yet at the instant the wake page finishes
 * loading, so a single check of `serviceWorkers()` reports a healthy extension as missing.
 */
async function waitForExtensionServiceWorker(context: BrowserContext) {
	const started = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
	if (started) {
		return started;
	}
	return context
		.waitForEvent('serviceworker', {
			predicate: (worker) => worker.url().startsWith('chrome-extension://'),
			timeout: EXTENSION_STARTUP_TIMEOUT_MS,
		})
		.catch(() => null);
}

/**
 * Discovers the loaded extension's chrome-extension:// id by waking its
 * service worker (or falling back to a content-script marker) via a
 * fixture-controlled navigation. Shared by the per-test `context` fixture
 * and the one-time model-cache seeding in global_setup.ts.
 */
export async function resolveExtensionId(context: BrowserContext): Promise<string> {
	const wakePage = await context.newPage();
	try {
		await context.route(EXTENSION_WAKE_URL, (route) =>
			route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Extension wakeup</body></html>' }),
		);
		await wakePage.goto(EXTENSION_WAKE_URL, { waitUntil: 'domcontentloaded' });

		const serviceWorker = await waitForExtensionServiceWorker(context);
		if (serviceWorker) {
			const serviceWorkerUrl = new URL(serviceWorker.url());
			if (!serviceWorkerUrl.hostname) {
				throw new Error(`Không thể lấy Extension ID từ service worker: ${serviceWorker.url()}`);
			}
			return serviceWorkerUrl.hostname;
		}

		const infoEl = await wakePage.waitForSelector('#readit-dev-ext-info', { state: 'attached', timeout: EXTENSION_STARTUP_TIMEOUT_MS });
		const markerExtensionId = await infoEl.getAttribute('data-extension-id');
		if (!markerExtensionId) {
			throw new Error('Không tìm thấy Extension ID từ service worker hoặc content-script marker.');
		}
		await wakePage.goto(`chrome-extension://${markerExtensionId}/src/popup/popup.html`);
		await wakePage.waitForFunction(
			async () => {
				try {
					const response = await chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' });
					return response !== undefined;
				} catch {
					return false;
				}
			},
			undefined,
			{ timeout: EXTENSION_STARTUP_TIMEOUT_MS },
		);
		return markerExtensionId;
	} finally {
		await context.unroute(EXTENSION_WAKE_URL);
		await wakePage.close();
	}
}
