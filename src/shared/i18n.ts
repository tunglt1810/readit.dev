import { THEME_TRANSLATIONS } from './constants.ts';

export type UiLanguage = keyof typeof THEME_TRANSLATIONS;
export const uiLang: UiLanguage = chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en';
export const t = (key: keyof typeof THEME_TRANSLATIONS.en): string => THEME_TRANSLATIONS[uiLang][key];
