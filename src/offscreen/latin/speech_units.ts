import { type BoundaryCandidate, planTextSegments, type SegmentationPolicy } from '../segmentation.ts';
import type { SpeechUnit } from '../speech_unit.ts';

export const LATIN_PAUSE_MS = Object.freeze({
	comma: 60,
	colonOrSemicolon: 90,
	spacedDash: 105,
	sentenceEnd: 165,
	paragraphEnd: 260,
});
export const LATIN_PREFERRED_MIN_LENGTH = 140;
export const LATIN_PREFERRED_CENTER_LENGTH = 190;
export const LATIN_PREFERRED_MAX_LENGTH = 240;
export const LATIN_MAX_UNIT_LENGTH = 300;

type LatinBoundaryKind = 'sentence' | 'semicolon' | 'colon' | 'spacedDash' | 'comma';

const LATIN_SEGMENTATION_POLICY: SegmentationPolicy<LatinBoundaryKind> = Object.freeze({
	preferredMin: LATIN_PREFERRED_MIN_LENGTH,
	preferredCenter: LATIN_PREFERRED_CENTER_LENGTH,
	preferredMax: LATIN_PREFERRED_MAX_LENGTH,
	hardMax: LATIN_MAX_UNIT_LENGTH,
	outsidePreferredPenalty: 10,
	shortRemainderLength: 80,
	shortRemainderPenalty: 30,
	minimumScore: 0,
	boundaryWeights: Object.freeze({
		sentence: 40,
		semicolon: 30,
		colon: 28,
		spacedDash: 24,
		comma: 20,
	}),
});

const LETTER_PATTERN = /\p{L}/u;
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u;

const PROTECTED_PATTERNS = [
	/https?:\/\/[^\s<>"'“”‘’]+/giu,
	/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
	/(?:\d{1,3}\.){3}\d{1,3}/gu,
	/v\d+(?:\.\d+)+/giu,
	/\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/gu,
	/\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/gu,
	/\d+(?:[.,]\d+)*(?:\s?[-–]\s?\d+(?:[.,]\d+)*)?\s?(?:km\/h|m²|m3|%|₫|đ|mm|cm|km|kg|mg|ml|ha|m|g|l)/giu,
	/\p{Lu}+-\d+(?:-\p{Lu}+)*/gu,
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
		if (character === ',' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'comma', pauseAfterMs: LATIN_PAUSE_MS.comma });
		} else if (character === ':' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'colon', pauseAfterMs: LATIN_PAUSE_MS.colonOrSemicolon });
		} else if (character === ';' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'semicolon', pauseAfterMs: LATIN_PAUSE_MS.colonOrSemicolon });
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
			boundaries.push({ end, kind: 'sentence', pauseAfterMs: LATIN_PAUSE_MS.sentenceEnd });
			index = end - 1;
		}
	}
	return boundaries;
}

function planParagraph(text: string, paragraphPauseAfterMs: number): SpeechUnit[] {
	const boundaries = scanBoundaries(text);
	const trailingBoundary = boundaries.at(-1);
	const trailingPauseAfterMs = trailingBoundary?.end === text.length ? trailingBoundary.pauseAfterMs : 0;
	return planTextSegments(text, boundaries, LATIN_SEGMENTATION_POLICY, Math.max(trailingPauseAfterMs, paragraphPauseAfterMs));
}

export function planLatinSpeechUnits(text: string): SpeechUnit[] {
	const paragraphs = text
		.normalize('NFC')
		.split(/\n[\t ]*\n+/u)
		.map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
		.filter(Boolean);
	const units: SpeechUnit[] = [];
	for (let index = 0; index < paragraphs.length; index++) {
		units.push(...planParagraph(paragraphs[index], index < paragraphs.length - 1 ? LATIN_PAUSE_MS.paragraphEnd : 0));
	}
	return units;
}
