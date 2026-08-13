import assert from 'node:assert/strict';
import test from 'node:test';
import { EPUB_ERROR_CODES, STORAGE_KEYS } from '../../src/shared/constants.ts';
import { getPlaybackErrorTranslationKey } from '../../src/shared/i18n.ts';
import en from '../../src/shared/locales/en.json' with { type: 'json' };
import vi from '../../src/shared/locales/vi.json' with { type: 'json' };

test('every EPUB error code maps to a translation key present in both locales', () => {
	for (const code of Object.values(EPUB_ERROR_CODES)) {
		const key = getPlaybackErrorTranslationKey(code);
		assert.ok(key, `no translation key for ${code}`);
		assert.ok((en as Record<string, unknown>)[key], `missing en string for ${key}`);
		assert.ok((vi as Record<string, unknown>)[key], `missing vi string for ${key}`);
	}
});

test('reader UI labels exist in both locales', () => {
	for (const key of ['openBook', 'resumeReading', 'chapterProgress', 'bookOpenFailed', 'previousChapter', 'nextChapter']) {
		assert.ok((en as Record<string, unknown>)[key], `missing en string for ${key}`);
		assert.ok((vi as Record<string, unknown>)[key], `missing vi string for ${key}`);
	}
});

test('the empty Document Reader points at the local file picker it now offers', () => {
	for (const locale of [en, vi] as Record<string, string>[]) {
		assert.match(locale.documentReaderEmptyBody, /EPUB/);
	}
});

test('the EPUB progress storage key is registered', () => {
	assert.equal(STORAGE_KEYS.EPUB_PROGRESS, 'readit_epub_progress');
});
