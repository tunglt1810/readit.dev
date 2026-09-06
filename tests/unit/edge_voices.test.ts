import assert from 'node:assert/strict';
import test from 'node:test';
import {
	defaultVoiceForLanguage,
	isEdgeSupportedLanguage,
	localeForLanguage,
	voiceBelongsToLanguage,
	voicesForLanguage,
} from '../../src/shared/edge_voices.ts';

test('maps a bare language code to a full locale', () => {
	assert.equal(localeForLanguage('vi'), 'vi-VN');
	assert.equal(localeForLanguage('en'), 'en-US');
});

test('accepts a full locale and regional variants', () => {
	assert.equal(localeForLanguage('en-GB'), 'en-GB');
	assert.equal(localeForLanguage('vi-VN'), 'vi-VN');
});

test('is case and separator insensitive', () => {
	assert.equal(localeForLanguage('VI'), 'vi-VN');
	assert.equal(localeForLanguage('en_GB'), 'en-GB');
});

test('rejects the Supertonic-only placeholder language', () => {
	assert.equal(localeForLanguage('na'), null);
	assert.equal(isEdgeSupportedLanguage('na'), false);
});

test('rejects an unknown language', () => {
	assert.equal(localeForLanguage('zzz'), null);
	assert.deepEqual(voicesForLanguage('zzz'), []);
	assert.equal(defaultVoiceForLanguage('zzz'), null);
});

test('lists exactly the Vietnamese voices', () => {
	const names = voicesForLanguage('vi').map((voice) => voice.shortName);
	assert.deepEqual(names, ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural']);
});

test('picks a stable default voice for a language', () => {
	assert.equal(defaultVoiceForLanguage('vi'), 'vi-VN-HoaiMyNeural');
	assert.equal(defaultVoiceForLanguage('vi'), defaultVoiceForLanguage('vi'));
});

test('accepts a voice from any regional variant of the same language', () => {
	assert.equal(voiceBelongsToLanguage('en-GB-SoniaNeural', 'en-US'), true);
	assert.equal(voiceBelongsToLanguage('en-US-AvaNeural', 'en'), true);
});

test('rejects a voice from a different language', () => {
	assert.equal(voiceBelongsToLanguage('en-US-AvaNeural', 'vi'), false);
	assert.equal(voiceBelongsToLanguage('not-a-voice', 'en'), false);
});
