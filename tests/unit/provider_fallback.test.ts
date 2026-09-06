import assert from 'node:assert/strict';
import test from 'node:test';
import { replanRemainingUnits } from '../../src/offscreen/playback_preparation.ts';

const units = [
	{ text: 'Đã đọc xong câu này.', pauseAfterMs: 0 },
	{ text: 'Ngày 20/05 có sự kiện.', pauseAfterMs: 0 },
	{ text: 'Giá là 15%.', pauseAfterMs: 0 },
];

const normalizer = {
	async normalize(text: string) {
		const normalized = text.replaceAll('20/05', 'hai mươi tháng năm').replaceAll('15%', 'mười lăm phần trăm');
		return { text: normalized, wordMap: [] };
	},
};

const spoken = (replanned: readonly { text: string; synthesisText?: string }[]) =>
	replanned.map((unit) => unit.synthesisText ?? unit.text).join(' ');

test('re-plans only the units after the one still playing', async () => {
	const replanned = await replanRemainingUnits(units, 0, 'vi', normalizer, []);
	assert.match(spoken(replanned), /hai mươi tháng năm/u);
	assert.doesNotMatch(spoken(replanned), /Đã đọc xong câu này/u);
});

test('runs the normalizer so numbers and dates are spoken correctly', async () => {
	const replanned = await replanRemainingUnits(units, 1, 'vi', normalizer, []);
	assert.match(spoken(replanned), /mười lăm phần trăm/u);
	assert.doesNotMatch(spoken(replanned), /15%/u);
});

test('returns an empty list when the last unit is already playing', async () => {
	assert.deepEqual(await replanRemainingUnits(units, 2, 'vi', normalizer, []), []);
});

test('returns an empty list when the index is past the end', async () => {
	assert.deepEqual(await replanRemainingUnits(units, 9, 'vi', normalizer, []), []);
});

test('keeps non-Vietnamese content unchanged in text', async () => {
	const english = [
		{ text: 'First sentence.', pauseAfterMs: 0 },
		{ text: 'Second sentence.', pauseAfterMs: 0 },
	];
	const replanned = await replanRemainingUnits(english, 0, 'en', null, []);
	assert.match(spoken(replanned), /Second sentence/u);
	assert.doesNotMatch(spoken(replanned), /First sentence/u);
});

test('still applies the pronunciation dictionary to the replanned tail', async () => {
	const replanned = await replanRemainingUnits(
		[
			{ text: 'Intro.', pauseAfterMs: 0 },
			{ text: 'We ship on AWS today.', pauseAfterMs: 0 },
		],
		0,
		'en',
		null,
		[{ id: '1', match: 'AWS', replacement: 'ây đắp bờ liu ét', enabled: true, caseSensitive: false, wholeWord: true, createdAt: 0 }],
	);
	assert.match(spoken(replanned), /ây đắp bờ liu ét/u);
});
