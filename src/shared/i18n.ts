import { GOOGLE_DOCS_EXPORT_UNAVAILABLE, PDF_ERROR_CODES, THEME_TRANSLATIONS } from './constants.ts';

export type UiLanguage = keyof typeof THEME_TRANSLATIONS;
export const uiLang: UiLanguage = chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en';
export const t = (key: keyof typeof THEME_TRANSLATIONS.en): string => THEME_TRANSLATIONS[uiLang][key];

export function getPlaybackErrorTranslationKey(error: string | undefined): keyof typeof THEME_TRANSLATIONS.en | undefined {
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
