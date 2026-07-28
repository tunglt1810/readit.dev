import assert from 'node:assert/strict';
import test from 'node:test';
import { PDF_ERROR_CODES } from '../../src/shared/constants.ts';

Object.defineProperty(globalThis, 'chrome', {
	configurable: true,
	value: {
		i18n: {
			getUILanguage: () => 'en-US',
		},
	},
});

const { getLocalizedPlaybackError, getPlaybackErrorTranslationKey, THEME_TRANSLATIONS } = await import('../../src/shared/i18n.ts');

test('maps each PDF extraction error code to its translation key', () => {
	assert.strictEqual(getPlaybackErrorTranslationKey(PDF_ERROR_CODES.fileAccessRequired), 'pdfFileAccessRequired');
	assert.strictEqual(getPlaybackErrorTranslationKey(PDF_ERROR_CODES.passwordProtected), 'pdfPasswordProtected');
	assert.strictEqual(getPlaybackErrorTranslationKey(PDF_ERROR_CODES.textUnavailable), 'pdfTextUnavailable');
	assert.strictEqual(getPlaybackErrorTranslationKey(PDF_ERROR_CODES.extractionFailed), 'pdfExtractionFailed');
});

test('localizes PDF extraction errors for English and Vietnamese', () => {
	for (const errorCode of Object.values(PDF_ERROR_CODES)) {
		const key = getPlaybackErrorTranslationKey(errorCode);
		assert.ok(key);
		assert.strictEqual(getLocalizedPlaybackError(errorCode), THEME_TRANSLATIONS.en[key]);
		assert.notStrictEqual(THEME_TRANSLATIONS.vi[key], THEME_TRANSLATIONS.en[key]);
	}
});
