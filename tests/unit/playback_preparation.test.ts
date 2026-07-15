import assert from 'node:assert/strict';
import test from 'node:test';
import { isVietnameseLanguage, preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';

const diagnostics = {
	tokenCount: 3,
	crfMs: 0,
	expansionMs: 0,
	totalMs: 0,
	usedCrf: true,
	usedAbbreviationScorer: false,
};

test('recognizes Vietnamese primary language subtags', () => {
	for (const lang of ['vi', 'VI', 'vi-VN', 'VI-latn-VN', 'vi_VN']) {
		assert.equal(isVietnameseLanguage(lang), true, lang);
	}
	for (const lang of ['', 'en', 'x-vi', 'viet']) {
		assert.equal(isVietnameseLanguage(lang), false, lang);
	}
});

test('normalizes Vietnamese BCP-47 variants once and plans explicit pauses', async () => {
	for (const lang of ['vi', 'vi-VN']) {
		let calls = 0;
		const units = await preparePlaybackUnits('ĐH mở cửa.', lang, {
			async normalize() {
				calls++;
				return { text: 'đại học mở cửa.', diagnostics };
			},
		});
		assert.equal(calls, 1);
		assert.deepEqual(units, [{ text: 'đại học mở cửa.', pauseAfterMs: 165 }]);
	}
});

test('uses weighted units for Latin text despite missing or inaccurate language tags', async () => {
	let calls = 0;
	const normalizer = {
		async normalize() {
			calls++;
			throw new Error('must not run');
		},
	};
	for (const lang of ['en', 'na', 'zh', '']) {
		assert.deepEqual(await preparePlaybackUnits('First sentence. Second sentence.', lang, normalizer), [
			{ text: 'First sentence. Second sentence.', pauseAfterMs: 165 },
		]);
	}
	assert.equal(calls, 0);
});

test('uses weighted units for accented Latin languages', async () => {
	for (const [lang, text] of [
		['fr', 'Déjà vu. Très bien.'],
		['de', 'Größere Übung. Alles gut.'],
		['es', 'Corazón español. Muy bien.'],
		['pl', 'Zażółć gęślą jaźń. Dobrze.'],
	] as const) {
		assert.deepEqual(await preparePlaybackUnits(text, lang, null), [{ text, pauseAfterMs: 165 }]);
	}
});

test('keeps non-Latin and exact-half text on engine-managed compatibility pauses', async () => {
	for (const text of ['中文内容。', 'Русский текст.', 'نص عربي.', 'ab中文', '123 😀 !!!']) {
		assert.deepEqual(await preparePlaybackUnits(text, 'unknown', null), [{ text, pauseAfterMs: null }]);
	}
});

test('fails open to explicit units from the exact original Vietnamese text', async () => {
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
			return { text, diagnostics };
		},
	};
	assert.deepEqual(await preparePlaybackUnits(text, 'vi', normalizer), await preparePlaybackUnits(text, 'vi', normalizer));
});

test('does not return empty units when normalization yields whitespace', async () => {
	const units = await preparePlaybackUnits('Vẫn phải đọc.', 'vi', {
		async normalize() {
			return { text: ' \n\n ', diagnostics };
		},
	});
	assert.deepEqual(units, [{ text: 'Vẫn phải đọc.', pauseAfterMs: 165 }]);
});
