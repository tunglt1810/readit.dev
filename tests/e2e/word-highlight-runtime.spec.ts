import type { PlaybackStateResponse } from '../../src/shared/types';
import { expect, test } from './fixtures';

const highlightRegistryName = 'readit-dev-word-highlight';

test.use({ freshExtensionWorker: true });

test('renders a word highlight during real article playback', async ({ context, extensionId }) => {
	test.setTimeout(300_000);
	const targetUrl = 'https://readit.test/word-highlight-real-playback';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: '<!doctype html><html lang="en"><head><title>Highlight playback</title></head><body><article><h1>Highlight playback</h1><p>This article contains enough readable prose for extraction and must visibly highlight each spoken word while the reader progresses through the sentence without losing its ordered mapping to the live document.</p></article></body></html>',
		}),
	);

	const article = await context.newPage();
	await article.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await article.bringToFront();

	await expect
		.poll(
			async () => {
				try {
					return await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }));
				} catch (_err) {
					return null;
				}
			},
			{ timeout: 10_000 },
		)
		.toEqual({ success: true });

	await expect
		.poll(
			async () => {
				const state = await sender.evaluate(
					() => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }) as Promise<PlaybackStateResponse>,
				);
				return state.session?.status ?? null;
			},
			{ timeout: 240_000 },
		)
		.toBe('playing');

	await expect
		.poll(
			() =>
				article.evaluate((name) => {
					const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
					const [range] = highlight ? [...highlight] : [];
					return range?.toString() ?? null;
				}, highlightRegistryName),
			{ timeout: 20_000 },
		)
		.not.toBeNull();
});

test('does not initialize a projection for Google Docs text-only playback', async ({ context, extensionId }) => {
	const documentUrl = 'https://docs.google.com/document/d/no-surface-doc/edit?tab=t.0';
	await context.route('https://docs.google.com/document/d/no-surface-doc/edit**', (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: '<html lang="en"><head><title>Text-only Google Doc</title></head><body><div role="application"></div></body></html>',
		}),
	);
	await context.route(/\/document\/d\/no-surface-doc\/export\?format=txt$/, (route) =>
		route.fulfill({
			contentType: 'text/plain; charset=utf-8',
			body: 'This exported document has enough text for local speech playback without projecting highlights into the editor surface.',
		}),
	);

	const documentPage = await context.newPage();
	await documentPage.goto(documentUrl, { waitUntil: 'domcontentloaded' });
	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await sender.evaluate(() => {
		(window as any).surfaceLifecycleMessages = [];
		chrome.runtime.onMessage.addListener((message) => {
			if (message?.action === 'WORD_HIGHLIGHT_INIT') {
				(window as any).surfaceLifecycleMessages.push(message);
			}
		});
	});
	await documentPage.bringToFront();

	await expect(sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }))).resolves.toEqual({
		success: true,
	});
	expect(await sender.evaluate(() => (window as any).surfaceLifecycleMessages)).toEqual([]);
});
