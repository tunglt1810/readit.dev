import { type DetectedSourceLanguage, resolveTranslationPair, type TranslationPair } from '../shared/translation_policy.ts';
import type { TranslationInfo, TranslationTarget } from '../shared/types.ts';

export interface TranslatorLike {
	translate(input: string): Promise<string>;
}

export interface TranslationDependencies {
	detectLanguage(text: string): Promise<DetectedSourceLanguage | null>;
	createTranslator(pair: TranslationPair): Promise<TranslatorLike>;
}

export interface TranslatedArticleText {
	content: string;
	translation: TranslationInfo;
}

/**
 * The normalizer iterates paragraphs and rejoins them with a blank line, and the Document Reader
 * renders the same string it highlights into. Translating the document as one blob risks the model
 * reflowing or collapsing those breaks, so each paragraph is translated on its own.
 */
export function splitParagraphs(content: string): string[] {
	return content
		.split(/\n\s*\n/u)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
}

export async function translateArticleText(
	content: string,
	target: TranslationTarget,
	dependencies: TranslationDependencies,
): Promise<TranslatedArticleText | null> {
	const detected = await dependencies.detectLanguage(content);
	const pair = resolveTranslationPair(detected, target);
	if (!pair) {
		return null;
	}

	const paragraphs = splitParagraphs(content);
	if (paragraphs.length === 0) {
		return null;
	}

	const translator = await dependencies.createTranslator(pair);
	const translated: string[] = [];
	for (const paragraph of paragraphs) {
		const output = await translator.translate(paragraph);
		// An empty result would silently delete a paragraph and shift every later word range, so the
		// source paragraph is kept instead. Reading one paragraph untranslated is recoverable;
		// losing it is not.
		translated.push(output.trim().length > 0 ? output : paragraph);
	}

	return {
		content: translated.join('\n\n'),
		translation: { sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage },
	};
}

interface LanguageDetectorApi {
	create(): Promise<{ detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>> }>;
}

interface TranslatorApi {
	create(options: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorLike>;
}

/**
 * Binds the module to Chrome's built-in APIs. Returns null on any browser that lacks them, which is
 * how the Firefox build and older Chrome keep their current behaviour.
 */
export function createChromeTranslationDependencies(): TranslationDependencies | null {
	const detector = (globalThis as { LanguageDetector?: LanguageDetectorApi }).LanguageDetector;
	const translator = (globalThis as { Translator?: TranslatorApi }).Translator;
	if (!detector || !translator) {
		return null;
	}

	return {
		detectLanguage: async (text) => {
			try {
				const instance = await detector.create();
				const results = await instance.detect(text);
				const best = results[0];
				return best ? { language: best.detectedLanguage, confidence: best.confidence } : null;
			} catch {
				return null;
			}
		},
		createTranslator: (pair) =>
			// A pair the user has not used before is `downloadable`, and this call is what triggers
			// the one-off model download. The wait is covered by the session's existing `loading`
			// status; no `downloadprogress` monitor is attached, because the project forbids console
			// output and nothing else would consume it.
			translator.create({ sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage }),
	};
}
