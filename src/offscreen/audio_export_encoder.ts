import type { StreamTargetChunk } from 'mediabunny';

import { AUDIO_EXPORT_BITRATE_BPS } from '../shared/audio_export.ts';

export interface AudioExportEncoder {
	add(buffer: AudioBuffer): Promise<void>;
	finalize(): Promise<void>;
	cancel(reason?: unknown): Promise<void>;
	bytesWritten(): number;
	outputBlob?: () => Blob | null;
}

type EncoderModules = {
	Output: new (options: {
		format: unknown;
		target: unknown;
	}) => {
		addAudioTrack(source: unknown): unknown;
		start(): Promise<void>;
		finalize(): Promise<void>;
		cancel(): Promise<void>;
	};
	Mp3OutputFormat: new () => unknown;
	StreamTarget: new (writable: WritableStream<StreamTargetChunk>) => unknown;
	AudioBufferSource: new (config: {
		codec: 'mp3';
		bitrate: number;
		bitrateMode: 'constant';
		transform: { numberOfChannels: 1 };
	}) => {
		add(buffer: AudioBuffer): Promise<void>;
		close(): Promise<void>;
	};
};

type NativeWritable = FileSystemWritableFileStream & { close(): Promise<void> };

type ExportSink = {
	write(chunk: StreamTargetChunk): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
	outputBlob?: () => Blob | null;
};

async function loadMp3Modules() {
	const [mediabunny, extension] = await Promise.all([import('mediabunny'), import('@mediabunny/mp3-encoder')]);
	if (!(await mediabunny.canEncodeAudio('mp3'))) {
		extension.registerMp3Encoder();
	}
	return mediabunny;
}

function cancellationError(reason: unknown): Error {
	return reason instanceof Error ? reason : new DOMException('Cancelled', 'AbortError');
}

function createNativeSink(nativeWritable: NativeWritable): ExportSink {
	return {
		write: (chunk) => nativeWritable.write({ type: 'write', position: chunk.position, data: chunk.data }),
		close: () => nativeWritable.close(),
		abort: (reason) => nativeWritable.abort(reason),
	};
}

function createMemorySink(): ExportSink {
	const chunks = new Map<number, Uint8Array<ArrayBuffer>>();
	let bytesWritten = 0;
	let aborted = false;

	const sink = {
		write: async (chunk: StreamTargetChunk) => {
			if (aborted) {
				throw new DOMException('The audio export was cancelled.', 'AbortError');
			}
			const data = chunk.data.slice();
			chunks.set(chunk.position, data);
			bytesWritten = Math.max(bytesWritten, chunk.position + data.byteLength);
		},
		close: async () => {
			// Memory output has no native close operation.
		},
		abort: async () => {
			aborted = true;
			chunks.clear();
			bytesWritten = 0;
		},
		outputBlob: () => {
			if (aborted) {
				return null;
			}
			const output = new Uint8Array(bytesWritten);
			for (const [position, data] of chunks) {
				output.set(data, position);
			}
			return new Blob([output], { type: 'audio/mpeg' });
		},
	};
	return sink;
}

function createCommitControlledWritable(sink: ExportSink) {
	let cancelRequested = false;
	let cancelReason: unknown;
	let bytesWritten = 0;
	let nativeAbort: Promise<void> | null = null;

	const abortNative = (reason?: unknown): Promise<void> => {
		if (!nativeAbort) {
			nativeAbort = sink.abort(reason);
		}
		return nativeAbort;
	};

	const writable = new WritableStream<StreamTargetChunk>({
		async write(chunk) {
			if (cancelRequested) {
				await abortNative(cancelReason);
				throw cancellationError(cancelReason);
			}
			await sink.write(chunk);
			bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength);
			if (cancelRequested) {
				await abortNative(cancelReason);
				throw cancellationError(cancelReason);
			}
		},
		async close() {
			if (cancelRequested) {
				await abortNative(cancelReason);
				return;
			}
			await sink.close();
		},
		async abort(reason) {
			await abortNative(reason);
		},
	});

	return {
		writable,
		requestCancel(reason?: unknown) {
			cancelRequested = true;
			cancelReason ??= reason;
			return abortNative(cancelReason);
		},
		isCancelled() {
			return cancelRequested;
		},
		bytesWritten() {
			return bytesWritten;
		},
		outputBlob() {
			return sink.outputBlob?.() ?? null;
		},
		abortNative,
		cancelError() {
			return cancellationError(cancelReason);
		},
	};
}

