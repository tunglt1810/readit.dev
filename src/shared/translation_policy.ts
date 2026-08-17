import type { TranslationTarget } from './types.ts';

/**
 * Translation targets are limited by the speech engine, not by the Translator API. Chrome can
 * translate into far more languages than Supertonic can pronounce, and a translation nothing can
 * read aloud is worse than no translation.
 */
export const TRANSLATION_TARGETS: readonly TranslationTarget[] = ['vi', 'en', 'zh'];

/**
 * Below this, the detector is guessing. Translating from a guessed source produces confident
 * nonsense, which is the one failure mode a listener cannot catch: there is no original text
 * beside them to check it against.
 */
export const MIN_SOURCE_CONFIDENCE = 0.5;

export interface DetectedSourceLanguage {
	language: string;
	confidence: number;
}

export interface TranslationPair {
	sourceLanguage: string;
	targetLanguage: TranslationTarget;
}

export function isTranslationTarget(value: unknown): value is TranslationTarget {
	return typeof value === 'string' && (TRANSLATION_TARGETS as readonly string[]).includes(value);
}

function baseLanguage(tag: string): string {
	return tag.toLowerCase().split('-')[0] ?? '';
}

/**
 * Vietnamese, not the UI language. Defaulting to the UI language made the feature a no-op for its
 * most common case: an English reader on an English page resolves source to target, so nothing is
 * translated and the button appears to do nothing. Vietnamese is also the language this reader
 * normalizes most carefully.
 */
export const DEFAULT_TRANSLATION_TARGET: TranslationTarget = 'vi';

export function resolveTranslationPair(detected: DetectedSourceLanguage | null, target: TranslationTarget): TranslationPair | null {
	if (!detected || detected.confidence < MIN_SOURCE_CONFIDENCE) {
		return null;
	}
	if (baseLanguage(detected.language) === target) {
		return null;
	}
	return { sourceLanguage: detected.language, targetLanguage: target };
}
