import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_EDGE_VIETNAMESE_SPEED,
	DEFAULT_FALLBACK_SPEED,
	DEFAULT_VIETNAMESE_SPEED,
	getDefaultSpeedForLanguage,
	isLegacySpeedPreference,
	resolveStoredPlaybackSpeed,
} from '../../src/shared/constants.ts';

test('getDefaultSpeedForLanguage returns 1.5 for Vietnamese primary subtags and variants on Supertonic', () => {
	assert.equal(DEFAULT_VIETNAMESE_SPEED, 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi', 'supertonic'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi-VN', 'supertonic'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('VI', 'supertonic'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi-latn-VN', 'supertonic'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('  vi_VN ', 'supertonic'), 1.5);
});

test('getDefaultSpeedForLanguage returns 1.1 for fallback and non-Vietnamese languages', () => {
	assert.equal(DEFAULT_FALLBACK_SPEED, 1.1);
	assert.equal(getDefaultSpeedForLanguage('en', 'supertonic'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('ko', 'supertonic'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('ja', 'supertonic'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('fr', 'supertonic'), 1.1);
	assert.equal(getDefaultSpeedForLanguage(undefined, 'supertonic'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('', 'supertonic'), 1.1);
});

// The 1.5 boost compensates for how slowly Supertonic reads Vietnamese. Microsoft's vi-VN voices
// are already calibrated: measured against vi-VN-HoaiMyNeural, rate +0% reads 4.3 words/s while
// +50% reaches 6.4 words/s, which is much too fast to follow.
test('getDefaultSpeedForLanguage drops the Supertonic Vietnamese boost on the edge path', () => {
	assert.equal(DEFAULT_EDGE_VIETNAMESE_SPEED, 1);
	assert.equal(getDefaultSpeedForLanguage('vi', 'edge'), 1);
	assert.equal(getDefaultSpeedForLanguage('vi-VN', 'edge'), 1);
	assert.equal(getDefaultSpeedForLanguage('  vi_VN ', 'edge'), 1);
});

test('getDefaultSpeedForLanguage leaves non-Vietnamese languages unchanged on the edge path', () => {
	assert.equal(getDefaultSpeedForLanguage('en', 'edge'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('ja', 'edge'), 1.1);
	assert.equal(getDefaultSpeedForLanguage(undefined, 'edge'), 1.1);
});

test('resolves explicit and legacy stored speeds while respecting an explicit default marker', () => {
	assert.equal(resolveStoredPlaybackSpeed('en', 1.5, false, 'supertonic'), 1.1);
	assert.equal(resolveStoredPlaybackSpeed('vi', 1.5, false, 'supertonic'), 1.5);
	assert.equal(resolveStoredPlaybackSpeed('en', 1.8, true, 'supertonic'), 1.8);
	assert.equal(resolveStoredPlaybackSpeed('en', 1.3, undefined, 'supertonic'), 1.3);
	assert.equal(resolveStoredPlaybackSpeed('vi', undefined, undefined, 'supertonic'), 1.5);
	assert.equal(resolveStoredPlaybackSpeed('vi', undefined, undefined, 'edge'), 1);
	assert.equal(resolveStoredPlaybackSpeed('vi', 1.5, false, 'edge'), 1);
	// An explicit choice is still the reader's to make, whichever engine speaks it.
	assert.equal(resolveStoredPlaybackSpeed('vi', 1.4, true, 'edge'), 1.4);
	assert.equal(isLegacySpeedPreference(1.3, undefined), true);
	assert.equal(isLegacySpeedPreference(1.3, false), false);
	assert.equal(isLegacySpeedPreference(undefined, undefined), false);
});
