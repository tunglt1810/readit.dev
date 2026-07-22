import assert from 'node:assert/strict';
import test from 'node:test';
import { sendOffscreenCommand } from '../../src/background/offscreen_transport.ts';

test('treats missing PLAY responses as failures so a pending start cannot remain loading', async () => {
	assert.deepEqual(await sendOffscreenCommand({ action: 'PLAY' }, async () => undefined), { success: false });
});

test('treats null or malformed PLAY responses as failures', async () => {
	for (const response of [null, {}, { success: 'true' }]) {
		assert.deepEqual(await sendOffscreenCommand({ action: 'PLAY' }, async () => response), { success: false });
	}
});
