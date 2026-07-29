import { AUDIO_EXPORT_BITRATE_BPS } from '../shared/audio_export.ts';
import type { StreamTargetChunk } from 'mediabunny';

export interface AudioExportEncoder {
	add(buffer: AudioBuffer): Promise<void>;
	finalize(): Promise<void>;
	cancel(reason?: unknown): Promise<void>;
	bytesWritten(): number;
}

type EncoderModules = {
	Output: new (options: { format: unknown; target: unknown }) => {
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

async function loadMp3Modules() {
	const [mediabunny, extension] = await Promise.all([
		import('mediabunny'),
		import('@mediabunny/mp3-encoder'),
	]);
	if (!(await mediabunny.canEncodeAudio('mp3'))) {
		extension.registerMp3Encoder();
	}
	return mediabunny;
}

function cancellationError(reason: unknown): Error {
	return reason instanceof Error ? reason : new DOMException('Cancelled', 'AbortError');
}

function createCommitControlledWritable(nativeWritable: NativeWritable) {
	let cancelRequested = false;
	let cancelReason: unknown;
	let bytesWritten = 0;
	let nativeAbort: Promise<void> | null = null;

	const abortNative = (reason?: unknown): Promise<void> => {
		if (!nativeAbort) {
			nativeAbort = nativeWritable.abort(reason);
		}
		return nativeAbort;
	};

	const writable = new WritableStream<StreamTargetChunk>({
		async write(chunk) {
			if (cancelRequested) {
				await abortNative(cancelReason);
				throw cancellationError(cancelReason);
			}
			await nativeWritable.write({ type: 'write', position: chunk.position, data: chunk.data });
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
			await nativeWritable.close();
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
		abortNative,
		cancelError() {
			return cancellationError(cancelReason);
		},
	};
}

export async function createAudioExportEncoder(
	handle: FileSystemFileHandle,
	modules?: EncoderModules,
): Promise<AudioExportEncoder> {
	const nativeWritable = (await handle.createWritable({ keepExistingData: false })) as NativeWritable;
	const commitControlledWritable = createCommitControlledWritable(nativeWritable);
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
