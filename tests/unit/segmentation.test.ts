import assert from 'node:assert/strict';
import test from 'node:test';
import { type BoundaryCandidate, planTextSegments, SegmentationCapacityError } from '../../src/offscreen/segmentation.ts';

type Kind = 'sentence' | 'semicolon' | 'colon' | 'spacedDash' | 'comma' | 'whitespace';

const HARD_MAX = 300;

function boundary(text: string, marker: string, kind: Kind, pauseAfterMs: number): BoundaryCandidate<Kind> {
	return { end: text.indexOf(marker) + marker.length, kind, pauseAfterMs };
}

test('plans one unit per complete sentence instead of filling up to capacity', () => {
	const source = 'Một câu ngắn. Câu thứ hai cũng ngắn.';
	const boundaries = [boundary(source, '.', 'sentence', 180), { end: source.length, kind: 'sentence' as const, pauseAfterMs: 180 }];

	assert.deepEqual(planTextSegments(source, boundaries, HARD_MAX, 165), [
		{ text: 'Một câu ngắn.', pauseAfterMs: 180 },
		{ text: 'Câu thứ hai cũng ngắn.', pauseAfterMs: 180 },
	]);
});

test('keeps fitting semicolon and comma clauses inside their sentence', () => {
	const source = `${'a '.repeat(30).trim()}; ${'b '.repeat(20).trim()}, ${'c '.repeat(20).trim()}.`;
	const boundaries = [
		boundary(source, ';', 'semicolon', 140),
		boundary(source, ',', 'comma', 60),
		{ end: source.length, kind: 'sentence' as const, pauseAfterMs: 180 },
	];

	assert.deepEqual(planTextSegments(source, boundaries, HARD_MAX, 180), [{ text: source, pauseAfterMs: 180 }]);
});

test('replaces the last unit pause with the paragraph pause', () => {
	const source = 'First sentence. Second sentence.';
	const boundaries = [boundary(source, '.', 'sentence', 180), { end: source.length, kind: 'sentence' as const, pauseAfterMs: 180 }];

	assert.deepEqual(planTextSegments(source, boundaries, HARD_MAX, 260), [
		{ text: 'First sentence.', pauseAfterMs: 180 },
		{ text: 'Second sentence.', pauseAfterMs: 260 },
	]);
});

test('gives a paragraph without terminal punctuation the paragraph pause', () => {
	assert.deepEqual(planTextSegments('A bare heading', [], HARD_MAX, 260), [{ text: 'A bare heading', pauseAfterMs: 260 }]);
});

test('uses the ordered fallback only for an oversized sentence', () => {
	const part1 = 'word '.repeat(35).trim();
	const part2 = 'clause '.repeat(25).trim();
	const source = `${part1}; ${part2}.`;
	const boundaries = [
		{ end: part1.length + 1, kind: 'semicolon' as const, pauseAfterMs: 140 },
		{ end: source.length, kind: 'sentence' as const, pauseAfterMs: 180 },
	];

	const units = planTextSegments(source, boundaries, HARD_MAX, 180);
	assert.equal(units[0].text.endsWith(';'), true);
	assert.ok(units.every((unit) => unit.text.length <= HARD_MAX));
});

test('prefers the rightmost candidate of the first non-empty fallback class', () => {
	const filler = 'w'.repeat(90);
	const source = `${filler}, ${filler}: ${filler}, ${filler}.`;
	const boundaries: BoundaryCandidate<Kind>[] = [
		{ end: filler.length + 1, kind: 'comma', pauseAfterMs: 60 },
		{ end: filler.length * 2 + 3, kind: 'colon', pauseAfterMs: 90 },
		{ end: filler.length * 3 + 5, kind: 'comma', pauseAfterMs: 60 },
		{ end: source.length, kind: 'sentence', pauseAfterMs: 180 },
	];

	// The colon outranks both commas even though a comma sits further right within capacity.
	const units = planTextSegments(source, boundaries, HARD_MAX, 180);
	assert.equal(units[0].text.endsWith(':'), true);
});

test('uses the final safe whitespace when no fallback punctuation fits', () => {
	const left = 'a'.repeat(200);
	const right = 'b'.repeat(150);
	const source = `${left} ${right}`;
	const boundaries = [{ end: left.length, kind: 'whitespace' as const, pauseAfterMs: 0 }];

	assert.deepEqual(planTextSegments(source, boundaries, HARD_MAX, 0), [
		{ text: left, pauseAfterMs: 0 },
		{ text: right, pauseAfterMs: 0 },
	]);
});

test('rejects an oversized unbreakable token instead of splitting it', () => {
	assert.throws(
		() => planTextSegments('a'.repeat(301), [], HARD_MAX, 0),
		(error: unknown) => error instanceof SegmentationCapacityError,
	);
});
