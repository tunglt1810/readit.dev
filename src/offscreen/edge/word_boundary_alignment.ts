import type { SpeechUnitWordMapEntry } from '../speech_unit.ts';
import type { WordTimingWindow } from '../word_timing.ts';
import type { EdgeWordBoundary } from './edge_socket.ts';

/**
 * Comparison form: letters and digits only, lowercased, diacritics kept. Microsoft's tokenizer
 * splits and punctuates differently from `buildPlainWordMap`, so the two agree on letters and
 * nothing else.
 */
function comparable(text: string): string {
	return text.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Real per-word timings for one unit, or null when the two tokenizations cannot be reconciled.
 *
 * Highlighting addresses words by their index into `wordMap`, so every boundary Microsoft reports
 * has to be attributed to exactly one entry. A word map entry can correspond to several spoken
 * boundaries, so boundaries are accumulated until their letters match the entry's.
 *
 * Anything that does not reconcile returns null and the caller estimates timings instead. That
 * covers the case where Microsoft's frontend expands a token — it speaks "20/05" as "hai mươi
 * tháng năm", whose letters share nothing with the source — and a wrong highlight is worse than
 * an approximate one.
 */
export function alignWordBoundaries(
	wordMap: readonly SpeechUnitWordMapEntry[],
	boundaries: readonly EdgeWordBoundary[],
): WordTimingWindow[] | null {
	if (wordMap.length === 0 || boundaries.length === 0) {
		return null;
	}

	const windows: WordTimingWindow[] = [];
	let boundaryIndex = 0;

	for (const [wordIndex, entry] of wordMap.entries()) {
		const target = comparable(entry.text);
		if (target === '') {
			continue;
		}
		const startBoundary = boundaries[boundaryIndex];
		if (!startBoundary) {
			return null;
		}
		let accumulated = '';
		let lastBoundary = startBoundary;
		while (boundaryIndex < boundaries.length && accumulated.length < target.length) {
			lastBoundary = boundaries[boundaryIndex];
			accumulated += comparable(lastBoundary.text);
			boundaryIndex += 1;
		}
		if (accumulated !== target) {
			return null;
		}
		windows.push({
			text: entry.text,
			wordIndex,
			startSec: startBoundary.offsetMs / 1000,
			endSec: (lastBoundary.offsetMs + lastBoundary.durationMs) / 1000,
		});
	}

	// Leftover boundaries mean the unit said more than the word map accounts for; mapping past
	// that point would be guesswork.
	return boundaryIndex === boundaries.length && windows.length > 0 ? windows : null;
}
