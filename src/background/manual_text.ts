import type { ManualTextLanguage, PlaybackContent, ResolvedManualTextLanguage } from '../shared/types.ts';

const MANUAL_LANGUAGES = new Set<ManualTextLanguage>(['auto', 'en', 'vi', 'zh']);
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

function normalizeManualText(text: string): string {
	return text
		.normalize('NFKC')
		.replace(/\r\n?/gu, '\n')
		.split('\n')
		.map((line) => line.replace(/[\t ]+/gu, ' ').trimEnd())
		.join('\n')
		.trim();
}

export function detectManualTextLanguage(text: string): ResolvedManualTextLanguage {
	const normalized = text.normalize('NFKC').toLocaleLowerCase();
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
	if (
		typeof input.text !== 'string' ||
		typeof input.language !== 'string' ||
		!MANUAL_LANGUAGES.has(input.language as ManualTextLanguage)
	) {
		return null;
	}
	const content = normalizeManualText(input.text);
	if (!content) {
		return null;
	}
	const language = input.language as ManualTextLanguage;
	return { content, lang: language === 'auto' ? detectManualTextLanguage(content) : language };
}
