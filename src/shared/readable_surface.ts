import type { PlaybackContentScope } from './types.ts';

export interface ReadableSurfaceWord {
	text: string;
	globalIndex: number;
}

export interface ReadableSurfaceInitMessage {
	action: 'READABLE_SURFACE_INIT';
	sessionId: string;
	contentScope: PlaybackContentScope;
	words: readonly ReadableSurfaceWord[];
}

export interface ReadableSurfaceUpdateMessage {
	action: 'READABLE_SURFACE_UPDATE';
	sessionId: string;
	wordIndex: number;
	word: string;
}

export interface ReadableSurfaceClearMessage {
	action: 'READABLE_SURFACE_CLEAR';
	sessionId: string;
}

export function buildReadableSurfaceWords(units: readonly { wordMap?: readonly { text: string }[] }[]): ReadableSurfaceWord[] {
	const words: ReadableSurfaceWord[] = [];
	for (const unit of units) {
		for (const entry of unit.wordMap ?? []) {
			words.push({ text: entry.text, globalIndex: words.length });
		}
	}
	return words;
}

function hasSessionId(value: { sessionId?: unknown }): boolean {
	return typeof value.sessionId === 'string' && value.sessionId.length > 0;
}

function hasContiguousWords(value: unknown): value is ReadableSurfaceWord[] {
	return (
		Array.isArray(value) &&
		value.every((word, index) => {
			if (!word || typeof word !== 'object') {
				return false;
			}
			const entry = word as Partial<ReadableSurfaceWord>;
			return typeof entry.text === 'string' && entry.text.trim().length > 0 && entry.globalIndex === index;
		})
	);
}

export function isReadableSurfaceInitMessage(value: unknown): value is ReadableSurfaceInitMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Partial<ReadableSurfaceInitMessage>;
	return (
		message.action === 'READABLE_SURFACE_INIT' &&
		hasSessionId(message) &&
		(message.contentScope === 'article' || message.contentScope === 'selection' || message.contentScope === 'manual') &&
		hasContiguousWords(message.words)
	);
}

export function isReadableSurfaceUpdateMessage(value: unknown): value is ReadableSurfaceUpdateMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Partial<ReadableSurfaceUpdateMessage>;
	return (
		message.action === 'READABLE_SURFACE_UPDATE' &&
		hasSessionId(message) &&
		typeof message.wordIndex === 'number' &&
		Number.isInteger(message.wordIndex) &&
		message.wordIndex >= 0 &&
		typeof message.word === 'string' &&
		message.word.length > 0
	);
}

export function isReadableSurfaceClearMessage(value: unknown): value is ReadableSurfaceClearMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Partial<ReadableSurfaceClearMessage>;
	return message.action === 'READABLE_SURFACE_CLEAR' && hasSessionId(message);
}
