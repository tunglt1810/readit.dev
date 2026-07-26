import { expect, test } from './fixtures';

const highlightRegistryName = 'readit-dev-word-highlight';

test.use({ freshExtensionWorker: true });

test('renders a word highlight during real article playback', async ({ context, extensionId }) => {
	const targetUrl = 'https://readit.test/word-highlight-real-playback';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body:
				'<!doctype html><html lang="en"><head><title>Highlight playback</title></head><body><article><h1>Highlight playback</h1><p>This article contains enough readable prose for extraction and must visibly highlight each spoken word while the reader progresses through the sentence without losing its ordered mapping to the live document.</p></article></body></html>',
		}),
	);

	const article = await context.newPage();
	await article.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await article.bringToFront();

	const response = await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }));
	expect(response).toEqual({ success: true });

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
