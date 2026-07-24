import type { BrowserContext } from '@playwright/test';

const EXTENSION_WAKE_URL = 'https://readit.test/extension-wakeup';

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

		const serviceWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
		if (serviceWorker) {
			const serviceWorkerUrl = new URL(serviceWorker.url());
			if (!serviceWorkerUrl.hostname) {
				throw new Error(`Không thể lấy Extension ID từ service worker: ${serviceWorker.url()}`);
			}
			return serviceWorkerUrl.hostname;
		}

		const infoEl = await wakePage.waitForSelector('#readit-dev-ext-info', { state: 'attached', timeout: 10000 });
		const markerExtensionId = await infoEl.getAttribute('data-extension-id');
		if (!markerExtensionId) {
			throw new Error('Không tìm thấy Extension ID từ service worker hoặc content-script marker.');
		}
		return markerExtensionId;
	} finally {
		await context.unroute(EXTENSION_WAKE_URL);
		await wakePage.close();
	}
}
