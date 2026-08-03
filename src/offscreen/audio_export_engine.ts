import type { AudioExportEstimate } from '../shared/types.ts';
import type { AudioExportEncoder } from './audio_export_encoder.ts';
import { estimateSpeechUnitDurations } from './audio_export_estimate.ts';
import type { SpeechUnit } from './speech_unit.ts';
import type { Style } from './supertonic_helper.ts';

export interface PreparedAudioExport {
	jobId: string;
	playbackSessionId: string;
	outputFilename: string;
	units: readonly SpeechUnit[];
	language: string;
	voiceStyleId: string;
	style: Style;
	speed: number;
	estimate: AudioExportEstimate;
}

export interface AudioExportProgress {
	jobId: string;
	state: 'waiting-for-playback' | 'exporting' | 'completed' | 'cancelled' | 'failed';
	processedDurationSeconds: number;
	progressPercentage: number;
	bytesWritten: number;
	etaSeconds?: number;
}

export interface AudioExportEngineDependencies {
	takeHandle(jobId: string): Promise<FileSystemFileHandle | null>;
	deleteHandle(jobId: string): Promise<void>;
	createEncoder(handle: FileSystemFileHandle | null): Promise<AudioExportEncoder>;
	download?: (blob: Blob, filename: string) => Promise<void>;
	canDownload?: () => boolean;
	synthesize(input: { unit: SpeechUnit; language: string; style: Style; speed: number }): Promise<AudioBuffer>;
	canStartBackgroundSynthesis(): boolean;
	waitForRunway(): Promise<void>;
	wakeRunway(): void;
	onProgress(progress: AudioExportProgress): void;
	now(): number;
}

export interface AudioExportEngine {
	prepare(input: PreparedAudioExport): void;
	start(jobId: string): Promise<void>;
	cancel(jobId: string): Promise<void>;
	discard(jobId: string): Promise<void>;
	hasWork(): boolean;
}

type PreparedWork = {
	input: PreparedAudioExport;
	cancelled: boolean;
	cancelReason: unknown;
	started: boolean;
	encoder: AudioExportEncoder | null;
	cancelEncoder: Promise<void> | null;
	lastState: AudioExportProgress['state'] | null;
	lastProgressPercentage: number;
	lastBytesWritten: number;
};

function cloneUnits(units: readonly SpeechUnit[]): SpeechUnit[] {
	return units.map((unit) => ({
		...unit,
		wordMap: unit.wordMap?.map((entry) => ({ ...entry })),
	}));
}

function cancellationError(reason: unknown): Error {
	return reason instanceof Error ? reason : new DOMException('Audio export cancelled', 'AbortError');
}

export class AudioExportEngine implements AudioExportEngine {
	private work: PreparedWork | null = null;
	private readonly dependencies: AudioExportEngineDependencies;

	constructor(dependencies: AudioExportEngineDependencies) {
		this.dependencies = dependencies;
	}

	prepare(input: PreparedAudioExport): void {
		if (this.work) {
			throw new Error('An audio export is already prepared');
		}
		this.work = {
			input: { ...input, units: cloneUnits(input.units), estimate: { ...input.estimate } },
			cancelled: false,
			cancelReason: undefined,
			started: false,
			encoder: null,
			cancelEncoder: null,
			lastState: null,
			lastProgressPercentage: -1,
			lastBytesWritten: -1,
		};
	}

	start(jobId: string): Promise<void> {
		const work = this.requireWork(jobId);
		if (work.started) {
			throw new Error('Audio export is already active');
		}
		work.started = true;
		return this.run(work);
	}

	async cancel(jobId: string): Promise<void> {
		const work = this.work;
		if (!work || work.input.jobId !== jobId) {
			return;
		}
		work.cancelled = true;
		work.cancelReason ??= new DOMException('Audio export cancelled', 'AbortError');
		this.dependencies.wakeRunway();
		await this.cancelEncoder(work);
	}

	async discard(jobId: string): Promise<void> {
		const work = this.work;
		if (!work || work.input.jobId !== jobId) {
			return;
		}
		if (work.started) {
			await this.cancel(jobId);
			return;
		}
		this.work = null;
		await this.dependencies.deleteHandle(jobId);
	}

	hasWork(): boolean {
		return this.work !== null;
	}

	private requireWork(jobId: string): PreparedWork {
		if (!this.work || this.work.input.jobId !== jobId) {
			throw new Error('Audio export is not prepared');
		}
		return this.work;
	}

	private throwIfCancelled(work: PreparedWork): void {
		if (work.cancelled) {
			throw cancellationError(work.cancelReason);
		}
	}

	private async cancelEncoder(work: PreparedWork): Promise<void> {
		if (!work.encoder || work.cancelEncoder) {
			await work.cancelEncoder;
			return;
		}
		work.cancelEncoder = work.encoder.cancel(work.cancelReason);
		await work.cancelEncoder;
	}

