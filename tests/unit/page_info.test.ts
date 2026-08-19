import assert from 'node:assert/strict';
import test from 'node:test';
import { buildActiveTabQuery, pageInfoFromTab, requestPageInfoFromTab } from '../../src/background/page_info.ts';

const info = { available: true as const, title: 'Article', url: 'https://example.com/a', lang: 'en' };

test('scopes the active-tab lookup to the window that asked', () => {
	assert.deepEqual(buildActiveTabQuery({ windowId: 7 }), { active: true, windowId: 7 });
});

test('falls back to the current window when the request carries no window', () => {
	assert.deepEqual(buildActiveTabQuery(undefined), { active: true, currentWindow: true });
});

test('falls back to the current window for an unusable window id', () => {
	assert.deepEqual(buildActiveTabQuery({ windowId: '7' }), { active: true, currentWindow: true });
	assert.deepEqual(buildActiveTabQuery({ windowId: -1 }), { active: true, currentWindow: true });
	assert.deepEqual(buildActiveTabQuery({ windowId: 1.5 }), { active: true, currentWindow: true });
});

test('falls back to what the tab itself reports when no content script answers', () => {
	assert.deepEqual(pageInfoFromTab({ url: 'https://example.com/a', title: 'Bài viết' }), {
		available: true,
		title: 'Bài viết',
		url: 'https://example.com/a',
		// The tab carries no document language; 'na' is what the content script reports for that too.
		lang: 'na',
	});
});

test('reports an untitled tab by its address alone', () => {
	assert.deepEqual(pageInfoFromTab({ url: 'https://example.com/a' }), {
		available: true,
		title: '',
		url: 'https://example.com/a',
		lang: 'na',
	});
});

test('stays unavailable when the tab exposes no address', () => {
	assert.deepEqual(pageInfoFromTab({ title: 'Bài viết' }), { available: false });
	assert.deepEqual(pageInfoFromTab({ url: '' }), { available: false });
	assert.deepEqual(pageInfoFromTab({}), { available: false });
});

test('requests current-page metadata from the content script', async () => {
	assert.deepEqual(
		await requestPageInfoFromTab(42, {
			sendMessage: async (tabId, message) => {
				assert.equal(tabId, 42);
				assert.deepEqual(message, { action: 'GET_PAGE_INFO' });
				return info;
			},
			executeScript: async () => assert.fail('must not inject'),
		}),
		info,
	);
});

test('injects content_script.js and retries once for a missing receiver', async () => {
	let attempts = 0;
	let injections = 0;
	assert.deepEqual(
		await requestPageInfoFromTab(42, {
			sendMessage: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error('Receiving end does not exist');
				}
				return info;
			},
			executeScript: async () => {
				injections += 1;
			},
		}),
		info,
	);
	assert.equal(injections, 1);
});

test('rejects an unrelated send error without injecting', async () => {
	const error = new Error('The tab was closed.');
	let injections = 0;

	await assert.rejects(
		requestPageInfoFromTab(42, {
			sendMessage: async () => {
				throw error;
			},
			executeScript: async () => {
				injections += 1;
			},
		}),
		error,
	);
	assert.equal(injections, 0);
});

test('rejects the missing-receiver error when content-script injection fails', async () => {
	const missingReceiver = new Error('Receiving end does not exist');
	const injectionError = new Error('Cannot access contents of url');

	await assert.rejects(
		requestPageInfoFromTab(42, {
			sendMessage: async () => {
				throw missingReceiver;
			},
			executeScript: async () => {
				throw injectionError;
			},
		}),
		missingReceiver,
	);
});

test('rejects the retry error after injecting for a missing receiver', async () => {
	const missingReceiver = new Error('Receiving end does not exist');
	const retryError = new Error('The tab was closed.');
	let attempts = 0;

	await assert.rejects(
		requestPageInfoFromTab(42, {
			sendMessage: async () => {
				attempts += 1;
				throw attempts === 1 ? missingReceiver : retryError;
			},
			executeScript: async () => undefined,
		}),
		retryError,
	);
	assert.equal(attempts, 2);
});
