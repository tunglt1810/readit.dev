// The panel used to take `<html lang>` at face value before playback, so a Vietnamese article on a
// page declaring English listed English voices until the first paragraph was already speaking. This
// drives the real content script on a real page, which the panel's own specs mock past.
import { expect, test } from './fixtures';

const VIETNAMESE = Array.from(
	{ length: 6 },
	(_, index) =>
		`<p>Đoạn ${index}. Trí tuệ nhân tạo đang thay đổi cách con người tiếp cận tri thức mỗi ngày, ` +
		'và nhiều công cụ mới ra đời khiến việc theo kịp trở nên khó khăn hơn trước rất nhiều.</p>',
).join('');
const ENGLISH = Array.from(
	{ length: 6 },
	(_, index) =>
		`<p>Paragraph ${index}. Romantic rejection activates the same brain regions implicated in ` +
		'physical pain, which is why the experience feels bodily rather than merely emotional.</p>',
).join('');

async function pageLanguageOf(context: import('@playwright/test').BrowserContext, url: string, lang: string, body: string) {
	await context.route(url, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="${lang}"><head><title>Bài viết</title></head><body><article>${body}</article></body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(url);
	return page;
}

test('reads the language off the page itself, not off its declaration', async ({ context }) => {
	const url = 'https://readit.test/page-language-vi';
	const page = await pageLanguageOf(context, url, 'en', VIETNAMESE);

	const worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
	const info = await worker?.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ url: 'https://readit.test/page-language-vi' });
		return chrome.tabs.sendMessage(tab.id as number, { action: 'GET_PAGE_INFO' });
	});

	expect(info).toMatchObject({ lang: 'vi', langSource: 'detected' });
	await page.close();
});

test('keeps a declaration the page text agrees with', async ({ context }) => {
	const url = 'https://readit.test/page-language-en';
	const page = await pageLanguageOf(context, url, 'en', ENGLISH);

	const worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
	const info = await worker?.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ url: 'https://readit.test/page-language-en' });
		return chrome.tabs.sendMessage(tab.id as number, { action: 'GET_PAGE_INFO' });
	});

	expect(info).toMatchObject({ lang: 'en', langSource: 'detected' });
	await page.close();
});