	private report(
		work: PreparedWork,
		state: AudioExportProgress['state'],
		processedDurationSeconds: number,
		startedAt: number,
		force = false,
	): void {
		const totalDurationSeconds = work.input.estimate.durationSeconds;
		const progressPercentage =
			state === 'completed'
				? 100
				: Math.min(99, Math.max(0, Math.floor((processedDurationSeconds / Math.max(totalDurationSeconds, 0.001)) * 100)));
		const bytesWritten = work.encoder?.bytesWritten() ?? 0;
		const elapsedSeconds = Math.max(0, (this.dependencies.now() - startedAt) / 1_000);
		const etaSeconds =
			processedDurationSeconds > 0 && elapsedSeconds > 0
				? Math.max(0, ((totalDurationSeconds - processedDurationSeconds) * elapsedSeconds) / processedDurationSeconds)
				: undefined;
		const changed =
			state !== work.lastState || progressPercentage > work.lastProgressPercentage || bytesWritten - work.lastBytesWritten >= 1_024;
		if (!force && !changed) {
			return;
		}
		work.lastState = state;
		work.lastProgressPercentage = Math.max(work.lastProgressPercentage, progressPercentage);
		work.lastBytesWritten = Math.max(work.lastBytesWritten, bytesWritten);
		this.dependencies.onProgress({
			jobId: work.input.jobId,
			state,
			processedDurationSeconds,
			progressPercentage,
			bytesWritten,
			...(etaSeconds === undefined ? {} : { etaSeconds }),
		});
	}

	private async waitForSafeRunway(work: PreparedWork, processedDurationSeconds: number, startedAt: number): Promise<void> {
		this.throwIfCancelled(work);
		while (!this.dependencies.canStartBackgroundSynthesis()) {
			this.report(work, 'waiting-for-playback', processedDurationSeconds, startedAt);
			await this.dependencies.waitForRunway();
			this.throwIfCancelled(work);
		}
		this.report(work, 'exporting', processedDurationSeconds, startedAt);
	}

	private async cleanup(work: PreparedWork, abort: boolean): Promise<void> {
		try {
			if (abort) {
				await this.cancelEncoder(work);
			}
		} finally {
			try {
				await this.dependencies.deleteHandle(work.input.jobId);
			} finally {
				if (this.work === work) {
					this.work = null;
				}
			}
		}
	}

	private async run(work: PreparedWork): Promise<void> {
		const startedAt = this.dependencies.now();
		let processedDurationSeconds = 0;
		try {
			const handle = await this.dependencies.takeHandle(work.input.jobId);
			this.throwIfCancelled(work);
			if (!handle && (!this.dependencies.download || this.dependencies.canDownload?.() === false)) {
				throw new Error('Audio export download is unavailable');
			}
			await this.waitForSafeRunway(work, processedDurationSeconds, startedAt);
			this.throwIfCancelled(work);
			work.encoder = await this.dependencies.createEncoder(handle);
			this.throwIfCancelled(work);

			const durations = estimateSpeechUnitDurations(work.input.units, work.input.language, work.input.speed);
			this.report(work, 'exporting', processedDurationSeconds, startedAt);
			for (const [index, unit] of work.input.units.entries()) {
				this.throwIfCancelled(work);
				await this.waitForSafeRunway(work, processedDurationSeconds, startedAt);
				this.throwIfCancelled(work);
				let buffer: AudioBuffer | null = await this.dependencies.synthesize({
					unit,
					language: work.input.language,
					style: work.input.style,
					speed: work.input.speed,
				});
				this.throwIfCancelled(work);
				await work.encoder.add(buffer);
				buffer = null;
				this.throwIfCancelled(work);
				processedDurationSeconds += durations[index] ?? 0;
				this.report(work, 'exporting', processedDurationSeconds, startedAt);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}

			this.throwIfCancelled(work);
			await work.encoder.finalize();
			this.throwIfCancelled(work);
			if (!handle) {
				const outputBlob = work.encoder.outputBlob?.();
				if (!outputBlob || !this.dependencies.download) {
					throw new Error('Audio export download is unavailable');
				}
				await this.dependencies.download(outputBlob, work.input.outputFilename);
			}
			await this.cleanup(work, false);
			this.report(work, 'completed', processedDurationSeconds, startedAt, true);
		} catch (error) {
			const terminalError = work.cancelled ? cancellationError(work.cancelReason) : error;
			try {
				await this.cleanup(work, true);
			} catch (_cleanupError) {
				// The terminal progress report must survive cleanup failures.
			}
			this.report(work, work.cancelled ? 'cancelled' : 'failed', processedDurationSeconds, startedAt, true);
			throw terminalError;
		}
	}
}
