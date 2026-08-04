import type { SpeechUnit } from './speech_unit.ts';
import { synthesisTextLimitForLanguage } from './supertonic_helper.ts';

/**
 * Minimum number of trimmed, non-whitespace Unicode code points that can be reliably synthesized
 * on its own. This audio-reliability policy is intentionally separate from planner split limits.
 */
export const MIN_RELIABLE_SYNTHESIS_CHARACTERS = 20;

export function nonWhitespaceCodePointCount(text: string): number {
	return Array.from(text.trim()).filter((character) => !/\s/u.test(character)).length;
}

export function isShortSpeechUnit(unit: Pick<SpeechUnit, 'text'>): boolean {
	return nonWhitespaceCodePointCount(unit.text) < MIN_RELIABLE_SYNTHESIS_CHARACTERS;
}

function synthesisTextForUnit(unit: SpeechUnit): string {
	return unit.synthesisText ?? unit.text;
}

function joinUnitText(left: string, right: string): string {
	return `${left.trimEnd()} ${right.trimStart()}`;
}

function hasNaturalTerminalCadence(text: string): boolean {
	return /[.!?…;:,\-–—。！？；：，、]$/u.test(text.trimEnd());
}

function renderingTextForMerge(left: SpeechUnit, right: SpeechUnit): string {
	const leftRendering = synthesisTextForUnit(left).trimEnd();
	const renderedLeft =
		left.pauseAfterMs !== 0 && !hasNaturalTerminalCadence(leftRendering) ? `${leftRendering}.` : leftRendering;
	return joinUnitText(renderedLeft, synthesisTextForUnit(right));
}

function mergeSpeechUnits(left: SpeechUnit, right: SpeechUnit): SpeechUnit {
	const text = joinUnitText(left.text, right.text);
	const synthesisText = renderingTextForMerge(left, right);
	const { wordMap: _leftWordMap, synthesisText: _leftSynthesisText, ...leftWithoutDerivedFields } = left;

	return {
		...leftWithoutDerivedFields,
		text,
		...(synthesisText === text ? {} : { synthesisText }),
		pauseAfterMs: right.pauseAfterMs,
	};
}

function mergeCandidate(left: SpeechUnit | undefined, right: SpeechUnit | undefined, limit: number): SpeechUnit | undefined {
	if (!left || !right) {
		return undefined;
	}
	const merged = mergeSpeechUnits(left, right);
	return synthesisTextForUnit(merged).length <= limit ? merged : undefined;
}

/**
 * Consolidate independently risky units with an immediate neighbour when the resulting TTS
 * rendering fits the engine limit. This helper is pure: it neither plans units nor attaches word
 * maps. Callers must consolidate bare planned units before adding mappings.
 */
export function consolidateShortSpeechUnits(units: readonly SpeechUnit[], language: string): SpeechUnit[] {
	const consolidated = units.slice();
	const limit = synthesisTextLimitForLanguage(language);
	let index = 0;

	while (index < consolidated.length) {
		const unit = consolidated[index];
		if (!isShortSpeechUnit(unit)) {
			index++;
			continue;
		}

		const previous = consolidated[index - 1];
		const next = consolidated[index + 1];
		const previousCandidate = mergeCandidate(previous, unit, limit);
		const nextCandidate = mergeCandidate(unit, next, limit);
		const previousIsReliable = previousCandidate !== undefined && !isShortSpeechUnit(previousCandidate);
		const nextIsReliable = nextCandidate !== undefined && !isShortSpeechUnit(nextCandidate);

		if (previousIsReliable) {
			consolidated.splice(index - 1, 2, previousCandidate);
			index = Math.max(0, index - 1);
			continue;
		}
		if (nextIsReliable) {
			consolidated.splice(index, 2, nextCandidate);
			continue;
		}

		// Neither neighbouring candidate is independently reliable yet. Prefer extending an
		// adjacent short run, then use the sole remaining capacity-safe candidate. Re-scanning
		// the merged index preserves order while ensuring every mergeable short unit progresses.
		if (previousCandidate && previous && isShortSpeechUnit(previous)) {
			consolidated.splice(index - 1, 2, previousCandidate);
			index = Math.max(0, index - 1);
			continue;
		}
		if (nextCandidate && next && isShortSpeechUnit(next)) {
			consolidated.splice(index, 2, nextCandidate);
			continue;
		}
		if (previousCandidate) {
			consolidated.splice(index - 1, 2, previousCandidate);
			index = Math.max(0, index - 1);
			continue;
		}
		if (nextCandidate) {
			consolidated.splice(index, 2, nextCandidate);
			continue;
		}

		index++;
	}

	return consolidated;
}

export function consolidateUnpunctuatedListUnits(units: readonly SpeechUnit[], language: string): SpeechUnit[] {
	const consolidated = units.slice();
	const limit = synthesisTextLimitForLanguage(language);
	let index = 0;

	while (index < consolidated.length - 1) {
		const current = consolidated[index];
		const next = consolidated[index + 1];

		if (!hasNaturalTerminalCadence(current.text) && nonWhitespaceCodePointCount(current.text) <= 120) {
			const merged = mergeCandidate(current, next, limit);
			if (merged) {
				consolidated.splice(index, 2, merged);
				continue;
			}
		}
		index++;
	}

	return consolidated;
}
