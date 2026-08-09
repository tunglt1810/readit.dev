import { type BoundaryCandidate, planTextSegments } from '../segmentation.ts';
import type { SpeechUnit } from '../speech_unit.ts';

export const LATIN_PAUSE_MS = Object.freeze({
	comma: 60,
	colon: 90,
	semicolon: 140,
	spacedDash: 105,
	sentenceEnd: 165,
	period: 180,
	paragraphEnd: 260,
});
export const LATIN_MAX_UNIT_LENGTH = 300;

type LatinBoundaryKind = 'sentence' | 'semicolon' | 'colon' | 'spacedDash' | 'comma' | 'whitespace';

const LETTER_PATTERN = /\p{L}/u;
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u;
const CLOSING_MARK_PATTERN = /['"”’»)\]}]/u;

const PROTECTED_PATTERNS = [
	/https?:\/\/[^\s<>"'“”‘’]+/giu,
	/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
	/(?:\d{1,3}\.){3}\d{1,3}/gu,
	/v\d+(?:\.\d+)+/giu,
	/\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/gu,
	/\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/gu,
	/\d+(?:[.,]\d+)*(?:\s?[-–]\s?\d+(?:[.,]\d+)*)?\s?(?:km\/h|m²|m3|%|₫|đ|mm|cm|km|kg|mg|ml|ha|m|g|l)/giu,
	/\p{Lu}+-\d+(?:-\p{Lu}+)*/gu,
	/(?:^|\s)\d+\.(?=\s+[\p{L}\p{N}])/gu,
	/\b(?:IRGC|AFP|CNN|TP\.HCM|VnExpress|PGS\.TS|P\.TS)\b/gu,
	/\b(?:TS|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Ph\.D|etc|e\.g|i\.e|vs|Inc|Ltd|Co|Corp|St|Ave|Blvd)\.(?=\s|$)/gu,
	/\b[A-Z0-9]{2,}\b/gu,
] as const;

export function isPredominantlyLatinText(text: string): boolean {
	let letterCount = 0;
	let latinLetterCount = 0;
	for (const character of text) {
		if (!LETTER_PATTERN.test(character)) {
			continue;
		}
		letterCount++;
		if (LATIN_LETTER_PATTERN.test(character)) {
			latinLetterCount++;
		}
	}
	return letterCount > 0 && latinLetterCount / letterCount > 0.5;
}

function protectedPositions(text: string): Uint8Array {
	const positions = new Uint8Array(text.length);
	for (const pattern of PROTECTED_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			let value = match[0];
			if (pattern === PROTECTED_PATTERNS[0]) {
				value = value.replace(/[….,!?;:]+$/u, '');
			}
			const start = match.index ?? 0;
			positions.fill(1, start, start + value.length);
		}
	}
	return positions;
}

function scanBoundaries(text: string): BoundaryCandidate<LatinBoundaryKind>[] {
	const protectedAt = protectedPositions(text);
	const boundaries: BoundaryCandidate<LatinBoundaryKind>[] = [];
	for (let index = 0; index < text.length; index++) {
		if (protectedAt[index]) {
			continue;
		}
		const character = text[index];
		if (/\s/u.test(character)) {
			boundaries.push({ end: index, kind: 'whitespace', pauseAfterMs: 0 });
		} else if (character === ',' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'comma', pauseAfterMs: LATIN_PAUSE_MS.comma });
		} else if (character === ':' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'colon', pauseAfterMs: LATIN_PAUSE_MS.colon });
		} else if (character === ';' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'semicolon', pauseAfterMs: LATIN_PAUSE_MS.semicolon });
		} else if ('-–—'.includes(character) && /\s/u.test(text[index - 1] ?? '') && /\s/u.test(text[index + 1] ?? '')) {
			boundaries.push({ end: index + 1, kind: 'spacedDash', pauseAfterMs: LATIN_PAUSE_MS.spacedDash });
		} else if (
			/[.!?…]/u.test(character) &&
			!(character === '.' && /\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))
		) {
			let end = index + 1;
			while (text[end] === '.') {
				end++;
			}
			// A closing quote or bracket belongs to the sentence it terminates, so keep it on the left
			// of the boundary instead of orphaning it at the head of the next unit.
			while (CLOSING_MARK_PATTERN.test(text[end] ?? '')) {
				end++;
			}
			boundaries.push({
				end,
				kind: 'sentence',
				pauseAfterMs: character === '.' ? LATIN_PAUSE_MS.period : LATIN_PAUSE_MS.sentenceEnd,
			});
			index = end - 1;
		}
	}
	return boundaries;
}

/**
 * Plan already-normalized paragraphs. Paragraph membership is the hard-boundary metadata the
 * source-neutral normalizer produced, so this never re-derives boundaries from line breaks.
 */
export function planLatinSpeechUnits(paragraphs: readonly string[], maximumUnitLength = LATIN_MAX_UNIT_LENGTH): SpeechUnit[] {
	const hardMax = Math.min(maximumUnitLength, LATIN_MAX_UNIT_LENGTH);
	const units: SpeechUnit[] = [];
	for (let index = 0; index < paragraphs.length; index++) {
		const paragraph = paragraphs[index];
		const isLast = index === paragraphs.length - 1;
		const paragraphPause = isLast ? LATIN_PAUSE_MS.sentenceEnd : LATIN_PAUSE_MS.paragraphEnd;
		units.push(...planTextSegments(paragraph, scanBoundaries(paragraph), hardMax, paragraphPause));
	}
	return units;
}
