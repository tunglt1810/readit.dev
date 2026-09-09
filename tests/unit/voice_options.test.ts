import assert from 'node:assert/strict';
import test from 'node:test';
import { VOICE_STYLES } from '../../src/shared/constants.ts';
import { uiLang, VOICE_STYLE_TRANSLATIONS } from '../../src/shared/i18n.ts';
import { voiceOptionsFor } from '../../src/shared/voice_options.ts';

// The rule this file pins used to be written out by hand in SettingsCard, and the reader surface
// never got a copy — so it listed on-device voice names while edge-tts was doing the speaking.
test('offers the cloud voices for a language Microsoft covers', () => {
	const { usingEdge, options } = voiceOptionsFor('edge', 'vi');
	assert.equal(usingEdge, true);
	assert.ok(options.length > 0);
	assert.ok(
		options.every((option) => option.id.startsWith('vi-VN-')),
		`expected vi-VN voices, got ${options.map((option) => option.id).join(', ')}`,
	);
});

// Both lists carry the same gender marker, so switching engine does not reshuffle how they read.
test('labels every voice with its gender, on either engine', () => {
	assert.match(voiceOptionsFor('edge', 'vi').options[0].name, /^[♂♀]/u);
	assert.match(voiceOptionsFor('supertonic', 'vi').options[0].name, /^[♂♀]/u);
});

// SettingsCard localised the on-device names and the reader did not. Doing it here is what keeps
// the two surfaces from drifting apart again.
test('localises the on-device voice names', () => {
	const [first] = voiceOptionsFor('supertonic', 'vi').options;
	assert.equal(first.name, `♂️ ${VOICE_STYLE_TRANSLATIONS[uiLang].M1}`);
});

// A language with no Microsoft voices silently runs on-device, so the list has to say so.
test('falls back to the on-device voices when the cloud has none for the language', () => {
	const { usingEdge, options } = voiceOptionsFor('edge', 'na');
	assert.equal(usingEdge, false);
	assert.deepEqual(
		options.map((option) => option.id),
		VOICE_STYLES.map((voice) => voice.id),
	);
});

test('offers the on-device voices whenever that engine is chosen', () => {
	const { usingEdge, options } = voiceOptionsFor('supertonic', 'vi');
	assert.equal(usingEdge, false);
	assert.deepEqual(
		options.map((option) => option.id),
		VOICE_STYLES.map((voice) => voice.id),
	);
});

test('treats an unknown language as having no cloud voices', () => {
	assert.equal(voiceOptionsFor('edge', '').usingEdge, false);
});
