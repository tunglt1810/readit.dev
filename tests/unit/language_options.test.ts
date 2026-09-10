import assert from 'node:assert/strict';
import test from 'node:test';
import { isEdgeSupportedLanguage } from '../../src/shared/edge_voices.ts';
import { isOfferableLanguage, languageDisplayName, languageOptionsFor } from '../../src/shared/language_options.ts';
import { AVAILABLE_LANGS } from '../../src/shared/supertonic_languages.ts';

test('every edge option is a language edge-tts actually has a voice for', () => {
	const options = languageOptionsFor('edge');
	assert.ok(options.length > 10);
	for (const option of options) {
		assert.ok(isEdgeSupportedLanguage(option.code), `${option.code} has no edge voice`);
	}
});

test('the on-device list is the engine list without its not-detected placeholder', () => {
	const codes = languageOptionsFor('supertonic').map((option) => option.code);
	assert.deepEqual([...codes].sort(), AVAILABLE_LANGS.filter((lang) => lang !== 'na').sort());
});

test('options carry a human name and are sorted by it', () => {
	const options = languageOptionsFor('edge');
	for (const option of options) {
		assert.ok(option.name.length > 0);
	}
	const names = options.map((option) => option.name);
	assert.deepEqual(
		names,
		[...names].sort((a, b) => a.localeCompare(b)),
	);
});

test('names a language for the auto label', () => {
	assert.equal(typeof languageDisplayName('vi'), 'string');
	assert.ok(languageDisplayName('vi').length > 0);
});

test('a language either engine can speak is offerable; nonsense is not', () => {
	// Validation spans both engines on purpose: the manual-text path validates before the engine for
	// that session has been settled, and rejecting a language the other engine speaks would be wrong.
	assert.equal(isOfferableLanguage('de'), true);
	assert.equal(isOfferableLanguage('vi'), true);
	assert.equal(isOfferableLanguage('xx'), false);
	assert.equal(isOfferableLanguage('na'), false);
	assert.equal(isOfferableLanguage('auto'), false);
});
