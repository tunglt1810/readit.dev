import { isPredominantlyLatinText, planLatinSpeechUnits } from './latin/speech_units.ts';
import { SegmentationCapacityError } from './segmentation.ts';
import { consolidateShortSpeechUnits } from './short_segment_consolidation.ts';
import type { SpeechUnit } from './speech_unit.ts';
import { assertWithinSynthesisCapacity, chunkText, synthesisTextLimitForLanguage } from './supertonic_helper.ts';
import { normalizeSourceText } from './text_normalization.ts';
import type { NormalizationResult } from './vietnamese/types.ts';
import { attachNormalizedWordMap, attachPlainWordMap } from './word_map.ts';

export interface VietnameseTextNormalizer {
	normalize(text: string): Promise<NormalizationResult>;
}

export function isVietnameseLanguage(lang: string): boolean {
	return /^vi(?:$|[-_])/iu.test(lang.trim());
}

function canonicalUnitText(text: string): string {
	return text.replace(/\s+/gu, ' ').trim();
}

function validateCapacity(units: readonly SpeechUnit[], language: string): SpeechUnit[] {
	for (const unit of units) {
		assertWithinSynthesisCapacity(unit, language);
	}
	return units.slice();
}

function compatibilityUnits(paragraphs: readonly string[], language: string, pauseAfterMs: number | null): SpeechUnit[] {
	const limit = synthesisTextLimitForLanguage(language);
	const units = chunkText(paragraphs.join('\n\n'), limit)
		.map(canonicalUnitText)
		.filter(Boolean)
		.map((unit) => ({ text: unit, pauseAfterMs }));
	return validateCapacity(units, language);
}

function plannedUnits(paragraphs: readonly string[], language: string, fallbackPauseAfterMs: number | null): SpeechUnit[] {
	const limit = synthesisTextLimitForLanguage(language);
	const units = planLatinSpeechUnits(paragraphs, limit).filter(({ text: unit }) => unit.trim().length > 0);
	return units.length > 0 ? validateCapacity(units, language) : compatibilityUnits(paragraphs, language, fallbackPauseAfterMs);
}

function vietnameseFallback(paragraphs: readonly string[], language: string): SpeechUnit[] {
	return plannedUnits(paragraphs, language, 0);
}

function consolidate(units: SpeechUnit[], language: string): SpeechUnit[] {
	return validateCapacity(consolidateShortSpeechUnits(units, language), language);
}

export async function preparePlaybackUnits(
	rawText: string,
	lang: string,
	normalizer: VietnameseTextNormalizer | null,
): Promise<SpeechUnit[]> {
	const { paragraphs, planningText } = normalizeSourceText(rawText);
	if (paragraphs.length === 0) {
		return [];
	}

	if (!isVietnameseLanguage(lang)) {
		const planned = isPredominantlyLatinText(planningText)
			? plannedUnits(paragraphs, lang, null)
			: compatibilityUnits(paragraphs, lang, null);
		return attachPlainWordMap(consolidate(planned, lang));
	}
	if (!normalizer) {
		return attachPlainWordMap(consolidate(vietnameseFallback(paragraphs, lang), lang));
	}
	try {
		const result = await normalizer.normalize(planningText);
		// The normalizer rewrites tokens for speech, so its output goes back through the one
		// normalizer rather than having this path re-derive paragraphs from its line breaks.
		const planned = planLatinSpeechUnits(normalizeSourceText(result.text).paragraphs).filter(
			({ text: unit }) => unit.trim().length > 0,
		);
		return planned.length > 0
			? attachNormalizedWordMap(consolidate(validateCapacity(planned, lang), lang), result.text, result.wordMap)
			: attachPlainWordMap(consolidate(vietnameseFallback(paragraphs, lang), lang));
	} catch (error) {
		if (error instanceof SegmentationCapacityError || error instanceof RangeError) {
			throw error;
		}
		return attachPlainWordMap(consolidate(vietnameseFallback(paragraphs, lang), lang));
	}
}
