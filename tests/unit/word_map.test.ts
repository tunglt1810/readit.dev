import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';
import { attachNormalizedWordMap, attachPlainWordMap, buildPlainWordMap } from '../../src/offscreen/word_map.ts';

test('builds a plain word map by splitting on whitespace runs', () => {
	assert.deepEqual(buildPlainWordMap('Hello, world!'), [
		{ text: 'Hello,', start: 0, end: 6 },
		{ text: 'world!', start: 7, end: 13 },
	]);
});

test('attaches a plain word map to each unit using the unit own text', () => {
	const units = [
		{ text: 'First sentence.', pauseAfterMs: 180 },
		{ text: 'Second one.', pauseAfterMs: null },
	];
	const attached = attachPlainWordMap(units);
	assert.deepEqual(attached[0].wordMap, [
		{ text: 'First', start: 0, end: 5 },
		{ text: 'sentence.', start: 6, end: 15 },
	]);
	assert.deepEqual(attached[1].wordMap, [
		{ text: 'Second', start: 0, end: 6 },
		{ text: 'one.', start: 7, end: 11 },
	]);
});

test('indexes canonical text, never the cadence-preserving synthesis rendering', () => {
	const [attached] = attachPlainWordMap([
		{ text: 'Heading The article continues.', synthesisText: 'Heading. The article continues.', pauseAfterMs: 260 },
	]);

	assert.deepEqual(attached.wordMap, [
		{ text: 'Heading', start: 0, end: 7 },
		{ text: 'The', start: 8, end: 11 },
		{ text: 'article', start: 12, end: 19 },
		{ text: 'continues.', start: 20, end: 30 },
	]);
	// The synthetic period exists only in the rendering, so nothing may map to it.
	assert.equal(
		(attached.wordMap ?? []).some((entry) => entry.text === 'Heading.'),
		false,
	);
	for (const entry of attached.wordMap ?? []) {
		assert.equal(attached.text.slice(entry.start, entry.end), entry.text);
	}
});

test('attaches word maps only after consolidation, so every entry resolves against the merged unit', async () => {
	const prepared = await preparePlaybackUnits(
		'Heading\n\nThe paragraph continues with enough content to be independently reliable.',
		'en',
		null,
	);

	// The short heading fuses into the paragraph, so a map attached before consolidation would now
	// be pointing at text that no longer exists as its own unit.
	assert.equal(prepared.length, 1);
	assert.equal(prepared[0].text.startsWith('Heading The paragraph'), true);
	for (const entry of prepared[0].wordMap ?? []) {
		assert.equal(prepared[0].text.slice(entry.start, entry.end), entry.text);
	}
	assert.deepEqual(
		(prepared[0].wordMap ?? []).map((entry) => entry.text),
		prepared[0].text.split(' '),
	);
});

test('resolves a merged unit whose canonical join replaced a paragraph break in the spoken text', () => {
	const fullText = 'Tiêu đề\n\nNội dung đoạn văn.';
	const units = [{ text: 'Tiêu đề Nội dung đoạn văn.', pauseAfterMs: 180 }];
	const wordMap = [
		{ originalText: 'Tiêu', originalStart: 0, originalEnd: 4, spokenStart: 0, spokenEnd: 4 },
		{ originalText: 'Nội', originalStart: 9, originalEnd: 12, spokenStart: 9, spokenEnd: 12 },
	];
	const [attached] = attachNormalizedWordMap(units, fullText, wordMap);

	assert.deepEqual(attached.wordMap, [
		{ text: 'Tiêu', start: 0, end: 4 },
		{ text: 'Nội', start: 8, end: 11 },
	]);
	assert.equal(attached.text.slice(8, 11), 'Nội');
});

test('slices a document-level word map into unit-relative offsets in order', () => {
	const fullText = 'mot hai ba.';
	const units = [{ text: fullText, pauseAfterMs: 180 }];
	const wordMap = [
		{ originalText: '1', originalStart: 0, originalEnd: 1, spokenStart: 0, spokenEnd: 3 },
		{ originalText: 'hai', originalStart: 2, originalEnd: 5, spokenStart: 4, spokenEnd: 7 },
		{ originalText: 'ba', originalStart: 6, originalEnd: 8, spokenStart: 8, spokenEnd: 10 },
	];
	const attached = attachNormalizedWordMap(units, fullText, wordMap);
	assert.deepEqual(attached[0].wordMap, [
		{ text: '1', start: 0, end: 3 },
		{ text: 'hai', start: 4, end: 7 },
		{ text: 'ba', start: 8, end: 10 },
	]);
});

test('advances the search cursor across multiple units instead of rematching from the start', () => {
	const fullText = 'foo bar foo';
	const units = [
		{ text: 'foo', pauseAfterMs: 60 },
		{ text: 'bar', pauseAfterMs: 40 },
		{ text: 'foo', pauseAfterMs: null },
	];
	const wordMap = [
		{ originalText: 'first', originalStart: 0, originalEnd: 1, spokenStart: 0, spokenEnd: 3 },
		{ originalText: 'second', originalStart: 2, originalEnd: 3, spokenStart: 4, spokenEnd: 7 },
		{ originalText: 'third', originalStart: 4, originalEnd: 5, spokenStart: 8, spokenEnd: 11 },
	];
	const attached = attachNormalizedWordMap(units, fullText, wordMap);
	assert.deepEqual(attached[0].wordMap, [{ text: 'first', start: 0, end: 3 }]);
	assert.deepEqual(attached[1].wordMap, [{ text: 'second', start: 0, end: 3 }]);
	assert.deepEqual(attached[2].wordMap, [{ text: 'third', start: 0, end: 3 }]);
});

test('returns an empty word map for a unit that cannot be located in the full text', () => {
	const attached = attachNormalizedWordMap([{ text: 'missing unit', pauseAfterMs: null }], 'completely different text', []);
	assert.deepEqual(attached[0].wordMap, []);
});

test('locates a unit whose text has a collapsed space standing in for a non-breaking space in the full text', () => {
	// planLatinSpeechUnits() collapses every whitespace run in a paragraph to a single regular
	// space when it builds unit.text (see latin/speech_units.ts), but fullSpokenText here is the
	// UNCOLLAPSED normalizer output. A non-breaking space between a number and its unit (e.g.
	// "20 km", common in real Vietnamese article text) survives into fullSpokenText verbatim
	// — a literal indexOf search for the collapsed unit.text would never find it, silently dropping
	// the whole unit's word map (and with it, every highlight event for that unit's DOM text).
	const fullText = 'so 20 km day';
	const units = [{ text: 'so 20 km day', pauseAfterMs: null }];
	const wordMap = [{ originalText: '20 km', originalStart: 3, originalEnd: 8, spokenStart: 3, spokenEnd: 8 }];
	const attached = attachNormalizedWordMap(units, fullText, wordMap);
	assert.deepEqual(attached[0].wordMap, [{ text: '20 km', start: 3, end: 8 }]);
});
