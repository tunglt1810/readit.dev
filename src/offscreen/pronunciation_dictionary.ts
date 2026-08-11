import type { PronunciationRule } from '../shared/types.ts';
import type { SpeechUnit } from './speech_unit.ts';

/**
 * Apply user-defined pronunciation rules to speech units by assigning `synthesisText`.
 * Leaves `text` untouched so highlights and word maps remain correct.
 *
 * Must be called after unit planning and before consolidation.
 */
export function applyPronunciationDictionary(
	units: SpeechUnit[],
	rules: readonly PronunciationRule[],
	lang: string,
): void {
	const activeRules = rules
		.filter((r) => r.enabled && (!r.lang || r.lang === lang))
		.toSorted((a, b) => b.match.length - a.match.length);

	if (activeRules.length === 0) return;

	for (const unit of units) {
		let source = unit.synthesisText ?? unit.text;
		let changed = false;

		for (const rule of activeRules) {
			if (rule.caseSensitive) {
				const idx = source.indexOf(rule.match);
				if (idx === -1) continue;
				if (rule.wholeWord && !isWholeWordMatch(source, idx, rule.match.length)) continue;
				source = source.replaceAll(rule.match, rule.replacement);
			} else {
				const lowerSource = source.toLowerCase();
				const lowerMatch = rule.match.toLowerCase();
				const idx = lowerSource.indexOf(lowerMatch);
				if (idx === -1) continue;
				if (rule.wholeWord && !isWholeWordMatch(source, idx, rule.match.length)) continue;
				source = source.replace(new RegExp(escapeRegExp(rule.match), 'gi'), rule.replacement);
			}
			changed = true;
		}

		if (changed) {
			unit.synthesisText = source;
		}
	}
}

function isWholeWordMatch(text: string, startIdx: number, matchLength: number): boolean {
	const before = startIdx > 0 ? text[startIdx - 1] : ' ';
	const after = startIdx + matchLength < text.length ? text[startIdx + matchLength] : ' ';
	return /[\s]/.test(before) && /[\s.,;:!?)]/.test(after);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
