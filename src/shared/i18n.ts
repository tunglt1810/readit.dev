import {
	DOCX_ERROR_CODES,
	EPUB_ERROR_CODES,
	GOOGLE_DOCS_EXPORT_UNAVAILABLE,
	PDF_ERROR_CODES,
	TRANSLATION_FAILED,
	WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
} from './constants.ts';
import en from './locales/en.json' with { type: 'json' };
import vi from './locales/vi.json' with { type: 'json' };
import type { TranslationTarget } from './types.ts';

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

export function translationTargetLabel(target: TranslationTarget): string {
	if (target === 'vi') {
		return t('translationLanguageVi');
	}
	if (target === 'zh') {
		return t('translationLanguageZh');
	}
	return t('translationLanguageEn');
}

/** Names the language the listener will actually hear, rather than the mechanism that gets there. */
export function translateAndReadLabel(target: TranslationTarget): string {
	return t('translateAndReadIn').replace('{language}', translationTargetLabel(target));
}

export function getPlaybackErrorTranslationKey(error: string | undefined): TranslationKey | undefined {
	switch (error) {
		case GOOGLE_DOCS_EXPORT_UNAVAILABLE:
			return 'googleDocsExportUnavailable';
		case WORD_ONLINE_DOWNLOAD_UNAVAILABLE:
			return 'wordOnlineDownloadUnavailable';
		case TRANSLATION_FAILED:
			return 'translationFailed';
		case PDF_ERROR_CODES.fileAccessRequired:
			return 'pdfFileAccessRequired';
		case PDF_ERROR_CODES.passwordProtected:
			return 'pdfPasswordProtected';
		case PDF_ERROR_CODES.textUnavailable:
			return 'pdfTextUnavailable';
		case PDF_ERROR_CODES.extractionFailed:
			return 'pdfExtractionFailed';
		case EPUB_ERROR_CODES.parseFailed:
			return 'epubParseFailed';
		case EPUB_ERROR_CODES.drmProtected:
			return 'epubDrmProtected';
		case EPUB_ERROR_CODES.fileAccessDenied:
			return 'epubFileAccessDenied';
		case DOCX_ERROR_CODES.parseFailed:
			return 'docxParseFailed';
		case DOCX_ERROR_CODES.textUnavailable:
			return 'docxTextUnavailable';
		case DOCX_ERROR_CODES.legacyFormat:
			return 'docLegacyFormat';
		default:
			return undefined;
	}
}

export function getLocalizedPlaybackError(error: string | undefined): string | undefined {
	const translationKey = getPlaybackErrorTranslationKey(error);
	return translationKey ? t(translationKey) : error;
}
