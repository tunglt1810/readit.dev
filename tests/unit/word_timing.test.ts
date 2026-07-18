import assert from 'node:assert/strict';
import test from 'node:test';
import { computeWordTimings, findWordAtTime } from '../../src/offscreen/word_timing.ts';

test('allocates duration proportionally to each word length', () => {
	const wordMap = [
		{ text: 'a', start: 0, end: 1 },
		{ text: 'bb', start: 2, end: 4 },
		{ text: 'ccc', start: 5, end: 8 },
	];
	const windows = computeWordTimings(wordMap, 6);
	assert.deepEqual(windows, [
		{ text: 'a', startSec: 0, endSec: 1 },
		{ text: 'bb', startSec: 1, endSec: 3 },
		{ text: 'ccc', startSec: 3, endSec: 6 },
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
		{ text: 'đi', startSec: 0, endSec: 1 },
		{ text: 'nghiêng', startSec: 1, endSec: 2 },
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
		{ text: 'hi', startSec: 0, endSec: 1 },
		{ text: '20/05', startSec: 1, endSec: 21 },
	]);
});

test('returns an empty list when there is no spoken duration or no words', () => {
	assert.deepEqual(computeWordTimings([], 5), []);
	assert.deepEqual(computeWordTimings([{ text: 'x', start: 0, end: 1 }], 0), []);
});

test('finds the word whose window contains the elapsed time', () => {
	const windows = [
		{ text: 'a', startSec: 0, endSec: 1 },
		{ text: 'bb', startSec: 1, endSec: 3 },
		{ text: 'ccc', startSec: 3, endSec: 6 },
	];
	assert.equal(findWordAtTime(windows, 0), 'a');
	assert.equal(findWordAtTime(windows, 0.5), 'a');
	assert.equal(findWordAtTime(windows, 1), 'bb');
	assert.equal(findWordAtTime(windows, 2.9), 'bb');
	assert.equal(findWordAtTime(windows, 3), 'ccc');
});

test('clamps to the last word once elapsed time reaches the end, and returns null for an empty timeline', () => {
	const windows = [{ text: 'only', startSec: 0, endSec: 2 }];
	assert.equal(findWordAtTime(windows, 10), 'only');
	assert.equal(findWordAtTime([], 0), null);
});
