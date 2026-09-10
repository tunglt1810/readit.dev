/**
 * The writing system a piece of text uses, at the granularity that matters for choosing a voice.
 *
 * Han, kana and hangul collapse into `ja`/`zh`/`ko` rather than staying separate scripts because
 * the three languages share the Han block: kana and hangul are the only reliable separators, and a
 * caller that received "Han" would have to redo that test itself.
 */
export type ScriptFamily = 'ja' | 'zh' | 'ko' | 'cyrillic' | 'arabic' | 'thai' | 'devanagari' | 'greek' | 'hebrew' | 'latin';

const LETTERS = /\p{L}/gu;
const COUNTERS: { family: Exclude<ScriptFamily, 'ja' | 'ko'>; pattern: RegExp }[] = [
	{ family: 'zh', pattern: /\p{Script=Han}/gu },
	{ family: 'cyrillic', pattern: /\p{Script=Cyrillic}/gu },
	{ family: 'arabic', pattern: /\p{Script=Arabic}/gu },
	{ family: 'thai', pattern: /\p{Script=Thai}/gu },
	{ family: 'devanagari', pattern: /\p{Script=Devanagari}/gu },
	{ family: 'greek', pattern: /\p{Script=Greek}/gu },
	{ family: 'hebrew', pattern: /\p{Script=Hebrew}/gu },
	{ family: 'latin', pattern: /\p{Script=Latin}/gu },
];
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL = /\p{Script=Hangul}/gu;

/** A script has to carry most of the text to count; a quoted phrase must not decide the language. */
const DOMINANT_RATIO = 0.3;
/** Japanese prose always carries okurigana, so even a kanji-heavy headline clears this. */
const KANA_RATIO = 0.05;

function countOf(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

/**
 * The writing system that carries this text, or null when nothing dominates it.
 *
 * `latin` is a real answer, not a fallback: it says "not one of the others", which is what the
 * caller needs to know before deciding whether to trust a declared locale.
 */
export function dominantScriptFamily(text: string): ScriptFamily | null {
	const letters = countOf(text, LETTERS);
	if (letters === 0) {
		return null;
	}

	// Tested before the general counters: both scripts sit inside a CJK text whose Han count would
	// otherwise win and report Chinese.
	if (countOf(text, HANGUL) / letters >= KANA_RATIO) {
		return 'ko';
	}
	if (countOf(text, KANA) / letters >= KANA_RATIO) {
		return 'ja';
	}

	let best: ScriptFamily | null = null;
	let bestCount = 0;
	for (const counter of COUNTERS) {
		const count = countOf(text, counter.pattern);
		if (count > bestCount) {
			best = counter.family;
			bestCount = count;
		}
	}
	return best !== null && bestCount / letters >= DOMINANT_RATIO ? best : null;
}
