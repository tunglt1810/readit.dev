import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioExportEncoder } from '../../src/offscreen/audio_export_encoder.ts';

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

function fakeFileStream(options: { writeGate?: Deferred<void>; abortGate?: Deferred<void>; abortError?: Error } = {}) {
	const events: string[] = [];
	const writes: WriteParams[] = [];
	let closeCalls = 0;
	let abortCalls = 0;
	let writeStarted: (() => void) | null = null;
	const writeStartedPromise = new Promise<void>((resolve) => {
		writeStarted = resolve;
	});
	const stream = {
		async write(chunk: FileSystemWriteChunkType) {
			events.push('native.write');
			writes.push(chunk as WriteParams);
			writeStarted?.();
			await options.writeGate?.promise;
		},
		async close() {
			events.push('native.close');
			closeCalls++;
		},
		async abort() {
			events.push('native.abort');
			abortCalls++;
			await options.abortGate?.promise;
			if (options.abortError) throw options.abortError;
		},
	} as FileSystemWritableFileStream & { close(): Promise<void> };
	return {
		stream,
		events,
		writes,
		get closeCalls() {
			return closeCalls;
		},
		get abortCalls() {
			return abortCalls;
		},
		writeStarted: writeStartedPromise,
	};
}

function fakeHandle(file: ReturnType<typeof fakeFileStream>, calls: { keepExistingData?: boolean } = {}): FileSystemFileHandle {
	return {
		createWritable: async (options) => {
			calls.keepExistingData = options?.keepExistingData;
			return file.stream;
		},
	} as FileSystemFileHandle;
}

function fakeModules(options: { finalizeGate?: Deferred<void>; sourceFailure?: Error } = {}) {
	let markFinalizeStarted!: () => void;
	const state: {
		writable: WritableStream<{ type: 'write'; position: number; data: Uint8Array }> | null;
		events: string[];
		sourceConfig: unknown;
		formatOptions: unknown;
		outputOptions: unknown;
		cancelCalls: number;
		chunks: { position: number; data: Uint8Array }[];
		finalizeStarted: Promise<void>;
	} = {
		writable: null,
		events: [],
		sourceConfig: null,
		formatOptions: null,
		outputOptions: null,
		cancelCalls: 0,
		chunks: [
			{ position: 0, data: new Uint8Array(3) },
			{ position: 10, data: new Uint8Array(5) },
		],
		finalizeStarted: new Promise<void>((resolve) => {
			markFinalizeStarted = resolve;
		}),
	};

	class StreamTarget {
		constructor(writable: WritableStream<{ type: 'write'; position: number; data: Uint8Array }>) {
			state.writable = writable;
		}
	}
	class Mp3OutputFormat {
		constructor(formatOptions?: unknown) {
			state.formatOptions = formatOptions;
		}
	}
	class AudioBufferSource {
		constructor(config: unknown) {
			state.sourceConfig = config;
		}
		async add(_buffer: AudioBuffer) {
			if (options.sourceFailure) throw options.sourceFailure;
			const chunk = state.chunks.shift() ?? { position: 0, data: new Uint8Array() };
			const writer = state.writable?.getWriter();
			if (!writer) throw new Error('Missing writable');
			try {
				state.events.push(`source.add:${chunk.position}`);
				await writer.write({ type: 'write', ...chunk });
			} finally {
				writer.releaseLock();
			}
		}
		async close() {
			state.events.push('source.close');
		}
	}
	class Output {
		constructor(outputOptions: unknown) {
			state.outputOptions = outputOptions;
		}
		addAudioTrack() {}
		async start() {
			state.events.push('output.start');
		}
		async finalize() {
			state.events.push('output.finalize');
			markFinalizeStarted();
			await options.finalizeGate?.promise;
			const writer = state.writable?.getWriter();
			if (!writer) throw new Error('Missing writable');
			try {
				await writer.close();
			} finally {
				writer.releaseLock();
			}
		}
		async cancel() {
			state.cancelCalls++;
			state.events.push('output.cancel');
		}
	}

	return { modules: { Output, Mp3OutputFormat, StreamTarget, AudioBufferSource }, state };
}

test('configures a constant 96 kbps mono MP3 stream without a BufferTarget', async () => {
	const file = fakeFileStream();
	const createWritableCalls: { keepExistingData?: boolean } = {};
	const { modules, state } = fakeModules();
	const encoder = await createAudioExportEncoder(fakeHandle(file, createWritableCalls), modules);

	assert.equal(createWritableCalls.keepExistingData, false);
	assert.deepEqual(state.sourceConfig, {
		codec: 'mp3',
		bitrate: 96_000,
		bitrateMode: 'constant',
		transform: { numberOfChannels: 1 },
	});
	assert.equal(state.formatOptions, undefined);
	assert.equal((state.outputOptions as { target: unknown }).target instanceof modules.StreamTarget, true);
	assert.equal('BufferTarget' in modules, false);
	await encoder.cancel();
});

