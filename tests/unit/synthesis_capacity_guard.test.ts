import assert from 'node:assert/strict';
import test from 'node:test';
import { synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';
import { assertWithinSynthesisCapacity, finalRenderingText, synthesisTextLimitForLanguage } from '../../src/offscreen/supertonic_helper.ts';

test('synthesisTextLimitForLanguage returns 300 for Latin/Vietnamese/English and 120 for CJK', () => {
	assert.equal(synthesisTextLimitForLanguage('en'), 300);
	assert.equal(synthesisTextLimitForLanguage('vi'), 300);
	assert.equal(synthesisTextLimitForLanguage('fr'), 300);
	assert.equal(synthesisTextLimitForLanguage('ko'), 120);
	assert.equal(synthesisTextLimitForLanguage('ja'), 120);
});

test('finalRenderingText returns synthesisText when present, otherwise text', () => {
	assert.equal(finalRenderingText({ text: 'canonical text' }), 'canonical text');
	assert.equal(finalRenderingText({ text: 'canonical text', synthesisText: 'synthesis rendering.' }), 'synthesis rendering.');
});

test('assertWithinSynthesisCapacity accepts units at or under capacity limit', () => {
	assert.doesNotThrow(() => assertWithinSynthesisCapacity({ text: 'a'.repeat(300) }, 'en'));
	assert.doesNotThrow(() => assertWithinSynthesisCapacity({ text: '한'.repeat(120) }, 'ko'));
});

test('assertWithinSynthesisCapacity rejects Final Rendering beyond capacity', () => {
	assert.throws(() => assertWithinSynthesisCapacity({ text: 'a'.repeat(301) }, 'en'));
	assert.throws(() => assertWithinSynthesisCapacity({ text: '한'.repeat(121) }, 'ko'));
	assert.throws(() => assertWithinSynthesisCapacity({ text: 'a'.repeat(300), synthesisText: `${'a'.repeat(300)}.` }, 'en'));
});

test('rejects an over-capacity speech unit before invoking the synthesis engine', async () => {
	let synthesizeCalls = 0;
	await assert.rejects(() =>
		synthesizeSpeechUnitSamples({ text: '한'.repeat(121), pauseAfterMs: 180 }, 'ko', 1, async () => {
			synthesizeCalls++;
			return new Float32Array();
		}),
	);
	assert.equal(synthesizeCalls, 0);
});
