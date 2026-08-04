import type {
	AudioExportErrorCode,
	AudioExportEstimate,
	AudioExportJobSnapshot,
	AudioExportJobState,
	PlaybackSessionSnapshot,
} from './types.ts';

export const AUDIO_EXPORT_BITRATE_BPS = 96_000;
export const LONG_AUDIO_EXPORT_SECONDS = 60 * 60;
export const MP3_CONTAINER_OVERHEAD_BYTES = 4_096;
export const OFFSCREEN_AUDIO_EXPORT_TARGET = 'readit-offscreen-audio-export';

export const AUDIO_EXPORT_OFFSCREEN_ACTIONS = [
	'PREPARE_AUDIO_EXPORT',
	'START_AUDIO_EXPORT',
	'CANCEL_AUDIO_EXPORT',
	'DISCARD_AUDIO_EXPORT',
] as const;

export type AudioExportOffscreenAction = (typeof AUDIO_EXPORT_OFFSCREEN_ACTIONS)[number];

type InternalAudioExportOffscreenCommand = {
	action: AudioExportOffscreenAction;
	payload?: unknown;
	target: typeof OFFSCREEN_AUDIO_EXPORT_TARGET;
};

export type AudioExportOffscreenEnvelope = {
	target: typeof OFFSCREEN_AUDIO_EXPORT_TARGET;
	command: Omit<InternalAudioExportOffscreenCommand, 'target'>;
};

export function isAudioExportOffscreenAction(value: unknown): value is AudioExportOffscreenAction {
	return typeof value === 'string' && (AUDIO_EXPORT_OFFSCREEN_ACTIONS as readonly string[]).includes(value);
}

function isLegacyInternalAudioExportOffscreenCommand(value: unknown): value is InternalAudioExportOffscreenCommand {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const command = value as { action?: unknown; target?: unknown };
	return command.target === OFFSCREEN_AUDIO_EXPORT_TARGET && isAudioExportOffscreenAction(command.action);
}

export function isAudioExportOffscreenEnvelope(value: unknown): value is AudioExportOffscreenEnvelope {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const envelope = value as { target?: unknown; command?: unknown };
	if (envelope.target !== OFFSCREEN_AUDIO_EXPORT_TARGET || !envelope.command || typeof envelope.command !== 'object') {
		return false;
	}
	const command = envelope.command as { action?: unknown };
	return isAudioExportOffscreenAction(command.action);
}

export function createAudioExportOffscreenEnvelope(command: InternalAudioExportOffscreenCommand): AudioExportOffscreenEnvelope {
	return {
		target: OFFSCREEN_AUDIO_EXPORT_TARGET,
		command: {
			action: command.action,
			...(command.payload === undefined ? {} : { payload: command.payload }),
		},
	};
}

export function unwrapAudioExportOffscreenCommand(value: unknown): InternalAudioExportOffscreenCommand | null {
	if (isLegacyInternalAudioExportOffscreenCommand(value)) {
		return value;
	}
	if (!isAudioExportOffscreenEnvelope(value)) {
		return null;
	}
	return {
		target: OFFSCREEN_AUDIO_EXPORT_TARGET,
		action: value.command.action,
		...(value.command.payload === undefined ? {} : { payload: value.command.payload }),
	};
}

export function isInternalAudioExportOffscreenCommand(value: unknown): value is InternalAudioExportOffscreenCommand | AudioExportOffscreenEnvelope {
	return unwrapAudioExportOffscreenCommand(value) !== null;
}

const AUDIO_EXPORT_JOB_STATES = new Set<AudioExportJobState>([
	'preparing',
	'exporting',
	'waiting-for-playback',
	'cancelling',
	'completed',
	'failed',
	'interrupted',
]);

const AUDIO_EXPORT_ERROR_CODES = new Set<AudioExportErrorCode>([
	'permission-denied',
	'write-failed',
	'encoding-failed',
	'snapshot-unavailable',
	'interrupted',
]);

