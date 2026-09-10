import type { TtsProviderId } from './edge_voice_preferences.ts';
import { edgeBaseLanguages } from './edge_voices.ts';
import { uiLang } from './i18n.ts';
import { AVAILABLE_LANGS } from './supertonic_languages.ts';

export interface LanguageOption {
	code: string;
	name: string;
}

const DISPLAY_NAMES = new Intl.DisplayNames([uiLang], { type: 'language' });

/**
 * The language's name in the interface language.
 *
 * `Intl.DisplayNames` is the whole implementation on purpose: a hand-written table for forty
 * languages in two interface languages is eighty strings that go stale, and the browser already
 * ships the data.
 */
export function languageDisplayName(code: string): string {
	try {
		return DISPLAY_NAMES.of(code) ?? code;
	} catch {
		// `of` throws on a structurally invalid tag rather than returning undefined.
		return code;
	}
}

/**
 * The languages worth offering for an engine.
 *
 * Bound to what the engine can actually speak: offering a language with no voice behind it names a
 * choice the listener will never hear, which is the same class of bug that made the reader list
 * on-device voices while edge-tts was speaking.
 */
export function languageOptionsFor(provider: TtsProviderId): LanguageOption[] {
	const codes = provider === 'edge' ? edgeBaseLanguages() : AVAILABLE_LANGS.filter((lang) => lang !== 'na');
	return codes.map((code) => ({ code, name: languageDisplayName(code) })).sort((a, b) => a.name.localeCompare(b.name));
}

const OFFERABLE = [...new Set([...edgeBaseLanguages(), ...AVAILABLE_LANGS.filter((lang) => lang !== 'na')])];
const OFFERABLE_SET = new Set(OFFERABLE);

/**
 * Every language some engine can speak, for choices made before an engine is in the picture.
 *
 * The manual-text tab needs this rather than the selected engine's list: the on-device engine has no
 * Chinese, and scoping that tab to it would silently drop a language it has always offered.
 */
export function allOfferableLanguages(): LanguageOption[] {
	return OFFERABLE.map((code) => ({ code, name: languageDisplayName(code) })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether some engine can speak this language.
 *
 * Spans both engines rather than the selected one: a request carries a language, not an engine, and
 * the engine that ends up speaking is settled later — rejecting a language the other engine handles
 * would turn a working choice into a silent failure.
 */
export function isOfferableLanguage(code: string): boolean {
	return OFFERABLE_SET.has(code);
}
