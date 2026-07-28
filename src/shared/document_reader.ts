import type { ReadableSurfaceWord } from './readable_surface.ts';

export const DOCUMENT_READER_PORT_NAME = 'document-reader';

export type DocumentReaderRange = { start: number; end: number };

export interface DocumentReaderSnapshot {
	sessionId: string;
	title: string;
	content: string;
	words: readonly ReadableSurfaceWord[];
	currentWordIndex: number;
}

export type DocumentReaderPortMessage =
	| { action: 'DOCUMENT_READER_ATTACH'; sessionId: string }
	| { action: 'DOCUMENT_READER_SNAPSHOT'; snapshot: DocumentReaderSnapshot }
	| { action: 'DOCUMENT_READER_UPDATE'; sessionId: string; wordIndex: number }
	| { action: 'DOCUMENT_READER_CLEAR'; sessionId: string };

const WORD_CHAR_PATTERN = /[\p{L}\p{M}\p{N}_]/u;

function targetVariants(text: string): string[] {
	const trimmed = text.trim();
	return trimmed ? [...new Set([trimmed.normalize('NFC'), trimmed.normalize('NFD')])] : [];
}

function escapedPattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isBoundaryMatch(text: string, start: number, length: number): boolean {
	const before = text[start - 1];
	const after = text[start + length];
	return !(before && WORD_CHAR_PATTERN.test(before)) && !(after && WORD_CHAR_PATTERN.test(after));
}

function findBoundedMatch(text: string, target: string, fromOffset: number): DocumentReaderRange | null {
	const pattern = new RegExp(escapedPattern(target), 'giu');
	pattern.lastIndex = fromOffset;
	let match = pattern.exec(text);
	while (match) {
		if (isBoundaryMatch(text, match.index, match[0].length)) {
			return { start: match.index, end: match.index + match[0].length };
		}
		match = pattern.exec(text);
	}
	return null;
}

export function mapDocumentReaderWords(
	content: string,
	words: readonly ReadableSurfaceWord[],
): Array<DocumentReaderRange | null> {
	const ranges: Array<DocumentReaderRange | null> = [];
	let nextOffset = 0;
	for (const word of words) {
		let range: DocumentReaderRange | null = null;
		for (const variant of targetVariants(word.text)) {
			range = findBoundedMatch(content, variant, nextOffset);
			if (range) {
				break;
			}
		}
		ranges.push(range);
		if (range) {
			nextOffset = range.end;
		}
	}
	return ranges;
}

export function isDocumentReaderSnapshot(value: unknown): value is DocumentReaderSnapshot {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const snapshot = value as Record<string, unknown>;
	const words = snapshot.words;
	return (
		typeof snapshot.sessionId === 'string' &&
		snapshot.sessionId.length > 0 &&
		typeof snapshot.title === 'string' &&
		typeof snapshot.content === 'string' &&
		Array.isArray(words) &&
		words.every(
			(word, index) =>
				Boolean(word) &&
				typeof word === 'object' &&
				typeof (word as { text?: unknown }).text === 'string' &&
				(word as { text: string }).text.trim().length > 0 &&
				(word as { globalIndex?: unknown }).globalIndex === index,
		) &&
		Number.isInteger(snapshot.currentWordIndex) &&
		(snapshot.currentWordIndex as number) >= -1 &&
		(snapshot.currentWordIndex as number) < words.length &&
		Object.keys(snapshot).length === 5
	);
}
