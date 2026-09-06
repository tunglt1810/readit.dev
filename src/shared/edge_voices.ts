import catalogue from '../../public/assets/edge_voices.json' with { type: 'json' };

export interface EdgeVoice {
	shortName: string;
	locale: string;
	gender: 'male' | 'female';
	friendlyName: string;
}

const VOICES = catalogue as EdgeVoice[];

/**
 * Preferred locale per bare language code. Microsoft ships several regional variants for the big
 * languages and a bare code has to resolve to exactly one of them; these are the variants with the
 * widest voice selection.
 */
const PREFERRED_LOCALES: Record<string, string> = {
	ar: 'ar-EG',
	en: 'en-US',
	es: 'es-ES',
	fr: 'fr-FR',
	nl: 'nl-NL',
	pt: 'pt-BR',
	sv: 'sv-SE',
	vi: 'vi-VN',
	zh: 'zh-CN',
};

function canonical(lang: string): string {
	return lang.trim().replaceAll('_', '-').toLowerCase();
}

const LOCALE_BY_LOWERCASE = new Map(VOICES.map((voice) => [voice.locale.toLowerCase(), voice.locale]));

/**
 * The locale whose voices should speak this content, or null when Microsoft has none.
 *
 * `na` is Supertonic's placeholder for "language not detected" and deliberately resolves to null,
 * so the caller falls back rather than guessing a locale.
 */
export function localeForLanguage(lang: string): string | null {
	const code = canonical(lang);
	if (code === 'na' || code === '') {
		return null;
	}
	const exact = LOCALE_BY_LOWERCASE.get(code);
	if (exact) {
		return exact;
	}
	const base = code.split('-')[0];
	const preferred = PREFERRED_LOCALES[base];
	if (preferred && LOCALE_BY_LOWERCASE.has(preferred.toLowerCase())) {
		return preferred;
	}
	return VOICES.find((voice) => voice.locale.toLowerCase().startsWith(`${base}-`))?.locale ?? null;
}

export function isEdgeSupportedLanguage(lang: string): boolean {
	return localeForLanguage(lang) !== null;
}

export function voicesForLanguage(lang: string): EdgeVoice[] {
	const locale = localeForLanguage(lang);
	return locale === null ? [] : VOICES.filter((voice) => voice.locale === locale);
}

/**
 * Whether a stored voice still suits this content.
 *
 * Judged by base language rather than exact locale: someone who picked a British voice for an
 * English article should keep it when the next English article declares en-US, and the alternative
 * is silently swapping their voice on a distinction they never expressed an opinion about.
 */
export function voiceBelongsToLanguage(shortName: string, lang: string): boolean {
	const base = canonical(lang).split('-')[0];
	return VOICES.some((voice) => voice.shortName === shortName && voice.locale.toLowerCase().startsWith(`${base}-`));
}

/** The catalogue is sorted by shortName, so "first female, else first" is stable across builds. */
export function defaultVoiceForLanguage(lang: string): string | null {
	const voices = voicesForLanguage(lang);
	const preferred = voices.find((voice) => voice.gender === 'female') ?? voices[0];
	return preferred?.shortName ?? null;
}
