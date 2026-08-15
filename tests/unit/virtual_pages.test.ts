import assert from 'node:assert/strict';
import test from 'node:test';
import { computeVirtualPageStarts } from '../../src/shared/virtual_pages.ts';

/** Paragraphs of a known length, so expected offsets can be computed by hand. */
function paragraphs(count: number, length: number): string {
	return Array.from({ length: count }, (_, index) => `${index}`.padEnd(length, 'x')).join('\n\n');
}

test('text shorter than one page is a single page', () => {
	assert.deepEqual(computeVirtualPageStarts('One short paragraph.', 1800), [0]);
});

test('empty text is still one page', () => {
	assert.deepEqual(computeVirtualPageStarts('', 1800), [0]);
});

test('pages break at paragraph boundaries once the target is reached', () => {
	// Four 100-character paragraphs joined by "\n\n": each block costs 102 characters. With a
	// 150-character target, two paragraphs fill a page — one is short of the target, three overshoot it.
	const text = paragraphs(4, 100);
	assert.deepEqual(computeVirtualPageStarts(text, 150), [0, 204]);
});

test('every start lands on the first character of a paragraph', () => {
	const text = paragraphs(20, 90);
	for (const start of computeVirtualPageStarts(text, 200)) {
		assert.equal(start === 0 || text.slice(start - 2, start) === '\n\n', true, `bad start ${start}`);
	}
});

test('starts are strictly increasing', () => {
	const starts = computeVirtualPageStarts(paragraphs(30, 70), 300);
	for (let index = 1; index < starts.length; index++) {
		assert.equal(starts[index] > starts[index - 1], true);
	}
});

test('a paragraph longer than the target is not split', () => {
	const text = `${'a'.repeat(5000)}\n\nshort tail`;
	assert.deepEqual(computeVirtualPageStarts(text, 1800), [0, 5002]);
});

test('pagination is deterministic', () => {
	const text = paragraphs(25, 80);
	assert.deepEqual(computeVirtualPageStarts(text, 500), computeVirtualPageStarts(text, 500));
});
