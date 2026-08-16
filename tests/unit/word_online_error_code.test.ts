import assert from 'node:assert/strict';
import test from 'node:test';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../../src/shared/constants.ts';
import { getPlaybackErrorTranslationKey } from '../../src/shared/i18n.ts';
import en from '../../src/shared/locales/en.json' with { type: 'json' };
import vi from '../../src/shared/locales/vi.json' with { type: 'json' };

test('maps the Word Online code to a translation key', () => {
	assert.equal(getPlaybackErrorTranslationKey(WORD_ONLINE_DOWNLOAD_UNAVAILABLE), 'wordOnlineDownloadUnavailable');
});

test('both locales carry a non-empty message for the code', () => {
	for (const locale of [en, vi]) {
		const message = (locale as Record<string, unknown>).wordOnlineDownloadUnavailable;
		assert.equal(typeof message, 'string');
		assert.ok((message as string).length > 0);
	}
});
