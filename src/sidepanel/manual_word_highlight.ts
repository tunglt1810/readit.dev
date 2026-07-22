export type ManualWordRange = { start: number; end: number };

export type ManualHighlightAdvanceResult = { kind: 'matched'; range: ManualWordRange } | { kind: 'stale' } | { kind: 'unmatched' };

export type ManualHighlightCursor = {
	text: string;
	nextOffset: number;
	lastWordIndex: number;
};

const WORD_CHAR_PATTERN = /[\p{L}\p{M}\p{N}_]/u;

function wordVariants(word: string): string[] {
	const normalized = word.trim().toLocaleLowerCase();
	return normalized ? [...new Set([normalized.normalize('NFC'), normalized.normalize('NFD')])] : [];
}

function isWordBoundaryMatch(text: string, start: number, length: number): boolean {
	const before = text[start - 1];
	const after = text[start + length];
	return !(before && WORD_CHAR_PATTERN.test(before)) && !(after && WORD_CHAR_PATTERN.test(after));
}

function findBoundedMatch(text: string, variant: string, fromOffset: number): number {
	let match = text.indexOf(variant, fromOffset);
	while (match !== -1 && !isWordBoundaryMatch(text, match, variant.length)) {
		match = text.indexOf(variant, match + 1);
	}
	return match;
}

export function createManualHighlightCursor(text: string): ManualHighlightCursor {
	return { text, nextOffset: 0, lastWordIndex: -1 };
}

export function advanceManualHighlight(
	cursor: ManualHighlightCursor,
	event: { word: string; wordIndex: number },
): ManualHighlightAdvanceResult {
	if (event.wordIndex <= cursor.lastWordIndex) {
		return { kind: 'stale' };
	}
	cursor.lastWordIndex = event.wordIndex;
	const searchText = cursor.text.toLocaleLowerCase();
	for (const variant of wordVariants(event.word)) {
		const start = findBoundedMatch(searchText, variant, cursor.nextOffset);
		if (start === -1) {
			continue;
		}
		const end = start + variant.length;
		cursor.nextOffset = end;
		return { kind: 'matched', range: { start, end } };
	}
	return { kind: 'unmatched' };
}
