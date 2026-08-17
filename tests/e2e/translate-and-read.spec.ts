import type { PlaybackStateResponse } from '../../src/shared/types';
import { expect, installTranslatorStub, installWorkerTranslatorStub, test } from './fixtures';

/**
 * Bundled Chromium has no built-in AI, so the real Translator can never run here. These tests
 * cover the wiring around it: whether the button appears, whether the worker swaps the content and
 * the surface, and whether it degrades to reading the original when the API is missing. Whether
 * Chrome's translation is any good is verified by hand.
 */

const ARTICLE_URL = 'https://readit.test/translate-and-read';
const ENGLISH_PARAGRAPH =
	'The committee met to review the transport proposal. It recommended three programs over eighteen months, and asked the department to report back in the second quarter of the year.';
const VIETNAMESE_PARAGRAPH =
	'Ủy ban đã họp để xem xét đề xuất giao thông. Ủy ban khuyến nghị ba chương trình trong mười tám tháng, và yêu cầu sở báo cáo lại vào quý hai của năm.';

async function routeArticle(context: import('@playwright/test').BrowserContext): Promise<void> {
	await context.route(ARTICLE_URL, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body:
				'<!doctype html><html lang="en"><head><title>Transport proposal</title></head><body><article>' +
				`<h1>Transport proposal</h1><p>${ENGLISH_PARAGRAPH}</p>` +
				'</article></body></html>',
		}),
	);
}

async function readSession(sender: import('@playwright/test').Page) {
	const state = await sender.evaluate(
		() => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }) as Promise<PlaybackStateResponse>,
	);
	return state.session;
}

test('hides the button when the browser has no Translator', async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await expect(popup.locator('.btn-translate-read')).toHaveCount(0);
});

test('offers the button when the Translator is available', async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await installTranslatorStub(popup);
	await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await expect(popup.locator('.btn-translate-read')).toBeVisible();
});

test('offers the target language in the configuration card, defaulting to Vietnamese', async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await installTranslatorStub(popup);
	await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

	// The control belongs beside the other reading preferences, not behind the pronunciation
	// dictionary link, which is where a user would never look for it.
	const target = popup.locator('.translation-target-setting select');
	await expect(target).toHaveValue('vi');
	await expect(target.locator('option')).toHaveCount(3);
});

test('hides the target language when the browser cannot translate', async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await expect(popup.locator('.settings-card')).toBeVisible();
	await expect(popup.locator('.translation-target-setting')).toHaveCount(0);
});

test('reads the translated text in the Document Reader', async ({ context, extensionId }) => {
	await routeArticle(context);
	const article = await context.newPage();
	await article.goto(ARTICLE_URL, { waitUntil: 'domcontentloaded' });

	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await installWorkerTranslatorStub(context, { [ENGLISH_PARAGRAPH]: VIETNAMESE_PARAGRAPH });
	await article.bringToFront();

	// Registered before the command, because the reader tab opens as part of starting.
	const readerOpened = context.waitForEvent('page', {
		predicate: (page) => page.url().includes('/src/reader/reader.html'),
		timeout: 20_000,
	});

	await expect
		.poll(
			async () => {
				try {
					return await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE_TRANSLATED' }));
				} catch (_error) {
					return null;
				}
			},
			{ timeout: 15_000 },
		)
		.toEqual({ success: true, translated: true });

	// A translation can never be highlighted onto the English page, so the session must have moved
	// to the Document Reader and adopted the target language.
	await expect.poll(async () => (await readSession(sender))?.lang, { timeout: 15_000 }).toBe('vi');
	expect((await readSession(sender))?.readableSurface).toBe('document-reader');

	// And the reader has to actually open: it is the only surface the translation exists on, so
	// leaving it closed means audio with nothing highlighted anywhere.
	const reader = await readerOpened;
	await expect
		.poll(
			async () =>
				reader
					.locator('article')
					.innerText()
					.catch(() => ''),
			{ timeout: 20_000 },
		)
		.toContain('Ủy ban');
});

test('tells the reader when a translated session cannot be prepared', async ({ context, extensionId }) => {
	await routeArticle(context);
	const article = await context.newPage();
	await article.goto(ARTICLE_URL, { waitUntil: 'domcontentloaded' });

	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	// A single token longer than the synthesis limit has nowhere to split, so preparation fails after
	// the reader already holds the translated text: the document renders, and then nothing is ever
	// spoken or highlighted.
	await installWorkerTranslatorStub(context, { [ENGLISH_PARAGRAPH]: 'ủ'.repeat(400) });

	// Opened up front because a failing session announces itself once; a reader still booting when
	// that happens has nothing to render. Closing that race is tracked separately.
	const reader = await context.newPage();
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
	await expect(reader.locator('.document-reader')).toBeVisible();
	await article.bringToFront();

	await expect
		.poll(
			async () => {
				try {
					return await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE_TRANSLATED' }));
				} catch (_error) {
					return null;
				}
			},
			{ timeout: 15_000 },
		)
		.toEqual({ success: true, translated: true });

	// Without this the reader shows a normal-looking document that never speaks, and the popup that
	// would carry the message is closed the moment the reader takes the foreground.
	await expect(reader.locator('.document-reader-playback-error')).toBeVisible({ timeout: 20_000 });
});

test('leaves the reader closed when nothing was translated', async ({ context, extensionId }) => {
	await routeArticle(context);
	const article = await context.newPage();
	await article.goto(ARTICLE_URL, { waitUntil: 'domcontentloaded' });

	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await article.bringToFront();

	await expect
		.poll(
			async () => {
				try {
					return await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE_TRANSLATED' }));
				} catch (_error) {
					return null;
				}
			},
			{ timeout: 15_000 },
		)
		.toEqual({ success: true, translated: false });

	// The page is being read on the page itself, so opening a reader tab would be noise.
	await sender.waitForTimeout(2_000);
	expect(context.pages().filter((page) => page.url().includes('/src/reader/reader.html'))).toHaveLength(0);
});

test('reads the original when the browser cannot translate', async ({ context, extensionId }) => {
	await routeArticle(context);
	const article = await context.newPage();
	await article.goto(ARTICLE_URL, { waitUntil: 'domcontentloaded' });

	const sender = await context.newPage();
	await sender.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await article.bringToFront();

	await expect
		.poll(
			async () => {
				try {
					return await sender.evaluate(() => chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE_TRANSLATED' }));
				} catch (_error) {
					return null;
				}
			},
			{ timeout: 15_000 },
		)
		.toEqual({ success: true, translated: false });

	// No Translator in this worker: the request succeeds and the page is read untranslated, on the
	// page itself, rather than failing. `translated: false` is what the caller turns into a notice.
	await expect.poll(async () => (await readSession(sender))?.lang, { timeout: 15_000 }).toBe('en');
	expect((await readSession(sender))?.readableSurface).toBe('website-dom');
});
