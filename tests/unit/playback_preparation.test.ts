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
	const latinUnits = await preparePlaybackUnits(`Heading\n\n${latinBody}`, 'en', null);
	assert.deepEqual(withoutWordMap(latinUnits), [
		{ text: 'Heading', pauseAfterMs: 260 },
		{ text: latinBody, pauseAfterMs: 180 },
	]);
	assert.deepEqual(
		latinUnits.flatMap((unit) => unit.wordMap?.map((entry) => unit.text.slice(entry.start, entry.end)) ?? []),
		`Heading ${latinBody}`.split(' '),
	);

	const vietnameseHeading = 'Đề mục';
	const vietnameseBody = 'Nội dung đã chuẩn hóa tiếp tục đủ dài để giữ ánh xạ theo thứ tự.';
	const vietnameseSpoken = `${vietnameseHeading}\n\n${vietnameseBody}`;
	const normalizedUnits = await preparePlaybackUnits('Nguồn gốc', 'vi', {
		async normalize() {
			return {
				text: vietnameseSpoken,
				wordMap: [
					{
						originalText: vietnameseHeading,
						originalStart: 0,
						originalEnd: 6,
						spokenStart: 0,
						spokenEnd: vietnameseHeading.length,
					},
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
	assert.deepEqual(withoutWordMap(normalizedUnits), [
		{ text: vietnameseHeading, pauseAfterMs: 260 },
		{ text: vietnameseBody, pauseAfterMs: 180 },
	]);
	assert.deepEqual(normalizedUnits[0].wordMap, [{ text: vietnameseHeading, start: 0, end: vietnameseHeading.length }]);
	assert.deepEqual(normalizedUnits[1].wordMap, [{ text: vietnameseBody, start: 0, end: vietnameseBody.length }]);

	const fallbackBody = 'Nội dung dự phòng tiếp tục đủ dài để giữ ánh xạ theo thứ tự.';
	const fallbackUnits = await preparePlaybackUnits(`Tiêu đề\n\n${fallbackBody}`, 'vi', {
		async normalize() {
			throw new Error('expected fallback');
		},
	});
	assert.deepEqual(withoutWordMap(fallbackUnits), [
		{ text: 'Tiêu đề', pauseAfterMs: 260 },
		{ text: fallbackBody, pauseAfterMs: 180 },
	]);
	assert.deepEqual(
		fallbackUnits.flatMap((unit) => unit.wordMap?.map((entry) => unit.text.slice(entry.start, entry.end)) ?? []),
		`Tiêu đề ${fallbackBody}`.split(' '),
	);

	const compatibilityBody = '兼容路径保留足够的字符以便稳定合成并保持原有顺序。';
	const [compatibility] = await preparePlaybackUnits(`标题\n\n${compatibilityBody}`, 'zh', null);
	assert.deepEqual(withoutWordMap([compatibility]), [
		{
			text: `标题 ${compatibilityBody}`,
			pauseAfterMs: null,
		},
	]);
	assert.deepEqual(
		compatibility.wordMap?.map((entry) => compatibility.text.slice(entry.start, entry.end)),
		['标题', compatibilityBody],
	);
});

test('consolidates short English lines into merged speech units with proper synthesisText punctuation', async () => {
	const text = `DATA STRATEGY\n\nData & Analytics Enablement for Business Growth\n\n1. Purpose\n\nThe Data Strategy provides the analytics.`;
	const units = await preparePlaybackUnits(text, 'en', null);
	assert.ok(units.length < 4, `Expected fewer than 4 units due to consolidation, got ${units.length}`);
	// The leading headline stays whole; the mid-document lines behind it still merge with synthetic
	// punctuation standing in for the paragraph boundaries they absorb.
	assert.equal(units[0].text, 'DATA STRATEGY');
	assert.ok(units[1].synthesisText?.includes('Business Growth. 1. Purpose'));
	// Verify "1. Purpose" is kept intact as one unit or merged without splitting "1."
	assert.ok(!units.some((u) => u.text === '1.' || u.text === '1'));

	const listText = `monitor performance across Personal, Private, Corporate and Intermediaries segments\n\ntrack deposit growth and funding mix\n\nmanage lending portfolio risk and profitability\n\nimprove RM productivity\n\nstrengthen AML lifecycle monitoring\n\nprovide consistent management reporting`;
	const listUnits = await preparePlaybackUnits(listText, 'en', null);
	assert.ok(listUnits.length <= 3, `Expected at most 3 units for list items, got ${listUnits.length}`);
	assert.equal(listUnits.map((unit) => unit.text).join(' '), listText.replace(/\s+/gu, ' ').trim());
	assert.ok(listUnits.every((unit) => (unit.synthesisText ?? unit.text).length <= 300));
});

test('keeps a leading headline as its own unit so its paragraph pause survives', async () => {
	const title = 'Mua giày ở Nha Trang gửi sang Nga mới phát hiện hàng giả';
	const sapo =
		'Khánh Hòa Một phụ nữ mua hai đôi giày Nike, Adidas tại cửa hàng ở Nha Trang với giá 1,3 triệu đồng, gửi sang Nga cho bạn trai thì được xác định là hàng giả.';
	const units = await preparePlaybackUnits(`${title}\n\n${sapo}`, 'vi', null);

	assert.equal(units[0].text, title);
	assert.equal(units[0].pauseAfterMs, 260);
	assert.equal(units[1].text, sapo);

	// A leading paragraph that already ends a sentence is ordinary prose, not a headline, so it
	// keeps merging exactly as before.
	const lead = 'Một câu dẫn ngắn.';
	const prose = await preparePlaybackUnits(`${lead}\n\n${sapo}`, 'vi', null);
	assert.equal(prose[0].text, `${lead} ${sapo}`);
});

test('merges short CJK units without injecting ASCII punctuation into null-pause compatibility paths', async () => {
	const first = '这是第一段，包含足够多的中文字符以避免短片段合并，并且以中文句号结束。';
	const second = '这是第二段，包含足够多的中文字符以避免短片段合并，并且也以中文句号结束。';
	const units = await preparePlaybackUnits(`${first}\n\n${second}`, 'zh', null);

	assert.deepEqual(withoutWordMap(units), [{ text: `${first} ${second}`, pauseAfterMs: null }]);
	assert.ok(units.every((unit) => !unit.synthesisText?.includes('。.')));
});
test('merges short Japanese units without treating null pauses as audible', async () => {
	const first = '最初の段落は十分に長く、短い断片として結合されるべきではありません！';
	const second = '次の段落も十分に長く、独立した文として保持されるべきです。';
	const units = await preparePlaybackUnits(`${first}\n\n${second}`, 'ja', null);

	assert.deepEqual(withoutWordMap(units), [{ text: `${first} ${second}`, pauseAfterMs: null }]);
	assert.ok(units.every((unit) => !unit.synthesisText?.includes('！.')));
});
