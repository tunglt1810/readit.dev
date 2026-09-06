import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEdgeVoice } from '../../src/shared/edge_voice_preferences.ts';

test('uses the stored voice for that language', () => {
	assert.equal(resolveEdgeVoice({ vi: 'vi-VN-NamMinhNeural' }, 'vi'), 'vi-VN-NamMinhNeural');
});

test('falls back to the language default when nothing is stored', () => {
	assert.equal(resolveEdgeVoice({}, 'vi'), 'vi-VN-HoaiMyNeural');
});

test('ignores a stored voice that does not belong to the language', () => {
	assert.equal(resolveEdgeVoice({ vi: 'en-US-AvaNeural' }, 'vi'), 'vi-VN-HoaiMyNeural');
});

test('returns null for a language edge-tts cannot speak', () => {
	assert.equal(resolveEdgeVoice({}, 'na'), null);
});

test('keys preferences by base language, not by regional variant', () => {
	assert.equal(resolveEdgeVoice({ en: 'en-US-AndrewNeural' }, 'en-GB'), 'en-US-AndrewNeural');
});
