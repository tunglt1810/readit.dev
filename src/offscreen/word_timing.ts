export interface WordTimingWindow {
	text: string;
	wordIndex: number;
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

// Word timings are estimated, never predicted by the duration model. Asking the model for a
// per-word timing costs one duration pass per word — and because the batch is padded to the
// longest prefix, that is O(words × unit length) tokens against O(unit length) for the audio
// itself. Measured on a real article: 8.2s of prediction to protect 1.0s of synthesis, which
// stalled playback for seconds at every unit boundary.
export function computeWordTimings(
	wordMap: readonly { text: string; start: number; end: number }[],
	spokenDurationSec: number,
): WordTimingWindow[] {
	if (wordMap.length === 0 || spokenDurationSec <= 0) {
		return [];
	}
	const weights = wordMap.map(estimateSpeakingWeight);
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	const windows: WordTimingWindow[] = [];
	let elapsed = 0;
	for (const [wordIndex, entry] of wordMap.entries()) {
		const weight = weights[wordIndex];
		const duration = (weight / totalWeight) * spokenDurationSec;
		windows.push({ text: entry.text, wordIndex, startSec: elapsed, endSec: elapsed + duration });
		elapsed += duration;
	}
	return windows;
}

export function findWordAtTime(windows: readonly WordTimingWindow[], elapsedSec: number): WordTimingWindow | null {
	for (const window of windows) {
		if (elapsedSec >= window.startSec && elapsedSec < window.endSec) {
			return window;
		}
	}
	const lastWindow = windows.at(-1);
	return lastWindow && elapsedSec >= lastWindow.endSec ? lastWindow : null;
}
