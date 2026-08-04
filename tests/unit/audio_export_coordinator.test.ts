import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIO_EXPORT_PREPARATION_TIMEOUT_MS, createAudioExportCoordinator } from '../../src/background/audio_export.ts';
import { AudioExportPreparationDiagnostics } from '../../src/background/audio_export_prepare_diagnostics.ts';
import { createAudioExportJob, transitionAudioExportJob } from '../../src/background/audio_export_state.ts';
import { createPlaybackSession } from '../../src/background/playback_state.ts';

const playback = createPlaybackSession({
	sessionId: 'session-1',
	contentScope: 'article',
	source: { kind: 'tab', tabId: 1, title: 'An article', url: 'https://example.com/article' },
	readableSurface: 'website-dom',
	lang: 'en',
	voiceStyleId: 'M1',
	speed: 1.05,
	now: 1_000,
});

function createHarness(
	options: {
		stored?: unknown;
		now?: number;
		sendOffscreen?: (command: { action: string; target?: unknown; payload?: unknown }) => Promise<{ success: boolean; error?: string }>;
	} = {},
) {
	let stored = options.stored;
	let activeSession = { ...playback, audioExportEstimate: { durationSeconds: 60, estimatedBytes: 724_096 } };
	let timer: (() => void | Promise<void>) | null = null;
	const offscreenCommands: { action: string; target?: unknown; payload?: unknown }[] = [];
	const broadcasts: unknown[] = [];
	const handleDeletes: string[] = [];
	const preparationDiagnostics = new AudioExportPreparationDiagnostics();
	let now = options.now ?? 1_000;
	const coordinator = createAudioExportCoordinator({
		storage: {
			get: async () => stored,
			set: async (job) => {
				stored = job;
			},
			remove: async () => {
				stored = undefined;
			},
		},
		getPlaybackSession: () => activeSession,
		ensureOffscreen: async () => {},
		sendOffscreen: async (command) => {
			offscreenCommands.push(command);
			return options.sendOffscreen?.(command) ?? { success: true };
		},
		preparationDiagnostics,
		deleteHandle: async (jobId) => {
			handleDeletes.push(jobId);
		},
		broadcast: async (job) => {
			broadcasts.push(job);
		},
		now: () => now,
		setTimeout: (callback) => {
			timer = callback;
			return 1 as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: () => {},
	});
	return {
		coordinator,
		offscreenCommands,
		broadcasts,
		handleDeletes,
		preparationDiagnostics,
		get stored() {
			return stored;
		},
		set now(value: number) {
			now = value;
		},
		set activeSession(value: typeof activeSession) {
			activeSession = value;
		},
		fireTimer: async () => {
			await timer?.();
		},
	};
}

const request = { jobId: 'job-1', playbackSessionId: 'session-1', title: 'An article', outputFilename: 'an-article.mp3' };

test('prepares one active session, persists strict metadata, and routes only marked offscreen commands', async () => {
	const harness = createHarness();
	assert.deepEqual(await harness.coordinator.prepare(request), { success: true });
	assert.deepEqual(Object.keys(harness.stored as object).sort(), [
		'bytesWritten',
		'estimate',
		'jobId',
		'outputFilename',
		'playbackSessionId',
		'processedDurationSeconds',
		'progressPercentage',
		'startedAt',
		'state',
		'title',
		'updatedAt',
	]);
	assert.equal(harness.offscreenCommands[0]?.action, 'PREPARE_AUDIO_EXPORT');
	assert.equal(typeof harness.offscreenCommands[0]?.target, 'string');
	assert.deepEqual(harness.offscreenCommands[0]?.payload, {
		jobId: 'job-1',
		playbackSessionId: 'session-1',
		outputFilename: 'an-article.mp3',
		estimate: { durationSeconds: 60, estimatedBytes: 724_096 },
	});
	assert.deepEqual(await harness.coordinator.prepare({ ...request, jobId: 'job-2' }), { success: false, error: 'snapshot-unavailable' });
});

test('records a debugger-only immutable outcome after a successful offscreen snapshot', async () => {
	const harness = createHarness();
	assert.deepEqual(await harness.coordinator.prepare(request), { success: true });

	const [record] = harness.preparationDiagnostics.read('job-1');
	assert.deepEqual(record, {
		jobId: 'job-1',
		playbackSessionId: 'session-1',
		outcome: 'prepared',
		innerError: null,
	});
	assert.equal(Object.isFrozen(record), true);
});

test('preserves the exact rejected offscreen prepare reason only in diagnostics', async () => {
	const harness = createHarness({
		sendOffscreen: async () => ({ success: false, error: 'An audio export is already prepared' }),
	});
	assert.deepEqual(await harness.coordinator.prepare(request), { success: false, error: 'snapshot-unavailable' });
	assert.equal(harness.coordinator.snapshot()?.errorCode, 'snapshot-unavailable');
	assert.deepEqual(harness.preparationDiagnostics.read('job-1'), [
		{
			jobId: 'job-1',
			playbackSessionId: 'session-1',
			outcome: 'offscreen-rejected',
			innerError: 'An audio export is already prepared',
		},
	]);
});

test('rejects preparation for a playback session that is not active', async () => {
	const harness = createHarness();
	assert.deepEqual(
		await harness.coordinator.prepare({ ...request, playbackSessionId: 'other-session' }),
		{ success: false, error: 'snapshot-unavailable' },
	);
	assert.equal(harness.stored, undefined);
	assert.deepEqual(harness.offscreenCommands, []);
});

test('attempts stale offscreen cleanup before terminal cleanup when the receiver is gone', async () => {
	const harness = createHarness({
		sendOffscreen: async (command) => {
			if (command.action === 'DISCARD_AUDIO_EXPORT') {
				throw new Error('No receiving end');
			}
			return { success: true };
		},
	});
	await harness.coordinator.prepare(request);
	harness.now = 1_000 + AUDIO_EXPORT_PREPARATION_TIMEOUT_MS;
	await harness.fireTimer();
	assert.equal(harness.coordinator.snapshot()?.state, 'failed');
	assert.deepEqual(harness.handleDeletes, ['job-1']);
	assert.deepEqual(
		harness.offscreenCommands.map((command) => command.action),
		['PREPARE_AUDIO_EXPORT', 'DISCARD_AUDIO_EXPORT'],
	);
	assert.equal(AUDIO_EXPORT_PREPARATION_TIMEOUT_MS, 10 * 60 * 1_000);
});

test('awaits the queued expiration cleanup before the timer callback resolves', async () => {
	let releaseDiscard: (() => void) | undefined;
	const discardPending = new Promise<void>((resolve) => {
		releaseDiscard = resolve;
	});
	const harness = createHarness({
		sendOffscreen: async (command) => {
			if (command.action === 'DISCARD_AUDIO_EXPORT') {
				await discardPending;
			}
			return { success: true };
		},
	});
	await harness.coordinator.prepare(request);
	harness.now = 1_000 + AUDIO_EXPORT_PREPARATION_TIMEOUT_MS;
	let resolved = false;
	const expiration = harness.fireTimer().then(() => {
		resolved = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(resolved, false);
	assert.equal(harness.coordinator.snapshot()?.state, 'preparing');
	releaseDiscard?.();
	await expiration;
	assert.equal(harness.coordinator.snapshot()?.state, 'failed');
});

test('returns success and clears a prepared job when offscreen discard fails', async () => {
	const harness = createHarness({
		sendOffscreen: async (command) => {
			if (command.action === 'DISCARD_AUDIO_EXPORT') {
				throw new Error('No receiving end');
			}
			return { success: true };
		},
	});
	await harness.coordinator.prepare(request);
	assert.deepEqual(await harness.coordinator.discard('job-1'), { success: true });
	assert.equal(harness.coordinator.snapshot(), null);
	assert.equal(harness.stored, undefined);
	assert.deepEqual(harness.handleDeletes, ['job-1']);
});

test('clears a cancellation despite a late encoder failure and offscreen cleanup error', async () => {
	let releaseCancel!: (response: { success: boolean }) => void;
	const cancelResponse = new Promise<{ success: boolean }>((resolve) => {
		releaseCancel = resolve;
	});
	const harness = createHarness({
		sendOffscreen: async (command) => {
			if (command.action === 'CANCEL_AUDIO_EXPORT') {
				return cancelResponse;
			}
			return { success: true };
		},
	});
	await harness.coordinator.prepare(request);
	await harness.coordinator.start('job-1');

	const cancellation = harness.coordinator.cancel('job-1');
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(harness.coordinator.snapshot()?.state, 'cancelling');
	await harness.coordinator.handleProgress({
		jobId: 'job-1',
		state: 'failed',
		processedDurationSeconds: 10,
		progressPercentage: 10,
		bytesWritten: 0,
	});
	assert.equal(harness.coordinator.snapshot()?.state, 'cancelling');

	releaseCancel({ success: false });
	assert.deepEqual(await cancellation, { success: true });
	assert.equal(harness.coordinator.snapshot(), null);
	assert.equal(harness.stored, undefined);
});

test('clears a stale encoding failure when cancellation arrives after the race', async () => {
	const harness = createHarness();
	await harness.coordinator.prepare(request);
	await harness.coordinator.start('job-1');
	await harness.coordinator.handleProgress({
		jobId: 'job-1',
		state: 'failed',
		processedDurationSeconds: 10,
		progressPercentage: 10,
		bytesWritten: 0,
	});
	assert.equal(harness.coordinator.snapshot()?.state, 'failed');

	assert.deepEqual(await harness.coordinator.cancel('job-1'), { success: true });
	assert.equal(harness.coordinator.snapshot(), null);
	assert.equal(harness.stored, undefined);
});

test('never resumes a persisted nonterminal job and enforces stale preparation on hydration', async () => {
	const stored = createAudioExportJob({
		...request,
		estimate: { durationSeconds: 60, estimatedBytes: 724_096 },
		now: 1_000,
	});
	const harness = createHarness({ stored, now: 1_000 + AUDIO_EXPORT_PREPARATION_TIMEOUT_MS });
	await harness.coordinator.hydrate();
	assert.equal(harness.coordinator.snapshot()?.state, 'interrupted');
	assert.equal(harness.coordinator.snapshot()?.errorCode, 'snapshot-unavailable');
	assert.deepEqual(
		harness.offscreenCommands.map((command) => command.action),
		['DISCARD_AUDIO_EXPORT'],
	);
	assert.deepEqual(harness.handleDeletes, ['job-1']);
});

test('hydrates an exporting job as interrupted without sending a resume command', async () => {
	const preparing = createAudioExportJob({
		...request,
		estimate: { durationSeconds: 60, estimatedBytes: 724_096 },
		now: 1_000,
	});
	const stored = transitionAudioExportJob(preparing, 'exporting', 2_000);
	assert.ok(stored);
	const harness = createHarness({ stored, now: 3_000 });
	await harness.coordinator.hydrate();
	assert.equal(harness.coordinator.snapshot()?.state, 'interrupted');
	assert.equal(harness.coordinator.snapshot()?.errorCode, 'interrupted');
	assert.deepEqual(
		harness.offscreenCommands.map((command) => command.action),
		['CANCEL_AUDIO_EXPORT'],
	);
	assert.deepEqual(harness.handleDeletes, ['job-1']);
});

test('persists interrupted hydration cleanup when the old offscreen receiver is gone', async () => {
	const stored = createAudioExportJob({
		...request,
		estimate: { durationSeconds: 60, estimatedBytes: 724_096 },
		now: 1_000,
	});
	const harness = createHarness({
		stored,
		sendOffscreen: async () => {
			throw new Error('No receiving end');
		},
	});
	await harness.coordinator.hydrate();
	assert.equal(harness.coordinator.snapshot()?.state, 'interrupted');
	assert.deepEqual(harness.handleDeletes, ['job-1']);
	assert.deepEqual(harness.offscreenCommands.map((command) => command.action), ['DISCARD_AUDIO_EXPORT']);
});

test('publishes offscreen progress and cleans transient handles on terminal progress', async () => {
	const harness = createHarness();
	await harness.coordinator.prepare(request);
	await harness.coordinator.start('job-1');
	await harness.coordinator.handleProgress({
		jobId: 'job-1',
		state: 'exporting',
		processedDurationSeconds: 10,
		progressPercentage: 10,
		bytesWritten: 1_000,
		etaSeconds: 50,
	});
	await harness.coordinator.handleProgress({
		jobId: 'job-1',
		state: 'completed',
		processedDurationSeconds: 60,
		progressPercentage: 100,
		bytesWritten: 7_200,
	});
	assert.equal(harness.coordinator.snapshot()?.state, 'completed');
	assert.deepEqual(harness.handleDeletes, ['job-1']);
	assert.equal(harness.broadcasts.length >= 4, true);
});
