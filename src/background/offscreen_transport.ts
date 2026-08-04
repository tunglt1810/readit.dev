import {
	type AudioExportOffscreenAction,
	createAudioExportOffscreenEnvelope,
	isAudioExportEstimate,
	isAudioExportOffscreenAction,
	isInternalAudioExportOffscreenCommand,
	OFFSCREEN_AUDIO_EXPORT_TARGET,
} from '../shared/audio_export.ts';
import { isDocumentReaderSnapshot, type DocumentReaderSnapshot } from '../shared/document_reader.ts';
import { isPanelInstanceId } from '../shared/manual_playback.ts';
import type { AudioExportEstimate, CommandResponse, PlaybackContent, PlaybackContentScope, ReadableSurfaceKind } from '../shared/types.ts';

export type OffscreenCommand = { action: string; payload?: unknown; target?: string };

export function createAudioExportOffscreenCommand(action: AudioExportOffscreenAction, payload?: unknown): OffscreenCommand {
	return { action, ...(payload === undefined ? {} : { payload }), target: OFFSCREEN_AUDIO_EXPORT_TARGET };
}

export type OffscreenPlayPayload = {
	sessionId: string;
	article: PlaybackContent;
	voiceStyleId: string;
	speed: number;
	readableSurface: ReadableSurfaceKind;
	contentScope?: PlaybackContentScope;
	panelInstanceId?: string;
	documentTitle?: string;
};

export type ManualCheckpointMetadata = {
	sessionId: string;
	panelInstanceId: string;
	lang: string;
	voiceStyleId: string;
	speed: number;
};
export type OffscreenCommandResponse = CommandResponse & {
	checkpoint?: ManualCheckpointMetadata;
	snapshot?: DocumentReaderSnapshot;
	audioExportEstimate?: AudioExportEstimate;
};

export function isManualCheckpointMetadata(value: unknown): value is ManualCheckpointMetadata {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const checkpoint = value as Record<string, unknown>;
	return (
		typeof checkpoint.sessionId === 'string' &&
		isPanelInstanceId(checkpoint.panelInstanceId) &&
		typeof checkpoint.lang === 'string' &&
		typeof checkpoint.voiceStyleId === 'string' &&
		typeof checkpoint.speed === 'number' &&
		Number.isFinite(checkpoint.speed) &&
		Object.keys(checkpoint).length === 5
	);
}

export async function sendOffscreenCommand(
	message: OffscreenCommand,
	sendMessage: (message: unknown) => Promise<unknown>,
): Promise<OffscreenCommandResponse> {
	if (isAudioExportOffscreenAction(message.action) && !isInternalAudioExportOffscreenCommand(message)) {
		return { success: false };
	}
	const runtimeMessage = isInternalAudioExportOffscreenCommand(message) ? createAudioExportOffscreenEnvelope(message) : message;
	const response = await sendMessage(runtimeMessage);
	if (response && typeof response === 'object' && typeof (response as { success?: unknown }).success === 'boolean') {
		const checkpoint = (response as { checkpoint?: unknown }).checkpoint;
		const snapshot = (response as { snapshot?: unknown }).snapshot;
		const audioExportEstimate = (response as { audioExportEstimate?: unknown }).audioExportEstimate;
		if (
			(checkpoint === undefined || isManualCheckpointMetadata(checkpoint)) &&
			(snapshot === undefined || isDocumentReaderSnapshot(snapshot)) &&
			(audioExportEstimate === undefined || isAudioExportEstimate(audioExportEstimate))
		) {
			return response as OffscreenCommandResponse;
		}
	}
	return { success: false };
}
