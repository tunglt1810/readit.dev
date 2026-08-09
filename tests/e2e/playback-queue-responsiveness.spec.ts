import { expect, test } from './fixtures';

const SELECTION = 'Hello there. Second sentence here.';

/**
 * Regression guard for a freeze that made every surface look dead after a context-menu start.
 * `startPlayback` used to await the model warm and `chrome.offscreen.createDocument` while holding
 * the single background command lane, so a `GET_PLAYBACK_STATE` from an already-open Side Panel took
 * more than 8 seconds to answer and PAUSE/STOP were unusable for that whole window.
 */
test('answers a state read while a start is still loading the offscreen document', async ({ context, page, extensionId }) => {
	await page.goto('data:text/html,<p>Hello there. Second sentence here.</p>');

	let [worker] = context.serviceWorkers();
	if (!worker) {
		worker = await context.waitForEvent('serviceworker');
	}
	const tab = await worker.evaluate(async () => {
		const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
		return { id: active.id as number, windowId: active.windowId as number };
	});

	const panel = await context.newPage();
	await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
	await panel.evaluate(() => {
		(window as unknown as { __statuses: (string | null)[] }).__statuses = [];
		chrome.runtime.onMessage.addListener((message: { action?: string; session?: { status?: string } | null }) => {
			if (message?.action === 'PLAYBACK_STATE_UPDATE') {
				(window as unknown as { __statuses: (string | null)[] }).__statuses.push(message.session?.status ?? null);
			}
		});
	});
	await page.bringToFront();

	// Cold-start offscreen creation really does take seconds (onnxruntime plus a ~24 MB wasm), but how
	// long is environment-dependent. Pinning it makes the assertions below deterministic: they fail
	// whenever this wait is taken while the session lane is held.
	const OFFSCREEN_SETUP_MS = 3000;
	await worker.evaluate((delayMs) => {
		const create = chrome.offscreen.createDocument.bind(chrome.offscreen);
		chrome.offscreen.createDocument = async (options: chrome.offscreen.CreateParameters) => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			await create(options);
		};
	}, OFFSCREEN_SETUP_MS);

	await worker.evaluate(
		({ selection, target }) => {
			chrome.contextMenus.onClicked.dispatch(
				{ menuItemId: 'readit-read-selection', selectionText: selection, pageUrl: 'https://example.test/a' },
				{ id: target.id, windowId: target.windowId, url: 'https://example.test/a', title: 'Doc' },
			);
		},
		{ selection: SELECTION, target: tab },
	);

	const latencyOf = (action: string) =>
		panel.evaluate(
			(requested) =>
				new Promise<number>((resolve) => {
					const started = Date.now();
					const timer = setTimeout(() => resolve(Number.POSITIVE_INFINITY), 5000);
					chrome.runtime.sendMessage({ action: requested }, () => {
						clearTimeout(timer);
						resolve(Date.now() - started);
					});
				}),
			action,
		);

	// A state read shares the session lane with every session transition, so it only stays fast while
	// the start's model warm and offscreen setup run detached from that lane.
	expect(await latencyOf('GET_PLAYBACK_STATE')).toBeLessThan(1000);

	await expect
		.poll(() => panel.evaluate(() => (window as unknown as { __statuses: (string | null)[] }).__statuses), { timeout: 10_000 })
		.toContain('loading');
});
