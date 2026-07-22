import type { CommandResponse } from '../shared/types.ts';
import { isPanelInstanceId } from '../shared/manual_playback.ts';

export type OffscreenCommand = { action: string; payload?: unknown };

export type ManualCheckpointMetadata = {
	sessionId: string;
	panelInstanceId: string;
	lang: string;
	voiceStyleId: string;
	speed: number;
};
export type OffscreenCommandResponse = CommandResponse & { checkpoint?: ManualCheckpointMetadata };

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
	sendMessage: (message: OffscreenCommand) => Promise<unknown>,
): Promise<OffscreenCommandResponse> {
	const response = await sendMessage(message);
	if (!response || typeof response !== 'object' || typeof (response as { success?: unknown }).success !== 'boolean') {
		return { success: false };
	}
	const checkpoint = (response as { checkpoint?: unknown }).checkpoint;
	if (checkpoint !== undefined && !isManualCheckpointMetadata(checkpoint)) {
		return { success: false };
	}
	return response as OffscreenCommandResponse;
}
