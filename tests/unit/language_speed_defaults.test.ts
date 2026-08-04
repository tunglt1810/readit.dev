import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_FALLBACK_SPEED,
	DEFAULT_VIETNAMESE_SPEED,
	getDefaultSpeedForLanguage,
	isLegacySpeedPreference,
	resolveStoredPlaybackSpeed,
} from '../../src/shared/constants.ts';

test('getDefaultSpeedForLanguage returns 1.5 for Vietnamese primary subtags and variants', () => {
	assert.equal(DEFAULT_VIETNAMESE_SPEED, 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi-VN'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('VI'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi-latn-VN'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('  vi_VN '), 1.5);
});

test('getDefaultSpeedForLanguage returns 1.1 for fallback and non-Vietnamese languages', () => {
	assert.equal(DEFAULT_FALLBACK_SPEED, 1.1);
	assert.equal(getDefaultSpeedForLanguage('en'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('ko'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('ja'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('fr'), 1.1);
	assert.equal(getDefaultSpeedForLanguage(undefined), 1.1);
	assert.equal(getDefaultSpeedForLanguage(''), 1.1);
});

test('resolves explicit and legacy stored speeds while respecting an explicit default marker', () => {
	assert.equal(resolveStoredPlaybackSpeed('en', 1.5, false), 1.1);
	assert.equal(resolveStoredPlaybackSpeed('vi', 1.5, false), 1.5);
	assert.equal(resolveStoredPlaybackSpeed('en', 1.8, true), 1.8);
	assert.equal(resolveStoredPlaybackSpeed('en', 1.3, undefined), 1.3);
	assert.equal(resolveStoredPlaybackSpeed('vi', undefined, undefined), 1.5);
	assert.equal(isLegacySpeedPreference(1.3, undefined), true);
	assert.equal(isLegacySpeedPreference(1.3, false), false);
	assert.equal(isLegacySpeedPreference(undefined, undefined), false);
});
