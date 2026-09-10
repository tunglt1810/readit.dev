import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLanguageOverride } from '../../src/background/language_override.ts';

test('accepts a language tag and normalises it', () => {
	assert.equal(parseLanguageOverride({ languageOverride: 'JA' }), 'ja');
	assert.equal(parseLanguageOverride({ languageOverride: ' vi ' }), 'vi');
	assert.equal(parseLanguageOverride({ languageOverride: 'zh_CN' }), 'zh-cn');
});

test('treats auto and anything unusable as no override', () => {
	assert.equal(parseLanguageOverride({ languageOverride: 'auto' }), undefined);
	assert.equal(parseLanguageOverride({ languageOverride: '' }), undefined);
	assert.equal(parseLanguageOverride({ languageOverride: 42 }), undefined);
	assert.equal(parseLanguageOverride({}), undefined);
	assert.equal(parseLanguageOverride(undefined), undefined);
});