test('awaits ordered source adds and tracks the highest written byte', async () => {
	const file = fakeFileStream();
	const { modules, state } = fakeModules();
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);

	await Promise.all([encoder.add({} as AudioBuffer), encoder.add({} as AudioBuffer)]);
	assert.deepEqual(state.events.filter((event) => event.startsWith('source.add')), ['source.add:0', 'source.add:10']);
	assert.deepEqual(file.writes, [
		{ type: 'write', position: 0, data: new Uint8Array(3) },
		{ type: 'write', position: 10, data: new Uint8Array(5) },
	]);
	assert.equal(encoder.bytesWritten(), 15);
	await encoder.cancel();
});

test('closes the source before finalizing and commits through native close', async () => {
	const file = fakeFileStream();
	const { modules, state } = fakeModules();
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);

	await encoder.finalize();
	assert.deepEqual(state.events, ['output.start', 'source.close', 'output.finalize']);
	assert.deepEqual(file.events, ['native.close']);
	assert.equal(file.closeCalls, 1);
	assert.equal(file.abortCalls, 0);
});

test('aborts rather than commits after cancellation', async () => {
	const file = fakeFileStream();
	const { modules } = fakeModules();
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);

	await encoder.cancel(new DOMException('Cancelled', 'AbortError'));
	await encoder.cancel();
	assert.equal(file.abortCalls, 1);
	assert.equal(file.closeCalls, 0);
});

test('starts output cleanup while native abort is pending', async () => {
	const abortGate = deferred<void>();
	const file = fakeFileStream({ abortGate });
	const { modules, state } = fakeModules();
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);
	const cancel = encoder.cancel(new DOMException('Cancelled', 'AbortError'));

	await Promise.resolve();
	assert.equal(file.abortCalls, 1);
	assert.equal(state.cancelCalls, 1);
	assert.equal(file.closeCalls, 0);
	abortGate.resolve();
	await cancel;
	assert.equal(file.abortCalls, 1);
});

test('runs output cleanup when native abort rejects', async () => {
	const abortFailure = new Error('native abort failed');
	const file = fakeFileStream({ abortError: abortFailure });
	const { modules, state } = fakeModules();
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);

	await assert.rejects(encoder.cancel(new DOMException('Cancelled', 'AbortError')), abortFailure);
	assert.equal(file.abortCalls, 1);
	assert.equal(state.cancelCalls, 1);
	assert.equal(file.closeCalls, 0);
});

test('aborts exactly once when cancellation arrives during add backpressure', async () => {
	const writeGate = deferred<void>();
	const file = fakeFileStream({ writeGate });
	const { modules } = fakeModules();
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);
	const add = encoder.add({} as AudioBuffer);
	await file.writeStarted;
	const cancel = encoder.cancel(new DOMException('Cancelled', 'AbortError'));
	writeGate.resolve();
	await cancel;
	await assert.rejects(add, /Cancelled/);
	assert.equal(file.abortCalls, 1);
	assert.equal(file.closeCalls, 0);
});

test('aborts rather than committing when cancellation arrives during finalization', async () => {
	const finalizeGate = deferred<void>();
	const file = fakeFileStream();
	const { modules, state } = fakeModules({ finalizeGate });
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);
	const finalizing = encoder.finalize();
	await state.finalizeStarted;
	assert.deepEqual(state.events, ['output.start', 'source.close', 'output.finalize']);
	const cancel = encoder.cancel(new DOMException('Cancelled', 'AbortError'));
	finalizeGate.resolve();
	await cancel;
	await assert.rejects(finalizing, /Cancelled/);
	assert.equal(file.abortCalls, 1);
	assert.equal(file.closeCalls, 0);
});

test('cancels the output to release encoder resources after add failures', async () => {
	const failure = new Error('encoder worker failed');
	const file = fakeFileStream();
	const { modules, state } = fakeModules({ sourceFailure: failure });
	const encoder = await createAudioExportEncoder(fakeHandle(file), modules);

	await assert.rejects(encoder.add({} as AudioBuffer), failure);
	assert.equal(state.cancelCalls, 1);
	assert.equal(file.abortCalls, 1);
});
