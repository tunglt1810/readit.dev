import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createAudioExportOffscreenCommand,
	isManualCheckpointMetadata,
	sendOffscreenCommand,
} from '../../src/background/offscreen_transport.ts';

const audioExportEstimate = { durationSeconds: 12, estimatedBytes: 148_096 };

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

test('accepts only strict document reader snapshots', async () => {
	const snapshot = {
		sessionId: 'document-session',
		title: 'Document',
		content: 'First second',
		words: [
			{ text: 'First', globalIndex: 0 },
			{ text: 'second', globalIndex: 1 },
		],
		currentWordIndex: 1,
	};

	assert.deepEqual(
		await sendOffscreenCommand(
			{ action: 'GET_DOCUMENT_READER_SNAPSHOT', payload: { sessionId: snapshot.sessionId } },
			async () => ({ success: true, snapshot }),
		),
		{ success: true, snapshot },
	);
	assert.deepEqual(
		await sendOffscreenCommand(
			{ action: 'GET_DOCUMENT_READER_SNAPSHOT', payload: { sessionId: snapshot.sessionId } },
			async () => ({ success: true, snapshot: { ...snapshot, currentWordIndex: 1.5 } }),
		),
		{ success: false },
	);
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

test('accepts numeric-only audio export estimates', async () => {
	assert.deepEqual(
		await sendOffscreenCommand({ action: 'PLAY' }, async () => ({ success: true, audioExportEstimate })),
		{ success: true, audioExportEstimate },
	);
});

test('rejects malformed audio export estimates', async () => {
	for (const estimate of [
		{ durationSeconds: Number.NaN, estimatedBytes: 1 },
		{ durationSeconds: -1, estimatedBytes: 1 },
		{ durationSeconds: 1, estimatedBytes: 1, unitText: 'forbidden' },
	]) {
		assert.deepEqual(await sendOffscreenCommand({ action: 'PLAY' }, async () => ({ success: true, audioExportEstimate: estimate })), {
			success: false,
		});
	}
});

test('only sends audio export commands to offscreen through the internal channel marker', async () => {
	let attempts = 0;
	assert.deepEqual(
		await sendOffscreenCommand({ action: 'START_AUDIO_EXPORT', payload: { jobId: 'job-1' } }, async () => {
			attempts++;
			return { success: true };
		}),
		{ success: false },
	);
	assert.equal(attempts, 0);

	const command = createAudioExportOffscreenCommand('START_AUDIO_EXPORT', { jobId: 'job-1' });
	assert.deepEqual(await sendOffscreenCommand(command, async () => ({ success: true })), { success: true });
});
