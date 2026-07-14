import { chunkText } from './supertonic_helper.ts';
import { planSpeechUnits } from './vietnamese/speech_units.ts';
import type { NormalizationResult, SpeechUnit } from './vietnamese/types.ts';

export interface VietnameseTextNormalizer {
	normalize(text: string): Promise<NormalizationResult>;
}

function compatibilityUnits(text: string): SpeechUnit[] {
	return chunkText(text, 200)
		.map((unit) => unit.trim())
		.filter(Boolean)
		.map((unit) => ({ text: unit, pauseAfterMs: 0 }));
}

function vietnameseFallback(text: string): SpeechUnit[] {
	try {
		const units = planSpeechUnits(text).filter(({ text: unit }) => unit.trim().length > 0);
		return units.length > 0 ? units : compatibilityUnits(text);
	} catch {
		return compatibilityUnits(text);
	}
}

export async function preparePlaybackUnits(text: string, lang: string, normalizer: VietnameseTextNormalizer | null): Promise<SpeechUnit[]> {
	if (lang !== 'vi') {
		return compatibilityUnits(text);
	}
	if (!normalizer) {
		return vietnameseFallback(text);
	}
	try {
		const result = await normalizer.normalize(text);
		const units = planSpeechUnits(result.text).filter(({ text: unit }) => unit.trim().length > 0);
		return units.length > 0 ? units : vietnameseFallback(text);
	} catch {
		return vietnameseFallback(text);
	}
}
