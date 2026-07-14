import type { SpeechUnit } from './types.ts';

export const VI_PAUSE_MS = Object.freeze({
	comma: 60,
	colonOrSemicolon: 90,
	spacedDash: 105,
	sentenceEnd: 165,
	paragraphEnd: 260,
});
export const VI_PREFERRED_UNIT_LENGTH = 200;
export const VI_MAX_UNIT_LENGTH = 300;
export const VI_MIN_FRAGMENT_LENGTH = 20;

interface Boundary {
	end: number;
	pauseAfterMs: number;
	strong: boolean;
}

const PROTECTED_PATTERNS = [
	/https?:\/\/[^\s<>"'“”‘’]+/giu,
	/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
	/(?:\d{1,3}\.){3}\d{1,3}/gu,
	/v\d+(?:\.\d+)+/giu,
	/\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/gu,
	/\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/gu,
	/\d+(?:[.,]\d+)*(?:\s?[-–]\s?\d+(?:[.,]\d+)*)?\s?(?:km\/h|m²|m3|%|₫|đ|mm|cm|km|kg|mg|ml|ha|m|g|l)/giu,
	/[A-ZĐĂÂÊÔƠƯ]+-\d+(?:-[A-ZĐĂÂÊÔƠƯ]+)*/gu,
] as const;

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

function scanBoundaries(text: string): Boundary[] {
	const protectedAt = protectedPositions(text);
	const boundaries: Boundary[] = [];
	for (let index = 0; index < text.length; index++) {
		if (protectedAt[index]) {
			continue;
		}
		const character = text[index];
		if (character === ',' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, pauseAfterMs: VI_PAUSE_MS.comma, strong: false });
		} else if ((character === ':' || character === ';') && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, pauseAfterMs: VI_PAUSE_MS.colonOrSemicolon, strong: false });
		} else if ('-–—'.includes(character) && /\s/u.test(text[index - 1] ?? '') && /\s/u.test(text[index + 1] ?? '')) {
			boundaries.push({ end: index + 1, pauseAfterMs: VI_PAUSE_MS.spacedDash, strong: false });
		} else if (/[.!?…]/u.test(character)) {
			let end = index + 1;
			while (text[end] === '.') {
				end++;
			}
			boundaries.push({ end, pauseAfterMs: VI_PAUSE_MS.sentenceEnd, strong: true });
			index = end - 1;
		}
	}
	return boundaries;
}

function nearestSplit(text: string): number {
	let best = -1;
	let distance = Number.POSITIVE_INFINITY;
	for (let index = 1; index <= Math.min(text.length - 1, VI_MAX_UNIT_LENGTH); index++) {
		if (!/\s/u.test(text[index])) {
			continue;
		}
		const currentDistance = Math.abs(index - VI_PREFERRED_UNIT_LENGTH);
		if (currentDistance < distance) {
			best = index;
			distance = currentDistance;
		}
	}
	return best > 0 ? best : VI_MAX_UNIT_LENGTH;
}

function enforceMaximum(text: string, pauseAfterMs: number): SpeechUnit[] {
	const units: SpeechUnit[] = [];
	let remaining = text.trim();
	while (remaining.length > VI_MAX_UNIT_LENGTH) {
		const split = nearestSplit(remaining);
		units.push({ text: remaining.slice(0, split).trim(), pauseAfterMs: 0 });
		remaining = remaining.slice(split).trimStart();
	}
	if (remaining) {
		units.push({ text: remaining, pauseAfterMs });
	}
	return units;
}

function planParagraph(text: string): SpeechUnit[] {
	const units: SpeechUnit[] = [];
	let start = 0;
	for (const boundary of scanBoundaries(text)) {
		const candidate = text.slice(start, boundary.end).trim();
		const remainder = text.slice(boundary.end).trim();
		const shouldSplit = boundary.strong || (candidate.length >= VI_MIN_FRAGMENT_LENGTH && remainder.length >= VI_MIN_FRAGMENT_LENGTH);
		if (!shouldSplit) {
			continue;
		}
		units.push(...enforceMaximum(candidate, boundary.pauseAfterMs));
		start = boundary.end;
	}
	const trailing = text.slice(start).trim();
	if (trailing) {
		units.push(...enforceMaximum(trailing, 0));
	}
	return units;
}

export function planSpeechUnits(text: string): SpeechUnit[] {
	const paragraphs = text
		.normalize('NFC')
		.split(/\n[\t ]*\n+/u)
		.map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
		.filter(Boolean);
	const units: SpeechUnit[] = [];
	for (let index = 0; index < paragraphs.length; index++) {
		const paragraphUnits = planParagraph(paragraphs[index]);
		if (paragraphUnits.length === 0) {
			continue;
		}
		if (index < paragraphs.length - 1) {
			const last = paragraphUnits[paragraphUnits.length - 1];
			last.pauseAfterMs = Math.max(last.pauseAfterMs, VI_PAUSE_MS.paragraphEnd);
		}
		units.push(...paragraphUnits);
	}
	return units;
}
