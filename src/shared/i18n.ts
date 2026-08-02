import { GOOGLE_DOCS_EXPORT_UNAVAILABLE, PDF_ERROR_CODES } from './constants.ts';
import en from './locales/en.json' with { type: 'json' };
import vi from './locales/vi.json' with { type: 'json' };

export const THEME_TRANSLATIONS = { vi, en };
export const VOICE_STYLE_TRANSLATIONS = {
	vi: vi.voiceStyles,
	en: en.voiceStyles,
};

export type UiLanguage = keyof typeof THEME_TRANSLATIONS;
export type TranslationKey = Exclude<keyof typeof en, 'voiceStyles'>;
export function getUiLanguage(): UiLanguage {
	if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
		return chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en';
	}
	return 'en';
}

export const uiLang: UiLanguage = getUiLanguage();
export const t = (key: TranslationKey): string => THEME_TRANSLATIONS[getUiLanguage()][key];

export function getPlaybackErrorTranslationKey(error: string | undefined): TranslationKey | undefined {
	switch (error) {
		case GOOGLE_DOCS_EXPORT_UNAVAILABLE:
			return 'googleDocsExportUnavailable';
		case PDF_ERROR_CODES.fileAccessRequired:
			return 'pdfFileAccessRequired';
		case PDF_ERROR_CODES.passwordProtected:
			return 'pdfPasswordProtected';
		case PDF_ERROR_CODES.textUnavailable:
			return 'pdfTextUnavailable';
		case PDF_ERROR_CODES.extractionFailed:
			return 'pdfExtractionFailed';
		default:
			return undefined;
	}
}

export function getLocalizedPlaybackError(error: string | undefined): string | undefined {
	const translationKey = getPlaybackErrorTranslationKey(error);
	return translationKey ? t(translationKey) : error;
}
