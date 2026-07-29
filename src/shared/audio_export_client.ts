import { isAudioExportJobSnapshot } from './audio_export.ts';
import { type RuntimeLike, sendRuntimeRequest } from './playback_client.ts';
import type { AudioExportJobSnapshot, AudioExportStateResponse, CommandResponse } from './types.ts';

export type AudioExportRuntimeLike = RuntimeLike;

function isAudioExportStateResponse(value: unknown): value is AudioExportStateResponse {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const response = value as Record<string, unknown>;
	return Object.keys(response).length === 1 && (response.job === null || isAudioExportJobSnapshot(response.job));
}

function isCommandResponse(value: unknown): value is CommandResponse {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const response = value as Record<string, unknown>;
	return (
		Object.keys(response).every((key) => key === 'success' || key === 'error' || key === 'transportError') &&
		typeof response.success === 'boolean' &&
		(response.error === undefined || typeof response.error === 'string') &&
		(response.transportError === undefined || response.transportError === true)
	);
}

function transportFailure(error: unknown): CommandResponse {
	return {
		success: false,
		error: error instanceof Error ? error.message : String(error),
		transportError: true,
	};
}

export async function requestAudioExportState(runtime: AudioExportRuntimeLike = chrome.runtime): Promise<AudioExportStateResponse> {
	const response = await sendRuntimeRequest<unknown>({ action: 'GET_AUDIO_EXPORT_STATE' }, runtime);
	if (!isAudioExportStateResponse(response)) {
		throw new Error('Extension runtime request returned a malformed audio export response.');
	}
	return response;
}

export function sendAudioExportCommand<T extends CommandResponse = CommandResponse>(
	message: unknown,
	runtime: AudioExportRuntimeLike = chrome.runtime,
): Promise<T> {
	return sendRuntimeRequest<unknown>(message, runtime)
		.then((response) => {
			if (!isCommandResponse(response)) {
				throw new Error('Extension runtime request returned a malformed audio export command response.');
			}
			return response as T;
		})
		.catch((error: unknown) => transportFailure(error) as T);
}

export function prepareAudioExport(
	payload: { jobId: string; playbackSessionId: string; title: string; outputFilename: string },
	runtime?: AudioExportRuntimeLike,
): Promise<CommandResponse> {
	return sendAudioExportCommand({ action: 'PREPARE_AUDIO_EXPORT', payload }, runtime);
}

export function startAudioExport(jobId: string, runtime?: AudioExportRuntimeLike): Promise<CommandResponse> {
	return sendAudioExportCommand({ action: 'START_AUDIO_EXPORT', payload: { jobId } }, runtime);
}

export function cancelAudioExport(jobId: string, runtime?: AudioExportRuntimeLike): Promise<CommandResponse> {
	return sendAudioExportCommand({ action: 'CANCEL_AUDIO_EXPORT', payload: { jobId } }, runtime);
}

export function discardAudioExport(jobId: string, runtime?: AudioExportRuntimeLike): Promise<CommandResponse> {
	return sendAudioExportCommand({ action: 'DISCARD_AUDIO_EXPORT', payload: { jobId } }, runtime);
}

export function subscribeAudioExportState(
	runtime: AudioExportRuntimeLike,
	listener: (job: AudioExportJobSnapshot | null) => void,
): () => void {
	const messageListener = (message: unknown) => {
		if (!message || typeof message !== 'object') {
			return;
		}
		const value = message as { action?: unknown; job?: unknown };
		if (value.action === 'AUDIO_EXPORT_STATE_UPDATE' && (value.job === null || isAudioExportJobSnapshot(value.job))) {
			listener(value.job);
		}
	};
	runtime.onMessage.addListener(messageListener);
	return () => runtime.onMessage.removeListener(messageListener);
}
