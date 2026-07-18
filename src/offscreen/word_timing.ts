export interface WordTimingWindow {
	text: string;
	startSec: number;
	endSec: number;
}

const VOWEL_CLUSTER_PATTERN = /[aeiouy]+/giu;

// Character count is a poor proxy for spoken duration: Vietnamese is monosyllabic (diacritics and
// consonant clusters add letters without adding speaking time, e.g. "nghiêng" vs "đi" are both one
// syllable), and Latin-script function words are spoken quickly despite their length. Counting
// vowel clusters after stripping diacritics is a much closer proxy for syllable count.
//
// This only applies when entry.text is actually what got spoken (its length matches the spoken
// span). For normalized number/date/abbreviation expansions, entry.text is the short original page
// text (e.g. "20/05") while start/end span the much longer expanded reading — its own syllable
// count says nothing about the expansion's speaking time, so the spoken span length remains the
// best duration proxy available for those entries.
function estimateSpeakingWeight(entry: { text: string; start: number; end: number }): number {
	const spokenLength = Math.max(entry.end - entry.start, 1);
	if (entry.text.length !== spokenLength) {
		return spokenLength;
	}
	const strippedText = entry.text.normalize('NFD').replace(/\p{Mn}/gu, '');
	const syllables = strippedText.match(VOWEL_CLUSTER_PATTERN);
	return syllables && syllables.length > 0 ? syllables.length : spokenLength;
}

export function computeWordTimings(
	wordMap: readonly { text: string; start: number; end: number }[],
	spokenDurationSec: number,
): WordTimingWindow[] {
	if (wordMap.length === 0 || spokenDurationSec <= 0) {
		return [];
	}
	const totalWeight = wordMap.reduce((sum, entry) => sum + estimateSpeakingWeight(entry), 0);
	const windows: WordTimingWindow[] = [];
	let elapsed = 0;
	for (const entry of wordMap) {
		const weight = estimateSpeakingWeight(entry);
		const duration = (weight / totalWeight) * spokenDurationSec;
		windows.push({ text: entry.text, startSec: elapsed, endSec: elapsed + duration });
		elapsed += duration;
	}
	return windows;
}

export function findWordAtTime(windows: readonly WordTimingWindow[], elapsedSec: number): string | null {
	for (const window of windows) {
		if (elapsedSec >= window.startSec && elapsedSec < window.endSec) {
			return window.text;
		}
	}
	const lastWindow = windows.at(-1);
	return lastWindow && elapsedSec >= lastWindow.endSec ? lastWindow.text : null;
}
