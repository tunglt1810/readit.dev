import { dominantScriptFamily, type ScriptFamily } from './script_detection.ts';

// Letters that Vietnamese uses and other Latin-script languages essentially do not: the horned and
// breve vowels, the barred d, and the whole tone-mark block. Deliberately excludes â/ê/ô, which
// French and Portuguese share.
const VIETNAMESE_LETTERS = /[Ạ-ỹăĂơƠưƯđĐ]/gu;
const LETTERS = /[^\W\d_]/gu;
// Real Vietnamese prose sits near 0.18; English and French sit at exactly 0. Anything above a few
// percent can only be Vietnamese, and the margin leaves room for quoted foreign passages.
const VIETNAMESE_LETTER_RATIO = 0.03;

/**
 * The script each non-Latin language the engines can speak is written in.
 *
 * Only non-Latin languages appear: a language missing from the table has no script on record, which
 * makes it disagree with any non-Latin observation — exactly the answer wanted for `en` on a
 * Cyrillic page, and for `na`.
 */
const SCRIPT_BY_LANGUAGE: Record<string, ScriptFamily> = {
	ja: 'ja',
	zh: 'zh',
	yue: 'zh',
	ko: 'ko',
	ru: 'cyrillic',
	uk: 'cyrillic',
	bg: 'cyrillic',
	sr: 'cyrillic',
	mk: 'cyrillic',
	be: 'cyrillic',
	kk: 'cyrillic',
	ky: 'cyrillic',
	mn: 'cyrillic',
	tg: 'cyrillic',
	ar: 'arabic',
	fa: 'arabic',
	ur: 'arabic',
	ps: 'arabic',
	ku: 'arabic',
	sd: 'arabic',
	th: 'thai',
	hi: 'devanagari',
	mr: 'devanagari',
	ne: 'devanagari',
	sa: 'devanagari',
	el: 'greek',
	he: 'hebrew',
	yi: 'hebrew',
};

/** The language to assume when a script is observed but the declaration does not name one of its own. */
const DEFAULT_LANGUAGE_BY_SCRIPT: Record<Exclude<ScriptFamily, 'latin'>, string> = {
	ja: 'ja',
	zh: 'zh',
	ko: 'ko',
	cyrillic: 'ru',
	arabic: 'ar',
	thai: 'th',
	devanagari: 'hi',
	greek: 'el',
	hebrew: 'he',
};

/**
 * The language of extracted text, for sources whose declared language is not evidence about it.
 *
 * Google Docs puts the Google account's UI locale in `<html lang>`, never the document's own
 * language, and the PDF path has no declaration at all. The duration predictor needs `vi` to apply
 * its Vietnamese correction — without it the latent is sized for English and the vector estimator
 * re-decodes spans it already produced, heard as swallowed and repeated words. The same correction
 * applied to non-Vietnamese text is wrong in the other direction, so the decision is made from the
 * text itself both ways.
 */
export function detectContentLanguage(content: string, declaredLang: string): string {
	const letterCount = content.match(LETTERS)?.length ?? 0;
	const vietnameseCount = content.match(VIETNAMESE_LETTERS)?.length ?? 0;
	if (letterCount > 0 && vietnameseCount / letterCount >= VIETNAMESE_LETTER_RATIO) {
		return 'vi';
	}

	// Latin is skipped deliberately: it cannot separate en/fr/de/es, and letting it answer would turn
	// an undeclared Latin page into a guess of English.
	const observed = dominantScriptFamily(content);
	if (observed !== null && observed !== 'latin') {
		const declaredScript = SCRIPT_BY_LANGUAGE[declaredLang.split('-')[0].toLowerCase()];
		return declaredScript === observed ? declaredLang : DEFAULT_LANGUAGE_BY_SCRIPT[observed];
	}

	return declaredLang === 'vi' ? 'na' : declaredLang;
}
