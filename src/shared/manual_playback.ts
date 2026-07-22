import type { ManualTextLanguage } from './types.ts';

const PANEL_INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ManualPlaybackStartPayload = {
	text: string;
	language: ManualTextLanguage;
	panelInstanceId: string;
};

export type ManualPlaybackControlMessage =
	| { action: 'RESUME_MANUAL_CHECKPOINT'; panelInstanceId: string }
	| { action: 'DISCARD_MANUAL_CHECKPOINT'; panelInstanceId: string }
	| { action: 'STOP_SIDE_PANEL_AUDIO'; panelInstanceId: string };

type ManualWordEventFields = {
	sessionId: string;
	word: string;
	wordIndex: number;
};

export type ManualWordTimingMessage = ManualWordEventFields & {
	action: 'OFFSCREEN_MANUAL_WORD_TIMING';
};

export type ManualWordHighlightMessage = ManualWordEventFields & {
	action: 'MANUAL_WORD_HIGHLIGHT_UPDATE';
};

export function isPanelInstanceId(value: unknown): value is string {
	return typeof value === 'string' && PANEL_INSTANCE_ID.test(value);
}

export function isManualPlaybackControlMessage(value: unknown): value is ManualPlaybackControlMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as { action?: unknown; panelInstanceId?: unknown };
	return (
		(message.action === 'RESUME_MANUAL_CHECKPOINT' ||
			message.action === 'DISCARD_MANUAL_CHECKPOINT' ||
			message.action === 'STOP_SIDE_PANEL_AUDIO') &&
		isPanelInstanceId(message.panelInstanceId)
	);
}

export function isManualWordTimingMessage(value: unknown): value is ManualWordTimingMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Partial<ManualWordTimingMessage>;
	return (
		message.action === 'OFFSCREEN_MANUAL_WORD_TIMING' &&
		typeof message.sessionId === 'string' &&
		message.sessionId.length > 0 &&
		typeof message.word === 'string' &&
		message.word.length > 0 &&
		typeof message.wordIndex === 'number' &&
		Number.isInteger(message.wordIndex) &&
		message.wordIndex >= 0
	);
}
