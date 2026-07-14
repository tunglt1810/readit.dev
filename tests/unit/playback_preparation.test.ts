import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';

test('normalizes resolved Vietnamese once and plans pauses', async () => {
	let calls = 0;
	const units = await preparePlaybackUnits('ĐH mở cửa.', 'vi', {
		async normalize() {
			calls++;
			return {
				text: 'đại học mở cửa.',
				diagnostics: { tokenCount: 3, crfMs: 0, expansionMs: 0, totalMs: 0, usedCrf: true, usedAbbreviationScorer: false },
			};
		},
	});
	assert.equal(calls, 1);
	assert.deepEqual(units, [{ text: 'đại học mở cửa.', pauseAfterMs: 165 }]);
});

test('uses compatibility chunks for non-resolved languages without loading Vietnamese assets', async () => {
	let calls = 0;
	const normalizer = {
		async normalize() {
			calls++;
			throw new Error('must not run');
		},
	};
	for (const lang of ['en', 'na', 'vi-VN']) {
		assert.deepEqual(await preparePlaybackUnits('First sentence. Second sentence.', lang, normalizer), [
			{ text: 'First sentence. Second sentence.', pauseAfterMs: 0 },
		]);
	}
	assert.equal(calls, 0);
});

test('fails open to speech units from the exact original Vietnamese text', async () => {
	const units = await preparePlaybackUnits('Một câu, vẫn đọc được.', 'vi', {
		async normalize() {
			throw new Error('expected failure');
		},
	});
	assert.deepEqual(units, [{ text: 'Một câu, vẫn đọc được.', pauseAfterMs: 165 }]);
});

test('returns identical units for identical selected and article text', async () => {
	const text = 'Nội dung giống nhau.';
	const normalizer = {
		async normalize() {
			return {
				text,
				diagnostics: { tokenCount: 3, crfMs: 0, expansionMs: 0, totalMs: 0, usedCrf: false, usedAbbreviationScorer: false },
			};
		},
	};
	assert.deepEqual(await preparePlaybackUnits(text, 'vi', normalizer), await preparePlaybackUnits(text, 'vi', normalizer));
});

test('does not return empty units when normalization yields whitespace', async () => {
	const units = await preparePlaybackUnits('Vẫn phải đọc.', 'vi', {
		async normalize() {
			return {
				text: ' \n\n ',
				diagnostics: { tokenCount: 0, crfMs: 0, expansionMs: 0, totalMs: 0, usedCrf: false, usedAbbreviationScorer: false },
			};
		},
	});
	assert.deepEqual(units, [{ text: 'Vẫn phải đọc.', pauseAfterMs: 165 }]);
});
