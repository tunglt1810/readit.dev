import type { PlaybackContentScope } from './types';

export const WORD_HIGHLIGHT_NAME = 'readit-dev-word-highlight';

export interface WordHighlightScopeMessage {
	action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE';
	sessionId: string;
	selectionText: string;
}

export interface WordHighlightUpdateMessage {
	action: 'WORD_HIGHLIGHT_UPDATE';
	sessionId: string;
	word: string;
	contentScope?: PlaybackContentScope;
}

export interface WordHighlightClearMessage {
	action: 'WORD_HIGHLIGHT_CLEAR';
	sessionId: string;
}

export function isWordHighlightEnabled(value: unknown): boolean {
	return value !== false;
}
