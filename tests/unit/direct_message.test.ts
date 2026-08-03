import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectMessageSender } from '../../src/shared/direct_message.ts';

test('resolves the response from an asynchronous runtime listener', async () => {
	const sendMessage = createDirectMessageSender((_message, _sender, sendResponse) => {
		setTimeout(() => sendResponse({ success: true }), 0);
		return true;
	});

	await assert.doesNotReject(async () => {
		assert.deepEqual(await sendMessage({ action: 'PING' }), { success: true });
	});
});

test('resolves an event message without requiring a runtime response', async () => {
	const sendMessage = createDirectMessageSender(() => undefined);

	assert.equal(await sendMessage({ action: 'EVENT' }), undefined);
});
