// Letters that Vietnamese uses and other Latin-script languages essentially do not: the horned and
// breve vowels, the barred d, and the whole tone-mark block. Deliberately excludes â/ê/ô, which
// French and Portuguese share.
const VIETNAMESE_LETTERS = /[Ạ-ỹăĂơƠưƯđĐ]/gu;
const LETTERS = /[^\W\d_]/gu;
// Real Vietnamese prose sits near 0.18; English and French sit at exactly 0. Anything above a few
// percent can only be Vietnamese, and the margin leaves room for quoted foreign passages.
const VIETNAMESE_LETTER_RATIO = 0.03;

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
	return declaredLang === 'vi' ? 'na' : declaredLang;
}
