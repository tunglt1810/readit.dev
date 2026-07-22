import assert from 'node:assert/strict';
import test from 'node:test';
import { computeWordTimings, findWordAtTime, predictSpokenWordDurations } from '../../src/offscreen/word_timing.ts';

test('allocates duration proportionally to each word length', () => {
	const wordMap = [
		{ text: 'a', start: 0, end: 1 },
		{ text: 'bb', start: 2, end: 4 },
		{ text: 'ccc', start: 5, end: 8 },
	];
	const windows = computeWordTimings(wordMap, 6);
	assert.deepEqual(windows, [
		{ text: 'a', wordIndex: 0, startSec: 0, endSec: 1 },
		{ text: 'bb', wordIndex: 1, startSec: 1, endSec: 3 },
		{ text: 'ccc', wordIndex: 2, startSec: 3, endSec: 6 },
	]);
});

test('weighs plain words by syllable count (vowel clusters) rather than raw character count', () => {
	// 'đi' and 'nghiêng' are both single Vietnamese syllables despite very different character
	// counts (diacritics/consonant clusters add letters, not speaking time) — they should get
	// equal time, not a 2:7 split by character length.
	const wordMap = [
		{ text: 'đi', start: 0, end: 2 },
		{ text: 'nghiêng', start: 3, end: 10 },
	];
	const windows = computeWordTimings(wordMap, 2);
	assert.deepEqual(windows, [
		{ text: 'đi', wordIndex: 0, startSec: 0, endSec: 1 },
		{ text: 'nghiêng', wordIndex: 1, startSec: 1, endSec: 2 },
	]);
});

test('falls back to spoken-span length when the original text is not what was actually spoken (e.g. expanded numbers/dates)', () => {
	// When start/end span a normalized expansion (original "20/05" read out as a much longer
	// phrase), entry.text is the short original page text, not the spoken text — its own
	// syllable count has no bearing on how long the expansion took to say. The spoken span
	// length is the best duration proxy available in that case.
	const wordMap = [
		{ text: 'hi', start: 0, end: 2 },
		{ text: '20/05', start: 2, end: 22 },
	];
	const windows = computeWordTimings(wordMap, 21);
	assert.deepEqual(windows, [
		{ text: 'hi', wordIndex: 0, startSec: 0, endSec: 1 },
		{ text: '20/05', wordIndex: 1, startSec: 1, endSec: 21 },
	]);
});

test('returns an empty list when there is no spoken duration or no words', () => {
	assert.deepEqual(computeWordTimings([], 5), []);
	assert.deepEqual(computeWordTimings([{ text: 'x', start: 0, end: 1 }], 0), []);
});

test('scales model-predicted durations to the decoded spoken duration', () => {
	const wordMap = [
		{ text: 'short', start: 0, end: 5 },
		{ text: 'long', start: 6, end: 10 },
	];
	assert.deepEqual(computeWordTimings(wordMap, 6, [1, 2]), [
		{ text: 'short', wordIndex: 0, startSec: 0, endSec: 2 },
		{ text: 'long', wordIndex: 1, startSec: 2, endSec: 6 },
	]);
});

test('falls back to heuristic weights when model durations are invalid', () => {
	const wordMap = [
		{ text: 'a', start: 0, end: 1 },
		{ text: 'bb', start: 2, end: 4 },
	];
	assert.deepEqual(computeWordTimings(wordMap, 3, [1, Number.NaN]), computeWordTimings(wordMap, 3));
	assert.deepEqual(computeWordTimings(wordMap, 3, [1]), computeWordTimings(wordMap, 3));
	assert.deepEqual(computeWordTimings(wordMap, 3, [1, 0]), computeWordTimings(wordMap, 3));
});

