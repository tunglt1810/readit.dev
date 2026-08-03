import assert from 'node:assert/strict';
import test from 'node:test';
import type { AudioExportEncoder } from '../../src/offscreen/audio_export_encoder.ts';
import { AudioExportEngine } from '../../src/offscreen/audio_export_engine.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';
import type { Style } from '../../src/offscreen/supertonic_helper.ts';
import type { AudioExportEstimate } from '../../src/shared/types.ts';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail('Expected asynchronous work to settle');
}

function unit(text: string, pauseAfterMs: number | null = 0): SpeechUnit {
	return { text, pauseAfterMs };
}

function prepared(jobId = 'job-1', playbackSessionId = 'session-old', units: SpeechUnit[] = [unit('one'), unit('two')]) {
	return {
		jobId,
		playbackSessionId,
		outputFilename: 'readit-export.mp3',
		units,
		language: 'en',
		voiceStyleId: 'voice-1',
		style: {} as Style,
		speed: 1,
		estimate: { durationSeconds: 10, estimatedBytes: 120_000 } satisfies AudioExportEstimate,
	};
}

class Runway {
	open = true;
	private waiters: (() => void)[] = [];

	wait(): Promise<void> {
		if (this.open) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	wake() {
		const waiters = this.waiters.splice(0);
		for (const resolve of waiters) resolve();
	}
}

function createHarness(
	options: {
		runwayOpen?: boolean;
		synthesize?: (input: { unit: SpeechUnit }) => Promise<AudioBuffer>;
		encoder?: Partial<AudioExportEncoder>;
		handle?: FileSystemFileHandle | null;
		download?: (blob: Blob, filename: string) => Promise<void>;
		onAdd?: () => void;
		deleteHandle?: (jobId: string) => Promise<void>;
	} = {},
) {
	const runway = new Runway();
	runway.open = options.runwayOpen ?? true;
	const events: string[] = [];
	const progress: { state: string; progressPercentage: number; etaSeconds?: number; bytesWritten: number }[] = [];
	const synthesizedTexts: string[] = [];
	const taken: string[] = [];
	const createdHandles: (FileSystemFileHandle | null)[] = [];
	const deleted: string[] = [];
	let createdEncoders = 0;
	let now = 0;
	const encoder: AudioExportEncoder = {
		async add(_buffer) {
			events.push('add');
			options.onAdd?.();
		},
		async finalize() {
			events.push('finalize');
		},
		async cancel() {
			events.push('cancel');
		},
		bytesWritten() {
			return events.filter((event) => event === 'add').length * 100;
		},
		outputBlob() {
			return new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
		},
		...options.encoder,
	};
	const engine = new AudioExportEngine({
		takeHandle: async (jobId) => {
			taken.push(jobId);
			return options.handle === undefined ? ({ kind: 'handle' } as unknown as FileSystemFileHandle) : options.handle;
		},
		deleteHandle: async (jobId) => {
			deleted.push(jobId);
			await options.deleteHandle?.(jobId);
		},
		createEncoder: async (handle) => {
			createdEncoders++;
			createdHandles.push(handle);
			return encoder;
		},
		download: options.download,
		synthesize: async (input) => {
			synthesizedTexts.push(input.unit.text);
			now += 1_000;
			return options.synthesize?.(input) ?? ({ duration: 1 } as AudioBuffer);
		},
		canStartBackgroundSynthesis: () => runway.open,
		waitForRunway: () => runway.wait(),
		wakeRunway: () => runway.wake(),
		onProgress: (update) => {
			progress.push(update);
			if (update.state === 'completed') events.push('completed');
		},
		now: () => now,
	});
	return {
		engine,
		runway,
		events,
		progress,
		synthesizedTexts,
		taken,
		deleted,
		createdEncoders: () => createdEncoders,
		createdHandles,
		encoder,
	};
}

test('continues the old immutable snapshot after playback replacement', async () => {
	const sourceUnits = [unit('old one'), unit('old two')];
	const { engine, synthesizedTexts } = createHarness();
	engine.prepare(prepared('job-1', 'session-old', sourceUnits));
	sourceUnits[0].text = 'mutated';
	sourceUnits.push(unit('new session unit'));
	await engine.start('job-1');
	assert.deepEqual(synthesizedTexts, ['old one', 'old two']);
});

test('allows exactly one prepared or active job', () => {
	const { engine } = createHarness();
	engine.prepare(prepared());
	assert.throws(() => engine.prepare(prepared('job-2')), /already prepared/i);
});

test('rejects an unknown job synchronously before offscreen can acknowledge start', () => {
	const { engine } = createHarness();
	engine.prepare(prepared());
	assert.throws(() => engine.start('unknown-job'), /not prepared/i);
});

test('rejects a second start synchronously while the prepared job is active', async () => {
	const { engine, runway } = createHarness({ runwayOpen: false });
	engine.prepare(prepared());
	const start = engine.start('job-1');
	assert.throws(() => engine.start('job-1'), /already active/i);
	await engine.cancel('job-1');
	runway.wake();
	await assert.rejects(start, /cancelled/i);
});

test('clones the estimate before later playback mutations', async () => {
	const { engine, progress } = createHarness();
	const input = prepared('job-1', 'session-old', [unit('one')]);
	engine.prepare(input);
	input.estimate.durationSeconds = 100;
	input.estimate.estimatedBytes = 1_200_000;
	await engine.start('job-1');
	const exporting = progress.find((update) => update.state === 'exporting' && update.etaSeconds !== undefined);
	assert.ok(exporting?.etaSeconds !== undefined && exporting.etaSeconds < 50);
});

test('ignores a stale discard without clearing the prepared snapshot', async () => {
	const { engine, synthesizedTexts } = createHarness();
	engine.prepare(prepared());
	await engine.discard('stale-job');
	await engine.start('job-1');
	assert.deepEqual(synthesizedTexts, ['one', 'two']);
});

test('takes the handle once before waiting for a safe runway', async () => {
	const { engine, runway, taken, progress, createdEncoders } = createHarness({ runwayOpen: false });
	engine.prepare(prepared());
	const start = engine.start('job-1');
	await eventually(() => progress.at(-1)?.state === 'waiting-for-playback');
	assert.deepEqual(taken, ['job-1']);
	assert.equal(createdEncoders(), 0);
	assert.equal(progress.at(-1)?.state, 'waiting-for-playback');
	runway.open = true;
	runway.wake();
	await start;
	assert.equal(createdEncoders(), 1);
});

test('releases each synthesized buffer before the next unit', async () => {
	let liveBuffers = 0;
	let maximumLiveBuffers = 0;
	const { engine } = createHarness({
		synthesize: async () => {
			liveBuffers++;
			maximumLiveBuffers = Math.max(maximumLiveBuffers, liveBuffers);
			return { duration: 1 } as AudioBuffer;
		},
		encoder: {
			async add() {
				liveBuffers--;
			},
			bytesWritten: () => 10,
		},
	});
	engine.prepare(prepared());
	await engine.start('job-1');
	assert.equal(maximumLiveBuffers, 1);
	assert.equal(liveBuffers, 0);
});

test('stops before the next unit when foreground playback closes the runway', async () => {
	const { engine, runway, synthesizedTexts } = createHarness({
		onAdd: () => {
			runway.open = false;
		},
	});
	engine.prepare(prepared());
	const start = engine.start('job-1');
	await eventually(() => synthesizedTexts.length === 1);
	assert.deepEqual(synthesizedTexts, ['one']);
	runway.open = true;
	runway.wake();
	await start;
});

test('reports monotonic weighted progress with a moving ETA', async () => {
	const { engine, progress } = createHarness();
	engine.prepare(prepared('job-1', 'session-old', [unit('short'), unit('many words make this unit heavier')]));
	await engine.start('job-1');
	const exporting = progress.filter((update) => update.state === 'exporting');
	assert.deepEqual(
		exporting.map((update) => update.progressPercentage),
		[...exporting.map((update) => update.progressPercentage)].sort((a, b) => a - b),
	);
	assert.equal(
		exporting.some((update) => typeof update.etaSeconds === 'number' && update.etaSeconds > 0),
		true,
	);
	assert.equal(progress.at(-1)?.state, 'completed');
});

test('cancels before synthesis and removes the handle and snapshot', async () => {
	const { engine, runway, deleted, events } = createHarness({ runwayOpen: false });
	engine.prepare(prepared());
	const start = engine.start('job-1');
	await Promise.resolve();
	await engine.cancel('job-1');
	runway.wake();
	await assert.rejects(start, /cancelled/i);
	assert.deepEqual(deleted, ['job-1']);
	assert.equal(events.includes('cancel'), false);
	assert.equal(engine.hasWork(), false);
});

test('cancels after inference settles', async () => {
	const synthesis = deferred<AudioBuffer>();
	const { engine, deleted } = createHarness({ synthesize: async () => synthesis.promise });
	engine.prepare(prepared());
	const start = engine.start('job-1');
	await Promise.resolve();
	await engine.cancel('job-1');
	synthesis.resolve({ duration: 1 } as AudioBuffer);
	await assert.rejects(start, /cancelled/i);
	assert.deepEqual(deleted, ['job-1']);
});

test('cancels during encoder backpressure', async () => {
	const add = deferred<void>();
	const { engine, deleted } = createHarness({ encoder: { add: async () => add.promise } });
	engine.prepare(prepared());
	const start = engine.start('job-1');
	await Promise.resolve();
	await Promise.resolve();
	await engine.cancel('job-1');
	add.resolve();
	await assert.rejects(start, /cancelled/i);
	assert.deepEqual(deleted, ['job-1']);
});

test('cancels during finalization instead of reporting completion', async () => {
	const finalize = deferred<void>();
	const { engine, deleted, progress } = createHarness({ encoder: { finalize: async () => finalize.promise } });
	engine.prepare(prepared('job-1', 'session-old', [unit('only')]));
	const start = engine.start('job-1');
	await Promise.resolve();
	await Promise.resolve();
	await engine.cancel('job-1');
	finalize.resolve();
	await assert.rejects(start, /cancelled/i);
	assert.deepEqual(deleted, ['job-1']);
	assert.equal(
		progress.some((update) => update.state === 'completed'),
		false,
	);
});

test('aborts and removes the snapshot when synthesis fails', async () => {
	const failure = new Error('inference failed');
	const { engine, deleted, events } = createHarness({ synthesize: async () => Promise.reject(failure) });
	engine.prepare(prepared());
	await assert.rejects(engine.start('job-1'), failure);
	assert.deepEqual(deleted, ['job-1']);
	assert.equal(events.includes('cancel'), true);
	assert.equal(engine.hasWork(), false);
});

test('reports failure and clears work when handle cleanup rejects', async () => {
	const failure = new Error('inference failed');
	const cleanupFailure = new Error('handle cleanup failed');
	const { engine, progress } = createHarness({
		synthesize: async () => Promise.reject(failure),
		deleteHandle: async () => Promise.reject(cleanupFailure),
	});
	engine.prepare(prepared());
	await assert.rejects(engine.start('job-1'), failure);
	assert.equal(progress.at(-1)?.state, 'failed');
	assert.equal(engine.hasWork(), false);
});

test('finalizes before completion and removes the transient handle', async () => {
	const { engine, events, deleted } = createHarness();
	engine.prepare(prepared());
	await engine.start('job-1');
	assert.deepEqual(events.slice(-2), ['finalize', 'completed']);
	assert.deepEqual(deleted, ['job-1']);
});

test('downloads a memory export when the browser has no file handle picker', async () => {
	const downloads: { blob: Blob; filename: string }[] = [];
	const { engine, createdHandles } = createHarness({
		handle: null,
		download: async (blob, filename) => {
			downloads.push({ blob, filename });
		},
	});

	engine.prepare(prepared());
	await engine.start('job-1');

	assert.deepEqual(createdHandles, [null]);
	assert.equal(downloads.length, 1);
	assert.equal(downloads[0]?.filename, 'readit-export.mp3');
	assert.deepEqual([...new Uint8Array(await downloads[0]!.blob.arrayBuffer())], [1, 2, 3]);
});
