import assert from 'node:assert/strict';
import test from 'node:test';
import { alignWordBoundaries } from '../../src/offscreen/edge/word_boundary_alignment.ts';

const wordMap = (...words: string[]) => {
	let cursor = 0;
	return words.map((text) => {
		const entry = { text, start: cursor, end: cursor + text.length };
		cursor = entry.end + 1;
		return entry;
	});
};

test('maps one boundary per word straight through', () => {
	const windows = alignWordBoundaries(wordMap('Testing', 'word'), [
		{ offsetMs: 100, durationMs: 475, text: 'Testing' },
		{ offsetMs: 587.5, durationMs: 237.5, text: 'word' },
	]);
	assert.deepEqual(windows, [
		{ text: 'Testing', wordIndex: 0, startSec: 0.1, endSec: 0.575 },
		{ text: 'word', wordIndex: 1, startSec: 0.5875, endSec: 0.825 },
	]);
});

test('groups several boundaries into one word-map entry', () => {
	const windows = alignWordBoundaries(wordMap('20/05', 'xong'), [
		{ offsetMs: 0, durationMs: 200, text: 'hai' },
		{ offsetMs: 200, durationMs: 200, text: 'mươi' },
		{ offsetMs: 400, durationMs: 100, text: '05' },
		{ offsetMs: 500, durationMs: 100, text: 'xong' },
	]);
	assert.equal(windows, null, 'spoken expansions do not share letters with the source text');
});

test('groups boundaries that do reconcile letter for letter', () => {
	const windows = alignWordBoundaries(wordMap('hai mươi', 'xong'), [
		{ offsetMs: 0, durationMs: 200, text: 'hai' },
		{ offsetMs: 200, durationMs: 200, text: 'mươi' },
		{ offsetMs: 400, durationMs: 100, text: 'xong' },
	]);
	assert.equal(windows?.length, 2);
	assert.equal(windows?.[0].wordIndex, 0);
	assert.equal(windows?.[0].startSec, 0);
	assert.equal(windows?.[0].endSec, 0.4);
	assert.equal(windows?.[1].text, 'xong');
});

test('ignores punctuation and case differences when matching', () => {
	const windows = alignWordBoundaries(wordMap('"Hello,"', 'world!'), [
		{ offsetMs: 0, durationMs: 100, text: 'hello' },
		{ offsetMs: 100, durationMs: 100, text: 'world' },
	]);
	assert.equal(windows?.length, 2);
});

test('returns null when the sequences cannot be aligned', () => {
	assert.equal(alignWordBoundaries(wordMap('alpha', 'beta'), [{ offsetMs: 0, durationMs: 100, text: 'gamma' }]), null);
});

test('returns null when boundaries run out early', () => {
	assert.equal(alignWordBoundaries(wordMap('alpha', 'beta'), [{ offsetMs: 0, durationMs: 100, text: 'alpha' }]), null);
});

test('returns null when boundaries outlast the word map', () => {
	assert.equal(
		alignWordBoundaries(wordMap('alpha'), [
			{ offsetMs: 0, durationMs: 100, text: 'alpha' },
			{ offsetMs: 100, durationMs: 100, text: 'beta' },
		]),
		null,
	);
});

test('returns null for empty inputs rather than an empty timeline', () => {
	assert.equal(alignWordBoundaries([], [{ offsetMs: 0, durationMs: 1, text: 'x' }]), null);
	assert.equal(alignWordBoundaries(wordMap('alpha'), []), null);
});
