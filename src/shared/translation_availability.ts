/**
 * Whether this browser can actually translate, rather than merely exposing the API.
 *
 * `typeof Translator !== 'undefined'` is not enough. Playwright's bundled Chromium defines the
 * built-in AI interfaces while shipping none of the models behind them, and any build without the
 * translation models does the same. Asking the Language Detector for its availability is the
 * cheapest honest check — it takes no language pair, so it can run before any text exists.
 */
export async function isTranslationAvailable(): Promise<boolean> {
	const detector = (globalThis as { LanguageDetector?: { availability(): Promise<string> } }).LanguageDetector;
	const translator = (globalThis as { Translator?: unknown }).Translator;
	if (!detector || !translator) {
		return false;
	}
	try {
		return (await detector.availability()) !== 'unavailable';
	} catch {
		return false;
	}
}