test('predicts cumulative contextual prefixes for the reported Markdown and mixed-language text', async () => {
	const text =
		'**Channel Activity Analysis (4.6.6):** Phân tích hoạt động kênh để hỗ trợ phát triển quan hệ. **Ví dụ sử dụng trong tài liệu khớp hoàn toàn với yêu cầu này**: Khách hàng đăng ký online thất bại/gián đoạn sẽ được ghi nhận để chuyển thông tin cho RM liên hệ hỗ trợ kịp thời';
	const wordMap = [
		{ text: 'Channel', start: 2, end: 9 },
		{ text: 'Activity', start: 10, end: 18 },
		{ text: 'Analysis', start: 19, end: 27 },
	];
	assert.deepEqual(
		await predictSpokenWordDurations(text, wordMap, async (prefixes) => {
			assert.deepEqual(prefixes, ['**Channel', '**Channel Activity', '**Channel Activity Analysis']);
			return [0.5, 1, 1.5];
		}),
		[0.5, 0.5, 0.5],
	);
	const windows = computeWordTimings(wordMap, 6, [0.5, 0.5, 0.5]);
	assert.equal(findWordAtTime(windows, 0.05)?.text, 'Channel');
});

test('keeps normalized expansions inside each cumulative prefix', async () => {
	const wordMap = [
		{ text: 'hi', start: 0, end: 2 },
		{ text: '20/05', start: 3, end: 26 },
	];
	assert.deepEqual(
		await predictSpokenWordDurations('hi ngày hai mươi tháng năm', wordMap, async (prefixes) => {
			assert.deepEqual(prefixes, ['hi', 'hi ngày hai mươi tháng năm']);
			return [0.25, 2];
		}),
		[0.25, 1.75],
	);
});

test('rejects invalid cumulative prefix totals and contains predictor failures', async () => {
	const wordMap = [
		{ text: 'hi', start: 0, end: 2 },
		{ text: '20/05', start: 3, end: 26 },
	];
	assert.equal(await predictSpokenWordDurations('hi ngày hai mươi tháng năm', wordMap, async () => [1]), undefined);
	assert.equal(await predictSpokenWordDurations('hi ngày hai mươi tháng năm', wordMap, async () => [Number.NaN, 2]), undefined);
	assert.equal(await predictSpokenWordDurations('hi ngày hai mươi tháng năm', wordMap, async () => [0, 2]), undefined);
	assert.equal(await predictSpokenWordDurations('hi ngày hai mươi tháng năm', wordMap, async () => [1, 1]), undefined);
	assert.equal(await predictSpokenWordDurations('hi ngày hai mươi tháng năm', wordMap, async () => [2, 1]), undefined);
	assert.equal(await predictSpokenWordDurations('hi', [{ text: 'empty', start: 0, end: 0 }], async () => [1]), undefined);
	assert.equal(
		await predictSpokenWordDurations('hi ngày hai mươi tháng năm', wordMap, async () => {
			throw new Error('duration model unavailable');
		}),
		undefined,
	);
});

test('finds the word whose window contains the elapsed time', () => {
	const windows = [
		{ text: 'a', wordIndex: 8, startSec: 0, endSec: 1 },
		{ text: 'bb', wordIndex: 9, startSec: 1, endSec: 3 },
		{ text: 'ccc', wordIndex: 10, startSec: 3, endSec: 6 },
	];
	assert.equal(findWordAtTime(windows, 0)?.text, 'a');
	assert.equal(findWordAtTime(windows, 0.5)?.wordIndex, 8);
	assert.equal(findWordAtTime(windows, 1)?.text, 'bb');
	assert.equal(findWordAtTime(windows, 2.9)?.wordIndex, 9);
	assert.equal(findWordAtTime(windows, 3)?.text, 'ccc');
});

test('clamps to the last word once elapsed time reaches the end, and returns null for an empty timeline', () => {
	const windows = [{ text: 'only', wordIndex: 4, startSec: 0, endSec: 2 }];
	assert.equal(findWordAtTime(windows, 10)?.wordIndex, 4);
	assert.equal(findWordAtTime([], 0), null);
});
