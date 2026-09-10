import { isOfferableLanguage } from '../shared/language_options.ts';
import type { ManualPlaybackStartPayload } from '../shared/manual_playback.ts';
import { isPanelInstanceId } from '../shared/manual_playback.ts';
import { normalizeManualText } from '../shared/manual_text.ts';
import { dominantScriptFamily } from '../shared/script_detection.ts';
import type { PlaybackContent, ResolvedManualTextLanguage } from '../shared/types.ts';

const VIETNAMESE_EXCLUSIVE = /[ăằắẳẵặđơờớởỡợưừứửữự]/iu;
const VIETNAMESE_FUNCTION_WORDS = new Set([
	'va',
	'và',
	'cua',
	'của',
	'mot',
	'một',
	'nhung',
	'những',
	'khong',
	'không',
	'duoc',
	'được',
	'trong',
	'cho',
	'voi',
	'với',
	'cac',
	'các',
]);

/** Scripts that name a language on their own; Latin does not, so it falls through to the heuristics. */
const LANGUAGE_BY_SCRIPT: Record<string, string> = {
	ja: 'ja',
	ko: 'ko',
	cyrillic: 'ru',
	arabic: 'ar',
	thai: 'th',
	devanagari: 'hi',
	greek: 'el',
	hebrew: 'he',
};

export function detectManualTextLanguage(text: string): ResolvedManualTextLanguage {
	const normalized = text.normalize('NFKC').toLocaleLowerCase();

	// Answered before the zh/vi/en heuristics below, which have no way to name any other language.
	// `zh` deliberately falls through to the Han ratio those heuristics already apply.
	const script = dominantScriptFamily(normalized);
	if (script !== null && script !== 'latin' && script !== 'zh') {
		return LANGUAGE_BY_SCRIPT[script];
	}

	const letters = normalized.match(/\p{L}/gu) ?? [];
	const hanCount = (normalized.match(/\p{Script=Han}/gu) ?? []).length;
	if (letters.length > 0 && hanCount / letters.length >= 0.2) {
		return 'zh';
	}
	const words = normalized.match(/\p{L}+/gu) ?? [];
	const functionWordCount = words.filter((word) => VIETNAMESE_FUNCTION_WORDS.has(word)).length;
	return VIETNAMESE_EXCLUSIVE.test(normalized) || functionWordCount >= 2 ? 'vi' : 'en';
}

export function prepareManualText(payload: unknown): PlaybackContent | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const input = payload as Record<string, unknown>;
	if (typeof input.text !== 'string' || typeof input.language !== 'string') {
		return null;
	}
	const language = input.language;
	if (language !== 'auto' && !isOfferableLanguage(language)) {
		return null;
	}
	const content = normalizeManualText(input.text);
	if (!content) {
		return null;
	}
	return { content, lang: language === 'auto' ? detectManualTextLanguage(content) : language };
}

export function prepareManualStart(payload: unknown): (PlaybackContent & { panelInstanceId: string }) | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const input = payload as Partial<ManualPlaybackStartPayload>;
	if (!isPanelInstanceId(input.panelInstanceId)) {
		return null;
	}
	const prepared = prepareManualText(input);
	return prepared ? { ...prepared, panelInstanceId: input.panelInstanceId } : null;
}
