import assert from 'node:assert/strict';
import test from 'node:test';
import {
	discardAudioExport,
	requestAudioExportState,
	sendAudioExportCommand,
	subscribeAudioExportState,
	type AudioExportRuntimeLike,
} from '../../src/shared/audio_export_client.ts';

function createRuntime(responses: unknown[], runtimeErrors: Array<string | undefined> = []) {
	const sent: unknown[] = [];
	let listener: ((message: unknown) => void) | undefined;
	let activeRuntimeError: string | undefined;
	const runtime: AudioExportRuntimeLike = {
		get lastError() {
			return activeRuntimeError ? { message: activeRuntimeError } : undefined;
		},
		sendMessage(message, callback) {
			sent.push(message);
			activeRuntimeError = runtimeErrors.shift();
			callback(responses.shift());
			activeRuntimeError = undefined;
		},
		onMessage: {
			addListener(value) {
				listener = value;
			},
			removeListener() {},
		},
	};
	return { runtime, sent, listener: () => listener };
}

const job = {
	jobId: 'job-1',
	playbackSessionId: 'session-1',
	title: 'An article',
	outputFilename: 'an-article.mp3',
	state: 'exporting' as const,
	estimate: { durationSeconds: 60, estimatedBytes: 724_096 },
	processedDurationSeconds: 10,
	progressPercentage: 20,
	bytesWritten: 1_000,
	startedAt: 1_000,
	updatedAt: 2_000,
};

test('requests a strict audio export state snapshot', async () => {
	const fixture = createRuntime([{ job }]);
	assert.deepEqual(await requestAudioExportState(fixture.runtime), { job });
	assert.deepEqual(fixture.sent, [{ action: 'GET_AUDIO_EXPORT_STATE' }]);
});

test('rejects missing, malformed, and lastError export responses', async () => {
	await assert.rejects(requestAudioExportState(createRuntime([undefined]).runtime), /no response/);
	await assert.rejects(requestAudioExportState(createRuntime([{ job: { ...job, state: 'unknown' } }]).runtime), /malformed/);
	await assert.rejects(requestAudioExportState(createRuntime([{ job: null }], ['No receiver']).runtime), /No receiver/);
});

test('preserves audio export command failures and turns missing responses into transport failures', async () => {
	assert.deepEqual(
		await sendAudioExportCommand({ action: 'START_AUDIO_EXPORT', payload: { jobId: 'job-1' } }, createRuntime([{ success: false, error: 'encoding-failed' }]).runtime),
		{ success: false, error: 'encoding-failed' },
	);
	assert.deepEqual(await discardAudioExport('job-1', createRuntime([null]).runtime), {
		success: false,
		error: 'Extension runtime request returned no response.',
		transportError: true,
	});
});

test('turns malformed non-null audio export command responses into transport failures', async () => {
	for (const response of [{}, { success: 'true' }, { success: true, error: 1 }, { success: true, unexpected: true }]) {
		const result = await sendAudioExportCommand({ action: 'START_AUDIO_EXPORT', payload: { jobId: 'job-1' } }, createRuntime([response]).runtime);
		assert.equal(result.success, false);
		assert.equal(result.transportError, true);
		assert.match(result.error ?? '', /malformed audio export command response/);
	}
});

test('subscribes only to strict audio export state broadcasts', () => {
	const fixture = createRuntime([]);
	const received: unknown[] = [];
	subscribeAudioExportState(fixture.runtime, (next) => received.push(next));
	fixture.listener()?.({ action: 'AUDIO_EXPORT_STATE_UPDATE', job });
	fixture.listener()?.({ action: 'AUDIO_EXPORT_STATE_UPDATE', job: { ...job, progressPercentage: 101 } });
	fixture.listener()?.({ action: 'PLAYBACK_STATE_UPDATE', session: null });
	fixture.listener()?.({ action: 'AUDIO_EXPORT_STATE_UPDATE', job: null });
	assert.deepEqual(received, [job, null]);
});
