import type { PronunciationRule } from '../shared/types.ts';
import type { SpeechUnit } from './speech_unit.ts';
import { synthesisTextLimitForLanguage } from './supertonic_helper.ts';

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

	const limit = synthesisTextLimitForLanguage(lang);

	for (const unit of units) {
		let source = unit.synthesisText ?? unit.text;
		let changed = false;

		for (const rule of activeRules) {
			const pattern = new RegExp(escapeRegExp(rule.match), rule.caseSensitive ? 'gu' : 'giu');
			// Every occurrence is judged on its own boundaries. Testing one occurrence and then
			// replacing all of them let a rule for "AI" rewrite the tail of "OpenAI", and let a first
			// occurrence inside a word veto the rule for the rest of the unit.
			const replaced = source.replace(pattern, (matched: string, offset: number) =>
				!rule.wholeWord || isWholeWordMatch(source, offset, matched.length) ? rule.replacement : matched,
			);
			if (replaced === source) continue;
			source = replaced;
			changed = true;
		}

		// A replacement can only lengthen a unit, but the unit was planned against this same limit
		// before any rule existed, so a rule that spells out a frequent acronym can push one past it.
		// Capacity is checked downstream and throws, which would fail the whole article over a single
		// unit; speaking that unit as written costs one mispronounced word instead.
		if (changed && source.length <= limit) {
			unit.synthesisText = source;
		}
	}
}

/** Combining marks count as word characters so a Vietnamese diacritic never reads as a boundary. */
const WORD_CHAR_PATTERN = /[\p{L}\p{M}\p{N}_]/u;

function isWholeWordMatch(text: string, startIdx: number, matchLength: number): boolean {
	// Anything that is not itself part of a word ends one, so brackets and quotes bound a match the
	// same way a space does. Requiring whitespace specifically missed "(AI)" and a leading em dash.
	const before = text[startIdx - 1];
	const after = text[startIdx + matchLength];
	return !(before && WORD_CHAR_PATTERN.test(before)) && !(after && WORD_CHAR_PATTERN.test(after));
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