const AUDIO_EXPORT_JOB_KEYS = new Set([
	'jobId',
	'playbackSessionId',
	'title',
	'outputFilename',
	'state',
	'estimate',
	'processedDurationSeconds',
	'progressPercentage',
	'bytesWritten',
	'etaSeconds',
	'startedAt',
	'updatedAt',
	'errorCode',
]);

function isFiniteNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function createAudioExportEstimate(durationSeconds: number): AudioExportEstimate {
	return {
		durationSeconds,
		estimatedBytes: (durationSeconds * AUDIO_EXPORT_BITRATE_BPS) / 8 + MP3_CONTAINER_OVERHEAD_BYTES,
	};
}

export function requiresLongAudioExportConfirmation(estimate: AudioExportEstimate): boolean {
	return estimate.durationSeconds >= LONG_AUDIO_EXPORT_SECONDS;
}

export function sanitizeMp3Filename(value: string): string {
	const baseName = value
		.trim()
		.replace(/\.mp3$/iu, '')
		.replace(/[<>:"/\\|?*]+/gu, '-')
		.replace(/[. ]+$/gu, '')
		.trim();
	return `${baseName || 'readit-export'}.mp3`;
}

function formatLocalTimestamp(now: Date): string {
	const pad = (value: number) => value.toString().padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

export function suggestAudioExportFilename(session: PlaybackSessionSnapshot, now: Date): string {
	if (session.contentScope === 'manual') {
		return sanitizeMp3Filename(`readit-pasted-text-${formatLocalTimestamp(now)}`);
	}
	const suffix = session.contentScope === 'selection' ? '-selection' : '';
	return sanitizeMp3Filename(`${session.source.title}${suffix}`);
}

export function isAudioExportEstimate(value: unknown): value is AudioExportEstimate {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const estimate = value as Record<string, unknown>;
	return (
		Object.keys(estimate).length === 2 &&
		Object.hasOwn(estimate, 'durationSeconds') &&
		Object.hasOwn(estimate, 'estimatedBytes') &&
		isFiniteNonNegativeNumber(estimate.durationSeconds) &&
		isFiniteNonNegativeNumber(estimate.estimatedBytes)
	);
}

export function isAudioExportJobSnapshot(value: unknown): value is AudioExportJobSnapshot {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const job = value as Record<string, unknown>;
	return (
		Object.keys(job).every((key) => AUDIO_EXPORT_JOB_KEYS.has(key)) &&
		typeof job.jobId === 'string' &&
		typeof job.playbackSessionId === 'string' &&
		typeof job.title === 'string' &&
		typeof job.outputFilename === 'string' &&
		typeof job.state === 'string' &&
		AUDIO_EXPORT_JOB_STATES.has(job.state as AudioExportJobState) &&
		isAudioExportEstimate(job.estimate) &&
		isFiniteNonNegativeNumber(job.processedDurationSeconds) &&
		job.processedDurationSeconds <= job.estimate.durationSeconds &&
		isFiniteNonNegativeNumber(job.progressPercentage) &&
		job.progressPercentage <= 100 &&
		isFiniteNonNegativeNumber(job.bytesWritten) &&
		(job.etaSeconds === undefined || isFiniteNonNegativeNumber(job.etaSeconds)) &&
		isFiniteNonNegativeNumber(job.startedAt) &&
		isFiniteNonNegativeNumber(job.updatedAt) &&
		(job.errorCode === undefined ||
			(typeof job.errorCode === 'string' && AUDIO_EXPORT_ERROR_CODES.has(job.errorCode as AudioExportErrorCode)))
	);
}

export function isAudioExportActive(job: AudioExportJobSnapshot | null): boolean {
	return (
		job !== null &&
		(job.state === 'preparing' || job.state === 'exporting' || job.state === 'waiting-for-playback' || job.state === 'cancelling')
	);
}
