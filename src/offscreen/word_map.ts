import type { SpeechUnit } from './speech_unit.ts';
import type { WordMapEntry } from './vietnamese/types.ts';

export function buildPlainWordMap(text: string): Array<{ text: string; start: number; end: number }> {
	const entries: Array<{ text: string; start: number; end: number }> = [];
	const pattern = /\S+/gu;
	let match: RegExpExecArray | null = pattern.exec(text);
	while (match !== null) {
		entries.push({ text: match[0], start: match.index, end: match.index + match[0].length });
		match = pattern.exec(text);
	}
	return entries;
}

export function attachPlainWordMap(units: readonly SpeechUnit[]): SpeechUnit[] {
	return units.map((unit) => ({ ...unit, wordMap: buildPlainWordMap(unit.text) }));
}

// planLatinSpeechUnits() collapses every whitespace run in a paragraph to a single regular space
// when it builds each unit's .text (see latin/speech_units.ts's per-paragraph
// `.replace(/\s+/gu, ' ')`), but fullSpokenText here is the UNCOLLAPSED normalizer output. Any
// whitespace character other than a plain space that survives into fullSpokenText — most commonly
// a non-breaking space between a number and its unit (e.g. "20 km"), which the tokenizer's
// leading-whitespace scan only strips for literal ' ' (see vietnamese/tokenizer.ts) — makes
// unit.text differ from its own source slice by exactly that one character, so a literal indexOf
// search silently fails and the whole unit loses its word map. Match with every space in unit.text
// treated as "one or more whitespace characters" instead, so the unit is still located regardless
// of which whitespace variant fullSpokenText actually has there.
function unitTextPattern(unitText: string): RegExp {
	const escaped = unitText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+');
	return new RegExp(escaped, 'u');
}

export function attachNormalizedWordMap(
	units: readonly SpeechUnit[],
	fullSpokenText: string,
	wordMap: readonly WordMapEntry[],
): SpeechUnit[] {
	let searchCursor = 0;
	return units.map((unit) => {
		const match = fullSpokenText.slice(searchCursor).match(unitTextPattern(unit.text));
		if (!match || match.index === undefined) {
			return { ...unit, wordMap: [] };
		}
		const unitStart = searchCursor + match.index;
		const unitEnd = unitStart + match[0].length;
		searchCursor = unitEnd;
		const entries = wordMap
			.filter((entry) => entry.spokenStart >= unitStart && entry.spokenEnd <= unitEnd)
			.map((entry) => ({
				text: entry.originalText,
				start: entry.spokenStart - unitStart,
				end: entry.spokenEnd - unitStart,
			}));
		return { ...unit, wordMap: entries };
	});
}