export async function createAudioExportEncoder(handle: FileSystemFileHandle | null, modules?: EncoderModules): Promise<AudioExportEncoder> {
	const sink = handle
		? createNativeSink((await handle.createWritable({ keepExistingData: false })) as NativeWritable)
		: createMemorySink();
	const commitControlledWritable = createCommitControlledWritable(sink);
	let output: InstanceType<EncoderModules['Output']> | null = null;
	try {
		const loadedModules = modules ?? ((await loadMp3Modules()) as unknown as EncoderModules);
		output = new loadedModules.Output({
			format: new loadedModules.Mp3OutputFormat(),
			target: new loadedModules.StreamTarget(commitControlledWritable.writable),
		});
		const source = new loadedModules.AudioBufferSource({
			codec: 'mp3',
			bitrate: AUDIO_EXPORT_BITRATE_BPS,
			bitrateMode: 'constant',
			transform: { numberOfChannels: 1 },
		});
		output.addAudioTrack(source);
		await output.start();

		let operationTail = Promise.resolve();
		let cancelPromise: Promise<void> | null = null;
		let finalized = false;
		const cancel = async (reason?: unknown): Promise<void> => {
			if (finalized) {
				return;
			}
			if (!cancelPromise) {
				cancelPromise = (async () => {
					const nativeAbort = commitControlledWritable.requestCancel(reason);
					const outputCancel = output ? output.cancel() : Promise.resolve();
					const [nativeAbortResult, outputCancelResult] = await Promise.allSettled([nativeAbort, outputCancel]);
					if (nativeAbortResult.status === 'rejected') {
						throw nativeAbortResult.reason;
					}
					if (outputCancelResult.status === 'rejected') {
						throw outputCancelResult.reason;
					}
				})();
			}
			await cancelPromise;
		};
		const enqueue = <Result>(operation: () => Promise<Result>): Promise<Result> => {
			const result = operationTail.then(operation);
			operationTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		};

		return {
			add: (buffer) =>
				enqueue(async () => {
					if (commitControlledWritable.isCancelled()) {
						throw commitControlledWritable.cancelError();
					}
					try {
						await source.add(buffer);
					} catch (error) {
						if (!commitControlledWritable.isCancelled()) {
							await cancel(error);
						}
						throw commitControlledWritable.isCancelled() ? commitControlledWritable.cancelError() : error;
					}
					if (commitControlledWritable.isCancelled()) {
						throw commitControlledWritable.cancelError();
					}
				}),
			finalize: () =>
				enqueue(async () => {
					if (commitControlledWritable.isCancelled()) {
						throw commitControlledWritable.cancelError();
					}
					try {
						await source.close();
						if (commitControlledWritable.isCancelled()) {
							throw commitControlledWritable.cancelError();
						}
						await output?.finalize();
						if (commitControlledWritable.isCancelled()) {
							throw commitControlledWritable.cancelError();
						}
						finalized = true;
					} catch (error) {
						if (!commitControlledWritable.isCancelled()) {
							await cancel(error);
						}
						throw commitControlledWritable.isCancelled() ? commitControlledWritable.cancelError() : error;
					}
				}),
			cancel,
			bytesWritten: () => commitControlledWritable.bytesWritten(),
			outputBlob: () => commitControlledWritable.outputBlob(),
		};
	} catch (error) {
		try {
			await output?.cancel();
		} finally {
			await commitControlledWritable.abortNative(error);
		}
		throw error;
	}
}
