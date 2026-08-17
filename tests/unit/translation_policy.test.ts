import assert from 'node:assert/strict';
import test from 'node:test';
import {
	DEFAULT_TRANSLATION_TARGET,
	isTranslationTarget,
	MIN_SOURCE_CONFIDENCE,
	resolveTranslationPair,
	TRANSLATION_TARGETS,
} from '../../src/shared/translation_policy.ts';

test('offers exactly the three languages the engine can speak', () => {
	assert.deepEqual([...TRANSLATION_TARGETS], ['vi', 'en', 'zh']);
});

test('defaults to Vietnamese', () => {
	assert.equal(DEFAULT_TRANSLATION_TARGET, 'vi');
});

test('the default is a real target', () => {
	assert.equal(isTranslationTarget(DEFAULT_TRANSLATION_TARGET), true);
});

test('recognises valid targets and rejects anything else', () => {
	assert.equal(isTranslationTarget('vi'), true);
	assert.equal(isTranslationTarget('ja'), false);
	assert.equal(isTranslationTarget(undefined), false);
});

test('resolves a pair when the source differs from the target', () => {
	assert.deepEqual(resolveTranslationPair({ language: 'en', confidence: 1 }, 'vi'), {
		sourceLanguage: 'en',
		targetLanguage: 'vi',
	});
});

test('declines when the source already matches the target', () => {
	assert.equal(resolveTranslationPair({ language: 'vi', confidence: 0.999 }, 'vi'), null);
});

test('declines when the source is a regional variant of the target', () => {
	assert.equal(resolveTranslationPair({ language: 'en-GB', confidence: 1 }, 'en'), null);
});

test('declines when confidence is below the threshold', () => {
	assert.equal(resolveTranslationPair({ language: 'en', confidence: MIN_SOURCE_CONFIDENCE - 0.01 }, 'vi'), null);
});

test('accepts confidence exactly at the threshold', () => {
	assert.notEqual(resolveTranslationPair({ language: 'en', confidence: MIN_SOURCE_CONFIDENCE }, 'vi'), null);
});

test('declines when detection produced nothing', () => {
	assert.equal(resolveTranslationPair(null, 'vi'), null);
});
