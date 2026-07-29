import type { AudioExportJobSnapshot, AudioExportJobState } from '../shared/types.ts';

export type AudioExportProgressUpdate = {
	jobId: string;
	state: 'waiting-for-playback' | 'exporting' | 'completed' | 'failed';
	processedDurationSeconds: number;
	progressPercentage: number;
	bytesWritten: number;
	etaSeconds?: number;
};

export function isAudioExportProgressUpdate(value: unknown): value is AudioExportProgressUpdate {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const progress = value as Record<string, unknown>;
	return (
		typeof progress.jobId === 'string' &&
		progress.jobId.length > 0 &&
		(progress.state === 'waiting-for-playback' ||
			progress.state === 'exporting' ||
			progress.state === 'completed' ||
			progress.state === 'failed') &&
		isFiniteNonNegative(progress.processedDurationSeconds) &&
		isFiniteNonNegative(progress.progressPercentage) &&
		progress.progressPercentage <= 100 &&
		isFiniteNonNegative(progress.bytesWritten) &&
		(progress.etaSeconds === undefined || isFiniteNonNegative(progress.etaSeconds))
	);
}

type NewAudioExportJob = {
	jobId: string;
	playbackSessionId: string;
	title: string;
	outputFilename: string;
	estimate: AudioExportJobSnapshot['estimate'];
	now: number;
};

const TRANSITIONS: Record<AudioExportJobState, readonly AudioExportJobState[]> = {
	preparing: ['exporting', 'failed'],
	exporting: ['waiting-for-playback', 'cancelling', 'completed', 'failed'],
	'waiting-for-playback': ['exporting', 'cancelling', 'completed', 'failed'],
	cancelling: ['failed'],
	completed: [],
	failed: [],
	interrupted: [],
};

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function createAudioExportJob(input: NewAudioExportJob): AudioExportJobSnapshot {
	return {
		jobId: input.jobId,
		playbackSessionId: input.playbackSessionId,
		title: input.title,
		outputFilename: input.outputFilename,
		state: 'preparing',
		estimate: { ...input.estimate },
		processedDurationSeconds: 0,
		progressPercentage: 0,
		bytesWritten: 0,
		startedAt: input.now,
		updatedAt: input.now,
	};
}

export function transitionAudioExportJob(
	job: AudioExportJobSnapshot,
	state: AudioExportJobState,
	now: number,
	options: { errorCode?: AudioExportJobSnapshot['errorCode']; hydration?: boolean } = {},
): AudioExportJobSnapshot | null {
	if (state === 'interrupted') {
		if (!options.hydration || !isAudioExportActiveState(job.state)) {
			return null;
		}
	} else if (!TRANSITIONS[job.state].includes(state)) {
		return null;
	}
	return {
		...job,
		state,
		updatedAt: now,
		...(options.errorCode === undefined ? { errorCode: undefined } : { errorCode: options.errorCode }),
	};
}

export function applyAudioExportProgress(
	job: AudioExportJobSnapshot,
	progress: AudioExportProgressUpdate,
	now = job.updatedAt,
): AudioExportJobSnapshot | null {
	if (
		!isAudioExportActiveState(job.state) ||
		progress.jobId !== job.jobId ||
		!isFiniteNonNegative(progress.processedDurationSeconds) ||
		progress.processedDurationSeconds > job.estimate.durationSeconds ||
		!isFiniteNonNegative(progress.progressPercentage) ||
		progress.progressPercentage > 100 ||
		!isFiniteNonNegative(progress.bytesWritten) ||
		(progress.etaSeconds !== undefined && !isFiniteNonNegative(progress.etaSeconds)) ||
		progress.processedDurationSeconds < job.processedDurationSeconds ||
		progress.progressPercentage < job.progressPercentage ||
		progress.bytesWritten < job.bytesWritten
	) {
		return null;
	}
	const transitioned = progress.state === job.state ? { ...job, updatedAt: now } : transitionAudioExportJob(job, progress.state, now);
	if (!transitioned) {
		return null;
	}
	return {
		...transitioned,
		processedDurationSeconds: progress.processedDurationSeconds,
		progressPercentage: progress.progressPercentage,
		bytesWritten: progress.bytesWritten,
		...(progress.etaSeconds === undefined ? { etaSeconds: undefined } : { etaSeconds: progress.etaSeconds }),
	};
}

export function isAudioExportActiveState(state: AudioExportJobState): boolean {
	return state === 'preparing' || state === 'exporting' || state === 'waiting-for-playback' || state === 'cancelling';
}
