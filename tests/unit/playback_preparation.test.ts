import assert from 'node:assert/strict';
import test from 'node:test';
import { isVietnameseLanguage, preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

const diagnostics = {
	tokenCount: 3,
	crfMs: 0,
	expansionMs: 0,
	totalMs: 0,
	usedCrf: true,
	usedAbbreviationScorer: false,
};

function withoutWordMap(units: SpeechUnit[]) {
	return units.map(({ wordMap: _wordMap, ...rest }) => rest);
}

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
				return { text: 'đại học mở cửa.', wordMap: [], diagnostics };
			},
		});
		assert.equal(calls, 1);
		assert.deepEqual(withoutWordMap(units), [{ text: 'đại học mở cửa.', pauseAfterMs: 180 }]);
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
		assert.deepEqual(withoutWordMap(await preparePlaybackUnits('First sentence. Second sentence.', lang, normalizer)), [
			{ text: 'First sentence. Second sentence.', pauseAfterMs: 180 },
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
		assert.deepEqual(withoutWordMap(await preparePlaybackUnits(text, lang, null)), [{ text, pauseAfterMs: 180 }]);
	}
});

test('keeps non-Latin and exact-half text on engine-managed compatibility pauses', async () => {
	for (const text of ['中文内容。', 'Русский текст.', 'نص عربي.', 'ab中文', '123 😀 !!!']) {
		assert.deepEqual(withoutWordMap(await preparePlaybackUnits(text, 'unknown', null)), [{ text, pauseAfterMs: null }]);
	}
});

test('fails open to explicit units from the exact original Vietnamese text', async () => {
	const units = await preparePlaybackUnits('Một câu, vẫn đọc được.', 'vi', {
		async normalize() {
			throw new Error('expected failure');
		},
	});
	assert.deepEqual(withoutWordMap(units), [{ text: 'Một câu, vẫn đọc được.', pauseAfterMs: 180 }]);
});

test('returns identical units for identical selected and article text', async () => {
	const text = 'Nội dung giống nhau.';
	const normalizer = {
		async normalize() {
			return { text, wordMap: [], diagnostics };
		},
	};
	assert.deepEqual(
		withoutWordMap(await preparePlaybackUnits(text, 'vi', normalizer)),
		withoutWordMap(await preparePlaybackUnits(text, 'vi', normalizer)),
	);
});

test('does not return empty units when normalization yields whitespace', async () => {
	const units = await preparePlaybackUnits('Vẫn phải đọc.', 'vi', {
		async normalize() {
			return { text: ' \n\n ', wordMap: [], diagnostics };
		},
	});
	assert.deepEqual(withoutWordMap(units), [{ text: 'Vẫn phải đọc.', pauseAfterMs: 180 }]);
});

test('attaches a word map for both normalized Vietnamese text and plain Latin text', async () => {
	const spokenDate = 'mười một tháng bảy năm hai nghìn không trăm hai mươi sáu';
	const text = `Có ${spokenDate}.`;
	const viUnits = await preparePlaybackUnits('Có 11/07/2026.', 'vi', {
		async normalize() {
			return {
				text,
				wordMap: [
					{ originalText: 'Có', originalStart: 0, originalEnd: 2, spokenStart: 0, spokenEnd: 2 },
					{ originalText: '11/07/2026', originalStart: 3, originalEnd: 13, spokenStart: 3, spokenEnd: 3 + spokenDate.length },
				],
				diagnostics,
			};
		},
	});
	assert.deepEqual(
		viUnits[0].wordMap?.map(({ text: word }) => word),
		['Có', '11/07/2026'],
	);

	const latinUnits = await preparePlaybackUnits('First sentence.', 'en', null);
	assert.deepEqual(
		latinUnits[0].wordMap?.map(({ text: word }) => word),
		['First', 'sentence.'],
	);
});


test('consolidates bare Latin, Vietnamese, fallback, and compatibility units before attaching word maps', async () => {
	const latinBody = 'The paragraph continues with enough content to be independently reliable.';
	const [latin] = await preparePlaybackUnits(`Heading\n\n${latinBody}`, 'en', null);
	assert.deepEqual(withoutWordMap([latin]), [
		{
			text: `Heading ${latinBody}`,
			synthesisText: `Heading. ${latinBody}`,
			pauseAfterMs: 180,
		},
	]);
	assert.deepEqual(
		latin.wordMap?.map((entry) => latin.text.slice(entry.start, entry.end)),
		`Heading ${latinBody}`.split(' '),
	);

	const vietnameseHeading = 'Đề mục';
	const vietnameseBody = 'Nội dung đã chuẩn hóa tiếp tục đủ dài để giữ ánh xạ theo thứ tự.';
	const vietnameseSpoken = `${vietnameseHeading}\n\n${vietnameseBody}`;
	const [normalized] = await preparePlaybackUnits('Nguồn gốc', 'vi', {
		async normalize() {
			return {
				text: vietnameseSpoken,
				wordMap: [
					{ originalText: vietnameseHeading, originalStart: 0, originalEnd: 6, spokenStart: 0, spokenEnd: vietnameseHeading.length },
					{
						originalText: vietnameseBody,
						originalStart: 7,
						originalEnd: 7 + vietnameseBody.length,
						spokenStart: vietnameseHeading.length + 2,
						spokenEnd: vietnameseSpoken.length,
					},
				],
				diagnostics,
			};
		},
	});
	assert.deepEqual(withoutWordMap([normalized]), [
		{
			text: `${vietnameseHeading} ${vietnameseBody}`,
			synthesisText: `${vietnameseHeading}. ${vietnameseBody}`,
			pauseAfterMs: 180,
		},
	]);
	assert.deepEqual(normalized.wordMap, [
		{ text: vietnameseHeading, start: 0, end: vietnameseHeading.length },
		{
			text: vietnameseBody,
			start: vietnameseHeading.length + 1,
			end: vietnameseHeading.length + 1 + vietnameseBody.length,
		},
	]);

	const fallbackBody = 'Nội dung dự phòng tiếp tục đủ dài để giữ ánh xạ theo thứ tự.';
	const [fallback] = await preparePlaybackUnits(`Tiêu đề\n\n${fallbackBody}`, 'vi', {
		async normalize() {
			throw new Error('expected fallback');
		},
	});
	assert.deepEqual(withoutWordMap([fallback]), [
		{
			text: `Tiêu đề ${fallbackBody}`,
			synthesisText: `Tiêu đề. ${fallbackBody}`,
			pauseAfterMs: 180,
		},
	]);
	assert.deepEqual(
		fallback.wordMap?.map((entry) => fallback.text.slice(entry.start, entry.end)),
		`Tiêu đề ${fallbackBody}`.split(' '),
	);

	const compatibilityBody = '兼容路径保留足够的字符以便稳定合成并保持原有顺序。';
	const [compatibility] = await preparePlaybackUnits(`标题\n\n${compatibilityBody}`, 'zh', null);
	assert.deepEqual(withoutWordMap([compatibility]), [
		{
			text: `标题 ${compatibilityBody}`,
			synthesisText: `标题. ${compatibilityBody}`,
			pauseAfterMs: null,
		},
	]);
	assert.deepEqual(
		compatibility.wordMap?.map((entry) => compatibility.text.slice(entry.start, entry.end)),
		['标题', compatibilityBody],
	);
});
