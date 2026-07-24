import assert from 'node:assert/strict';
import test from 'node:test';
import { isManualCheckpointMetadata, sendOffscreenCommand } from '../../src/background/offscreen_transport.ts';

test('treats missing PLAY responses as failures so a pending start cannot remain loading', async () => {
	assert.deepEqual(await sendOffscreenCommand({ action: 'PLAY' }, async () => undefined), { success: false });
});

test('rethrows transport rejections so background catch blocks can clean up session', async () => {
	await assert.rejects(
		sendOffscreenCommand({ action: 'PLAY' }, async () => {
			throw new Error('Extension context invalidated.');
		}),
		/Extension context invalidated/,
	);
});

test('treats null or malformed PLAY responses as failures', async () => {
	for (const response of [null, {}, { success: 'true' }]) {
		assert.deepEqual(await sendOffscreenCommand({ action: 'PLAY' }, async () => response), { success: false });
	}
});

test('accepts checkpoint metadata without accepting manual content', async () => {
	const checkpoint = {
		sessionId: 'manual-1',
		panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd',
		lang: 'en',
		voiceStyleId: 'M1',
		speed: 1.05,
	};
	const response = await sendOffscreenCommand(
		{ action: 'CHECKPOINT_MANUAL', payload: checkpoint },
		async () => ({ success: true, checkpoint }),
	);
	assert.equal(response.success, true);
	assert.equal(isManualCheckpointMetadata(response.checkpoint), true);
	assert.equal(isManualCheckpointMetadata({ ...checkpoint, text: 'forbidden' }), false);
	assert.equal(isManualCheckpointMetadata({ sessionId: checkpoint.sessionId, panelInstanceId: checkpoint.panelInstanceId }), false);
});

test('treats an unsuccessful checkpoint as a failed precondition', async () => {
	assert.deepEqual(await sendOffscreenCommand({ action: 'CHECKPOINT_MANUAL' }, async () => ({ success: false })), { success: false });
});

test('sends a failed command once instead of delaying every playback control with warm retries', async () => {
	let attempts = 0;
	const response = await sendOffscreenCommand({ action: 'PLAY' }, async () => {
		attempts++;
		return undefined;
	});

	assert.deepEqual(response, { success: false });
	assert.equal(attempts, 1);
});
