import type { ReadableSurfaceWord } from './readable_surface.ts';
import type { PlaybackContentScope } from './types';

export const WORD_HIGHLIGHT_NAME = 'readit-dev-word-highlight';

export type WordHighlightContentScope = Exclude<PlaybackContentScope, 'manual'>;

export interface WordHighlightScopeMessage {
	action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE';
	sessionId: string;
	selectionText: string;
}

export interface WordHighlightInitMessage {
	action: 'WORD_HIGHLIGHT_INIT';
	sessionId: string;
	contentScope: WordHighlightContentScope;
	words: readonly ReadableSurfaceWord[];
}

export interface WordHighlightUpdateMessage {
	action: 'WORD_HIGHLIGHT_UPDATE';
	sessionId: string;
	wordIndex: number;
}

export interface WordHighlightClearMessage {
	action: 'WORD_HIGHLIGHT_CLEAR';
	sessionId: string;
}

export function isWordHighlightInitMessage(value: unknown): value is WordHighlightInitMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Partial<WordHighlightInitMessage>;
	return (
		message.action === 'WORD_HIGHLIGHT_INIT' &&
		typeof message.sessionId === 'string' &&
		message.sessionId.length > 0 &&
		(message.contentScope === 'article' || message.contentScope === 'selection') &&
		Array.isArray(message.words) &&
		message.words.every((word, index) => typeof word?.text === 'string' && word.text.trim().length > 0 && word.globalIndex === index)
	);
}

export function isWordHighlightUpdateMessage(value: unknown): value is WordHighlightUpdateMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Partial<WordHighlightUpdateMessage>;
	return (
		message.action === 'WORD_HIGHLIGHT_UPDATE' &&
		typeof message.sessionId === 'string' &&
		message.sessionId.length > 0 &&
		typeof message.wordIndex === 'number' &&
		Number.isInteger(message.wordIndex) &&
		message.wordIndex >= 0
	);
}

export function isWordHighlightEnabled(value: unknown): boolean {
	return value !== false;
}
