import { isAudioExportEstimate, isAudioExportJobSnapshot } from '../shared/audio_export.ts';
import type { CommandResponse, PlaybackSessionSnapshot, AudioExportJobSnapshot } from '../shared/types.ts';
import {
	type AudioExportProgressUpdate,
	applyAudioExportProgress,
	createAudioExportJob,
	isAudioExportActiveState,
	transitionAudioExportJob,
} from './audio_export_state.ts';
import { createAudioExportOffscreenCommand, type OffscreenCommand, type OffscreenCommandResponse } from './offscreen_transport.ts';

export const AUDIO_EXPORT_PREPARATION_TIMEOUT_MS = 10 * 60 * 1_000;

export type AudioExportPrepareRequest = {
	jobId: string;
	playbackSessionId: string;
	title: string;
	outputFilename: string;
};

type AudioExportCoordinatorDependencies = {
	storage: {
		get(): Promise<unknown>;
		set(job: AudioExportJobSnapshot): Promise<void>;
		remove(): Promise<void>;
	};
	getPlaybackSession(): PlaybackSessionSnapshot | null;
	ensureOffscreen(): Promise<void>;
	sendOffscreen(command: OffscreenCommand): Promise<OffscreenCommandResponse>;
	deleteHandle(jobId: string): Promise<void>;
	broadcast(job: AudioExportJobSnapshot | null): Promise<void>;
	now(): number;
	setTimeout(callback: () => Promise<void>, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

function validPrepareRequest(value: AudioExportPrepareRequest): boolean {
	return (
		typeof value.jobId === 'string' &&
		value.jobId.length > 0 &&
		typeof value.playbackSessionId === 'string' &&
		value.playbackSessionId.length > 0 &&
		typeof value.title === 'string' &&
		typeof value.outputFilename === 'string' &&
		value.outputFilename.length > 0
	);
}

export function isAudioExportPrepareRequest(value: unknown): value is AudioExportPrepareRequest {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const request = value as Record<string, unknown>;
	return (
		Object.keys(request).length === 4 &&
		typeof request.jobId === 'string' &&
		typeof request.playbackSessionId === 'string' &&
		typeof request.title === 'string' &&
		typeof request.outputFilename === 'string'
	);
}

export class AudioExportCoordinator {
	private job: AudioExportJobSnapshot | null = null;
	private preparationTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly dependencies: AudioExportCoordinatorDependencies;

	constructor(dependencies: AudioExportCoordinatorDependencies) {
		this.dependencies = dependencies;
	}

	snapshot(): AudioExportJobSnapshot | null {
		return this.job ? { ...this.job, estimate: { ...this.job.estimate } } : null;
	}

	hasWork(): boolean {
		return this.job !== null && isAudioExportActiveState(this.job.state);
	}

	async hydrate(): Promise<void> {
		const stored = await this.dependencies.storage.get();
		if (stored === undefined || stored === null) {
			this.job = null;
			return;
		}
		if (!isAudioExportJobSnapshot(stored)) {
			this.job = null;
			await this.dependencies.storage.remove();
			await this.dependencies.broadcast(null);
			return;
		}
		if (!isAudioExportActiveState(stored.state)) {
			this.job = stored;
			await this.dependencies.broadcast(this.snapshot());
			return;
		}

		const stalePreparation = stored.state === 'preparing' && this.isPreparationStale(stored);
		await this.bestEffortOffscreenCleanup(stored);
		const interrupted = transitionAudioExportJob(stored, 'interrupted', this.dependencies.now(), {
			hydration: true,
			errorCode: stalePreparation ? 'snapshot-unavailable' : 'interrupted',
		});
		if (!interrupted) {
			return;
		}
		this.job = interrupted;
		await this.dependencies.storage.set(interrupted);
		await this.dependencies.deleteHandle(interrupted.jobId);
		await this.dependencies.broadcast(this.snapshot());
	}

	async prepare(request: AudioExportPrepareRequest): Promise<CommandResponse> {
		const session = this.dependencies.getPlaybackSession();
		if (
			!validPrepareRequest(request) ||
			this.hasWork() ||
			!session ||
			session.sessionId !== request.playbackSessionId ||
			!isAudioExportEstimate(session.audioExportEstimate)
		) {
			return { success: false, error: 'snapshot-unavailable' };
		}

		const job = createAudioExportJob({
			...request,
			estimate: session.audioExportEstimate,
			now: this.dependencies.now(),
		});
		await this.publish(job);
		this.schedulePreparationExpiry(job);
		try {
			await this.dependencies.ensureOffscreen();
			const response = await this.dependencies.sendOffscreen(
				createAudioExportOffscreenCommand('PREPARE_AUDIO_EXPORT', {
					jobId: job.jobId,
					playbackSessionId: job.playbackSessionId,
					outputFilename: job.outputFilename,
					estimate: job.estimate,
				}),
			);
			if (!response.success) {
				await this.fail(job.jobId, 'snapshot-unavailable');
				return { success: false, error: 'snapshot-unavailable' };
			}
			return { success: true };
		} catch (_error) {
			await this.fail(job.jobId, 'snapshot-unavailable');
			return { success: false, error: 'snapshot-unavailable' };
		}
	}

	async start(jobId: string): Promise<CommandResponse> {
		const job = this.job;
		if (!job || job.jobId !== jobId || job.state !== 'preparing') {
			return { success: false, error: 'snapshot-unavailable' };
		}
		const exporting = transitionAudioExportJob(job, 'exporting', this.dependencies.now());
		if (!exporting) {
			return { success: false, error: 'snapshot-unavailable' };
		}
		await this.publish(exporting);
		try {
			const response = await this.dependencies.sendOffscreen(createAudioExportOffscreenCommand('START_AUDIO_EXPORT', { jobId }));
			if (!response.success) {
				await this.fail(jobId, 'encoding-failed');
				return { success: false, error: 'encoding-failed' };
			}
			return { success: true };
		} catch (_error) {
			await this.fail(jobId, 'encoding-failed');
			return { success: false, error: 'encoding-failed' };
		}
	}

	async cancel(jobId: string): Promise<CommandResponse> {
		const job = this.job;
		if (!job || job.jobId !== jobId) {
			return { success: false, error: 'snapshot-unavailable' };
		}
		if (job.state === 'preparing') {
			return this.discard(jobId);
		}
		if (job.state === 'failed' && job.errorCode === 'encoding-failed') {
			await this.clear(jobId);
			return { success: true };
		}
		if (job.state !== 'exporting' && job.state !== 'waiting-for-playback') {
			return { success: false, error: 'snapshot-unavailable' };
		}
		const cancelling = transitionAudioExportJob(job, 'cancelling', this.dependencies.now());
		if (!cancelling) {
			return { success: false, error: 'snapshot-unavailable' };
		}
		await this.publish(cancelling);
		try {
			const response = await this.dependencies.sendOffscreen(createAudioExportOffscreenCommand('CANCEL_AUDIO_EXPORT', { jobId }));
			if (!response.success) {
				await this.clear(jobId);
				return { success: true };
			}
			await this.clear(jobId);
			return { success: true };
		} catch (_error) {
			await this.clear(jobId);
			return { success: true };
		}
	}

	async discard(jobId: string): Promise<CommandResponse> {
		const job = this.job;
		if (!job || job.jobId !== jobId || job.state !== 'preparing') {
			return { success: false, error: 'snapshot-unavailable' };
		}
		try {
			await this.dependencies.sendOffscreen(createAudioExportOffscreenCommand('DISCARD_AUDIO_EXPORT', { jobId }));
		} catch (_error) {
			// Discard is local cleanup too, so a missing offscreen receiver is not an error.
		} finally {
			await this.clear(jobId);
		}
		return { success: true };
	}

	async handleProgress(progress: AudioExportProgressUpdate): Promise<void> {
		const job = this.job;
		if (!job || job.state === 'cancelling') {
			return;
		}
		const updated = applyAudioExportProgress(job, progress, this.dependencies.now());
		if (!updated) {
			return;
		}
		const terminal = updated.state === 'completed' || updated.state === 'failed';
		await this.publish(terminal && updated.state === 'failed' ? { ...updated, errorCode: 'encoding-failed' } : updated);
		if (terminal) {
			await this.dependencies.deleteHandle(updated.jobId);
		}
	}

	async expirePreparation(jobId: string): Promise<void> {
		const job = this.job;
		if (!job || job.jobId !== jobId || job.state !== 'preparing' || !this.isPreparationStale(job)) {
			return;
		}
		await this.bestEffortOffscreenCleanup(job);
		await this.fail(jobId, 'snapshot-unavailable');
	}

	private isPreparationStale(job: AudioExportJobSnapshot): boolean {
		return this.dependencies.now() - job.updatedAt >= AUDIO_EXPORT_PREPARATION_TIMEOUT_MS;
	}

	private schedulePreparationExpiry(job: AudioExportJobSnapshot): void {
		this.clearPreparationTimer();
		const remaining = Math.max(0, AUDIO_EXPORT_PREPARATION_TIMEOUT_MS - (this.dependencies.now() - job.updatedAt));
		this.preparationTimer = this.dependencies.setTimeout(() => this.expirePreparation(job.jobId), remaining);
	}

	private clearPreparationTimer(): void {
		if (this.preparationTimer !== null) {
			this.dependencies.clearTimeout(this.preparationTimer);
			this.preparationTimer = null;
		}
	}

	private async fail(jobId: string, errorCode: 'snapshot-unavailable' | 'encoding-failed'): Promise<void> {
		const job = this.job;
		if (!job || job.jobId !== jobId) {
			return;
		}
		const failed = transitionAudioExportJob(job, 'failed', this.dependencies.now(), { errorCode });
		if (!failed) {
			return;
		}
		await this.publish(failed);
		await this.dependencies.deleteHandle(jobId);
	}

	private async bestEffortOffscreenCleanup(job: AudioExportJobSnapshot): Promise<void> {
		const action = job.state === 'preparing' ? 'DISCARD_AUDIO_EXPORT' : 'CANCEL_AUDIO_EXPORT';
		try {
			await this.dependencies.sendOffscreen(createAudioExportOffscreenCommand(action, { jobId: job.jobId }));
		} catch (_error) {
			// The old offscreen document may already be gone after a worker restart.
		}
	}

	private async clear(jobId: string): Promise<void> {
		if (this.job?.jobId !== jobId) {
			return;
		}
		this.clearPreparationTimer();
		await this.dependencies.deleteHandle(jobId);
		this.job = null;
		await this.dependencies.storage.remove();
		await this.dependencies.broadcast(null);
	}

	private async publish(job: AudioExportJobSnapshot): Promise<void> {
		this.job = job;
		if (job.state !== 'preparing') {
			this.clearPreparationTimer();
		}
		await this.dependencies.storage.set(job);
		await this.dependencies.broadcast(this.snapshot());
	}
}

export function createAudioExportCoordinator(dependencies: AudioExportCoordinatorDependencies): AudioExportCoordinator {
	return new AudioExportCoordinator(dependencies);
}
