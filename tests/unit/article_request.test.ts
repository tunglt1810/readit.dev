import assert from 'node:assert/strict';
import test from 'node:test';
import { requestArticleFromTab } from '../../src/background/article_request.ts';

const article = {
	title: 'Test article',
	content: 'Article content',
	url: 'https://example.com/article',
	lang: 'en',
};

function missingReceiverError() {
	return new Error('Could not establish connection. Receiving end does not exist.');
}

test('injects the content script and retries once when the receiver is missing', async () => {
	let sendAttempts = 0;
	const injections: unknown[] = [];

	const result = await requestArticleFromTab(42, {
		sendMessage: async (tabId, message) => {
			assert.equal(tabId, 42);
			assert.deepEqual(message, { action: 'EXTRACT_ARTICLE' });
			sendAttempts++;
			if (sendAttempts === 1) {
				throw missingReceiverError();
			}
			return { success: true, article };
		},
		executeScript: async (options) => {
			injections.push(options);
		},
	});

	assert.deepEqual(result, { success: true, article });
	assert.equal(sendAttempts, 2);
	assert.deepEqual(injections, [{ target: { tabId: 42 }, files: ['content_script.js'] }]);
});

test('does not inject for an error unrelated to a missing receiver', async () => {
	let injections = 0;
	const error = new Error('The tab was closed.');

	await assert.rejects(
		requestArticleFromTab(42, {
			sendMessage: async () => {
				throw error;
			},
			executeScript: async () => {
				injections++;
			},
		}),
		error,
	);
	assert.equal(injections, 0);
});

test('does not retry more than once when injection cannot restore the receiver', async () => {
	let sendAttempts = 0;
	let injections = 0;

	await assert.rejects(
		requestArticleFromTab(42, {
			sendMessage: async () => {
				sendAttempts++;
				throw missingReceiverError();
			},
			executeScript: async () => {
				injections++;
			},
		}),
		/Could not establish connection/,
	);
	assert.equal(sendAttempts, 2);
	assert.equal(injections, 1);
});
