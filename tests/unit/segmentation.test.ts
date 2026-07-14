import assert from 'node:assert/strict';
import test from 'node:test';
import { type BoundaryCandidate, planTextSegments, type SegmentationPolicy } from '../../src/offscreen/segmentation.ts';

type Kind = 'sentence' | 'semicolon' | 'comma';

const policy: SegmentationPolicy<Kind> = {
	preferredMin: 140,
	preferredCenter: 190,
	preferredMax: 240,
	hardMax: 300,
	outsidePreferredPenalty: 10,
	shortRemainderLength: 80,
	shortRemainderPenalty: 30,
	minimumScore: 0,
	boundaryWeights: {
		sentence: 40,
		semicolon: 30,
		comma: 20,
	},
};

function boundary(text: string, marker: string, kind: Kind, pauseAfterMs: number): BoundaryCandidate<Kind> {
	return { end: text.indexOf(marker) + marker.length, kind, pauseAfterMs };
}

function assertSourceCoverage(source: string, units: readonly { text: string }[]): void {
	let cursor = 0;
	for (const unit of units) {
		assert.notEqual(unit.text, '');
		const start = source.indexOf(unit.text, cursor);
		assert.notEqual(start, -1);
		assert.match(source.slice(cursor, start), /^\s*$/u);
		cursor = start + unit.text.length;
	}
	assert.match(source.slice(cursor), /^\s*$/u);
}

function orphanSource(firstBoundaryEnd: number, secondBoundaryEnd: number, remainderLength: number): string {
	return `${'a'.repeat(firstBoundaryEnd - 1)}; ${'b'.repeat(secondBoundaryEnd - firstBoundaryEnd - 2)}. ${'c'.repeat(remainderLength)}`;
}

test('keeps a complete paragraph under the hard limit in one unit', () => {
	const source = 'Một câu ngắn. Câu thứ hai cũng ngắn.';
	const boundaries = [boundary(source, '.', 'sentence', 165), { end: source.length, kind: 'sentence' as const, pauseAfterMs: 165 }];

	assert.deepEqual(planTextSegments(source, boundaries, policy, 165), [{ text: source, pauseAfterMs: 165 }]);
});

test('lets a well-positioned comma beat a very short sentence boundary', () => {
	const source = `${'a '.repeat(30).trim()}. ${'b '.repeat(55).trim()}, ${'c '.repeat(100).trim()}`;
	const boundaries = [boundary(source, '.', 'sentence', 165), boundary(source, ',', 'comma', 60)];
	const units = planTextSegments(source, boundaries, policy, 0);

	assert.equal(units[0].text.endsWith(','), true);
	assert.ok(units[0].text.length >= policy.preferredMin);
	assert.ok(units[0].text.length <= policy.preferredMax);
});

test('applies the full configured penalty to a remainder below the short-orphan threshold', () => {
	const source = orphanSource(110, 222, 79);
	const boundaries = [boundary(source, ';', 'semicolon', 90), boundary(source, '.', 'sentence', 165)];

	assert.equal(planTextSegments(source, boundaries, policy, 0)[0].text.endsWith(';'), true);
});

test('does not apply the short-orphan penalty at the configured threshold', () => {
	const source = orphanSource(110, 222, 80);
	const boundaries = [boundary(source, ';', 'semicolon', 90), boundary(source, '.', 'sentence', 165)];

	assert.equal(planTextSegments(source, boundaries, policy, 0)[0].text.endsWith('.'), true);
});

test('does not apply more than the configured short-orphan penalty', () => {
	const source = orphanSource(105, 225, 79);
	const boundaries = [boundary(source, ';', 'semicolon', 90), boundary(source, '.', 'sentence', 165)];

	assert.equal(planTextSegments(source, boundaries, policy, 0)[0].text.endsWith('.'), true);
});

test('falls back to whitespace near the scoring center and preserves all text', () => {
	const source = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ');
	const units = planTextSegments(source, [], policy, 0);

	assert.ok(units[0].text.length >= 180 && units[0].text.length <= 200);
	assert.ok(units.every(({ text }) => text.length <= policy.hardMax));
	assertSourceCoverage(source, units);
});

test('moves a hard split before a UTF-16 surrogate pair', () => {
	const source = `${'a'.repeat(299)}😀${'b'.repeat(20)}`;
	const units = planTextSegments(source, [], policy, 0);

	assert.equal(units[0].text.length, 299);
	assertSourceCoverage(source, units);
});
