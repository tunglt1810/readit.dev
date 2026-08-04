import { isPredominantlyLatinText, planLatinSpeechUnits } from './latin/speech_units.ts';
import { consolidateShortSpeechUnits } from './short_segment_consolidation.ts';
import type { SpeechUnit } from './speech_unit.ts';
import { chunkText } from './supertonic_helper.ts';
import type { NormalizationResult } from './vietnamese/types.ts';
import { attachNormalizedWordMap, attachPlainWordMap } from './word_map.ts';

export interface VietnameseTextNormalizer {
	normalize(text: string): Promise<NormalizationResult>;
}

export function isVietnameseLanguage(lang: string): boolean {
	return /^vi(?:$|[-_])/iu.test(lang.trim());
}

function compatibilityUnits(text: string, pauseAfterMs: number | null): SpeechUnit[] {
	return chunkText(text, 200)
		.map((unit) => unit.trim())
		.filter(Boolean)
		.map((unit) => ({ text: unit, pauseAfterMs }));
}

function plannedUnits(text: string, fallbackPauseAfterMs: number | null): SpeechUnit[] {
	try {
		const units = planLatinSpeechUnits(text).filter(({ text: unit }) => unit.trim().length > 0);
		return units.length > 0 ? units : compatibilityUnits(text, fallbackPauseAfterMs);
	} catch {
		return compatibilityUnits(text, fallbackPauseAfterMs);
	}
}

function vietnameseFallback(text: string): SpeechUnit[] {
	return plannedUnits(text, 0);
}

export async function preparePlaybackUnits(text: string, lang: string, normalizer: VietnameseTextNormalizer | null): Promise<SpeechUnit[]> {
	if (!isVietnameseLanguage(lang)) {
		const planned = isPredominantlyLatinText(text) ? plannedUnits(text, null) : compatibilityUnits(text, null);
		return attachPlainWordMap(consolidateShortSpeechUnits(planned, lang));
	}
	if (!normalizer) {
		return attachPlainWordMap(consolidateShortSpeechUnits(vietnameseFallback(text), lang));
	}
	try {
		const result = await normalizer.normalize(text);
		const planned = planLatinSpeechUnits(result.text).filter(({ text: unit }) => unit.trim().length > 0);
		return planned.length > 0
			? attachNormalizedWordMap(consolidateShortSpeechUnits(planned, lang), result.text, result.wordMap)
			: attachPlainWordMap(consolidateShortSpeechUnits(vietnameseFallback(text), lang));
	} catch {
		return attachPlainWordMap(consolidateShortSpeechUnits(vietnameseFallback(text), lang));
	}
}
