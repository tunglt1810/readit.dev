import assert from 'node:assert/strict';
import test from 'node:test';
import { pickStoredTranslationTarget } from '../../src/shared/translation_target_store.ts';

test('uses the stored value when it names a speakable language', () => {
	assert.equal(pickStoredTranslationTarget('zh'), 'zh');
	assert.equal(pickStoredTranslationTarget('en'), 'en');
});

test('falls back to the default when nothing is stored', () => {
	assert.equal(pickStoredTranslationTarget(undefined), 'vi');
});

test('falls back to the default when the stored value is stale or invalid', () => {
	assert.equal(pickStoredTranslationTarget('ja'), 'vi');
	assert.equal(pickStoredTranslationTarget(42), 'vi');
});
