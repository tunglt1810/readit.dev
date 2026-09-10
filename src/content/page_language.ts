import { detectContentLanguage } from '../shared/language_detection.ts';
import { parseGoogleDocsDocumentId } from './google_docs_extractor.ts';
import { parseWordOnlineDocument } from './word_online_extractor.ts';

/** Enough prose to judge a script ratio from; a nav bar alone should not decide a language. */
const MIN_SAMPLE_LETTERS = 100;
/** More than this buys no accuracy and costs the panel a slower page-info round trip. */
const SAMPLE_LIMIT = 4000;

export interface PageLanguage {
	lang: string;
	/** `unknown` means the value is the page's own claim, which is weak evidence at best. */
	langSource: 'detected' | 'unknown';
}

/**
 * The language of the page in front of the reader, decided before anything is read aloud.
 *
 * Google Docs and Word Online render into a canvas: their `innerText` is chrome, and Google Docs'
 * `<html lang>` is the Google account's locale rather than the document's language. Guessing from
 * either would be confident and wrong, so both surfaces report `unknown` and let the reader choose.
 */
export function resolvePageLanguage(input: { url: string; declared: string; sample: string }): PageLanguage {
	const sample = input.sample.slice(0, SAMPLE_LIMIT);
	const trustworthy =
		parseGoogleDocsDocumentId(input.url) === null &&
		parseWordOnlineDocument(input.url) === null &&
		(sample.match(/\p{L}/gu)?.length ?? 0) >= MIN_SAMPLE_LETTERS;

	if (!trustworthy) {
		return { lang: input.declared, langSource: 'unknown' };
	}
	return { lang: detectContentLanguage(sample, input.declared), langSource: 'detected' };
}
