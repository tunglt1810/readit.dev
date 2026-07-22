import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceManualHighlight, createManualHighlightCursor } from '../../src/sidepanel/manual_word_highlight.ts';

test('maps repeated words monotonically instead of returning the first duplicate', () => {
	const cursor = createManualHighlightCursor('The cat saw the cat.');
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'cat', wordIndex: 1 }), {
		kind: 'matched',
		range: { start: 4, end: 7 },
	});
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'cat', wordIndex: 3 }), {
		kind: 'matched',
		range: { start: 16, end: 19 },
	});
});

test('matches NFC speech against NFD reader text without using incorrect source offsets', () => {
	const cursor = createManualHighlightCursor('Cafe\u0301 cafe\u0301');
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'café', wordIndex: 0 }), {
		kind: 'matched',
		range: { start: 0, end: 5 },
	});
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'café', wordIndex: 1 }), {
		kind: 'matched',
		range: { start: 6, end: 11 },
	});
});

test('matches complete multi-token source entries and avoids substrings inside other words', () => {
	const cursor = createManualHighlightCursor('candy can cost 1.000 USD today.');
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'can', wordIndex: 0 }), {
		kind: 'matched',
		range: { start: 6, end: 9 },
	});
	assert.deepEqual(advanceManualHighlight(cursor, { word: '1.000 USD', wordIndex: 1 }), {
		kind: 'matched',
		range: { start: 15, end: 24 },
	});
});

test('distinguishes a stale duplicate from an unmatched newer word', () => {
	const cursor = createManualHighlightCursor('One two');
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'One', wordIndex: 0 }), {
		kind: 'matched',
		range: { start: 0, end: 3 },
	});
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'One', wordIndex: 0 }), { kind: 'stale' });
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'Three', wordIndex: 2 }), { kind: 'unmatched' });
});
