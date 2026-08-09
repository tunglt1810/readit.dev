import assert from 'node:assert/strict';
import test from 'node:test';
import { consolidateShortSpeechUnits } from '../../src/offscreen/short_segment_consolidation.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

interface Range {
	start: number;
	end: number;
}

interface PartitionScore {
	mergeableShortCount: number;
	maximumMergedLength: number;
	endIndexes: number[];
	startIndexes: number[];
}

/**
 * How a generated source unit ends, which decides what a merge costs in rendering length:
 * a unit already carrying terminal punctuation only picks up the joining space, while an unpunctuated
 * unit with an audible pause also picks up the one cadence-preserving period R3.3 allows. An
 * unpunctuated unit with a `null` pause must pick up neither (R7.7).
 */
type UnitShape = 'terminal' | 'unpunctuatedAudible' | 'unpunctuatedSilent';

interface Generated {
	units: SpeechUnit[];
	/** Characters a single join adds on top of the two joined renderings. */
	joinOverhead: number;
}

function pseudoRandom(seed: number): () => number {
	let value = seed;
	return () => {
		value = (value * 9301 + 49297) % 233280;
		return value / 233280;
	};
}

function allPartitions(count: number): Range[][] {
	const partitions: Range[][] = [];
	function visit(start: number, ranges: Range[]): void {
		if (start === count) {
			partitions.push(ranges);
			return;
		}
		for (let end = start + 1; end <= count; end++) {
			visit(end, [...ranges, { start, end }]);
		}
	}
	visit(0, []);
	return partitions;
}

/** Trimmed non-whitespace code points, which is what R9.1 measures shortness in. */
function contentLength(range: Range, lengths: readonly number[]): number {
	return lengths.slice(range.start, range.end).reduce((total, length) => total + length, 0);
}

/** UTF-16 length of the Final Rendering, which is what R2 measures capacity in. */
function rangeLength(range: Range, lengths: readonly number[], joinOverhead: number): number {
	return contentLength(range, lengths) + (range.end - range.start - 1) * joinOverhead;
}

function isFeasible(range: Range, lengths: readonly number[], limit: number, joinOverhead: number): boolean {
	return rangeLength(range, lengths, joinOverhead) <= limit;
}

function partitionScore(partition: readonly Range[], lengths: readonly number[], limit: number, joinOverhead: number): PartitionScore {
	const mergeableShortCount = partition.reduce((count, range, index) => {
		const short = contentLength(range, lengths) < 50;
		const canMergePrevious =
			index > 0 && isFeasible({ start: partition[index - 1].start, end: range.end }, lengths, limit, joinOverhead);
		const canMergeNext =
			index < partition.length - 1 && isFeasible({ start: range.start, end: partition[index + 1].end }, lengths, limit, joinOverhead);
		return count + (short && (canMergePrevious || canMergeNext) ? 1 : 0);
	}, 0);
	const maximumMergedLength = Math.max(
		0,
		...partition.filter((range) => range.end - range.start > 1).map((range) => rangeLength(range, lengths, joinOverhead)),
	);
	return {
		mergeableShortCount,
		maximumMergedLength,
		endIndexes: partition.map((range) => range.end),
		startIndexes: partition.map((range) => range.start + 1),
	};
}

function compareVector(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		if (left[index] !== right[index]) {
			return left[index] - right[index];
		}
	}
	return left.length - right.length;
}

function compareScores(left: PartitionScore, right: PartitionScore): number {
	if (left.mergeableShortCount !== right.mergeableShortCount) {
		return left.mergeableShortCount - right.mergeableShortCount;
	}
	if (left.maximumMergedLength !== right.maximumMergedLength) {
		return left.maximumMergedLength - right.maximumMergedLength;
	}
	const endComparison = compareVector(left.endIndexes, right.endIndexes);
	return endComparison === 0 ? compareVector(left.startIndexes, right.startIndexes) : endComparison;
}

function sourceUnits(lengths: readonly number[], shape: UnitShape = 'terminal'): Generated {
	const units = lengths.map((length, index) => {
		const letters = String.fromCharCode(65 + index).repeat(shape === 'terminal' ? length - 1 : length);
		return {
			text: shape === 'terminal' ? `${letters}.` : letters,
			pauseAfterMs: shape === 'unpunctuatedSilent' ? null : 180,
		};
	});
	return { units, joinOverhead: shape === 'unpunctuatedAudible' ? 2 : 1 };
}

function outputRanges(units: readonly SpeechUnit[]): Range[] {
	return units.map((unit) => {
		const tokens = unit.text.split(' ');
		return {
			start: tokens[0].charCodeAt(0) - 65,
			end: tokens.at(-1)!.charCodeAt(0) - 64,
		};
	});
}

function expectedPartition(lengths: readonly number[], limit = 300, joinOverhead = 1): Range[] {
	return allPartitions(lengths.length)
		.filter((partition) => partition.every((range) => isFeasible(range, lengths, limit, joinOverhead)))
		.reduce<Range[] | null>((best, partition) => {
			return !best ||
				compareScores(partitionScore(partition, lengths, limit, joinOverhead), partitionScore(best, lengths, limit, joinOverhead)) <
					0
				? partition
				: best;
		}, null)!;
}

test('selects the required [1+2], [3+4] grouping', () => {
	const lengths = [25, 30, 25, 30];
	assert.deepEqual(outputRanges(consolidateShortSpeechUnits(sourceUnits(lengths).units, 'en')), [
		{ start: 0, end: 2 },
		{ start: 2, end: 4 },
	]);
});

test('retains open-run DP state for lexicographic global optimality', () => {
	const lengths = [10, 10, 40, 240, 40];
	assert.deepEqual(outputRanges(consolidateShortSpeechUnits(sourceUnits(lengths).units, 'en')), expectedPartition(lengths));
});

// The maximum rendering length among genuinely merged runs is a max, not a sum, so a prefix carrying
// a smaller running maximum is not necessarily part of the optimum: both prefixes can tie on the
// final maximum and then be separated by the end-index vector instead. Each of these was produced by
// fuzzing the optimizer against the exhaustive oracle, and each one broke a per-state "keep only the
// best prefix" pruning.
const MAX_LENGTH_TIE_REGRESSIONS = [
	[120, 10, 150, 120, 120, 45],
	[55, 10, 80, 150, 120, 200, 5],
	[49, 10, 30, 120, 250, 49, 250],
	[80, 5, 20, 200, 55, 250, 45],
	[30, 45, 49, 150, 250, 45, 200],
];

for (const lengths of MAX_LENGTH_TIE_REGRESSIONS) {
	test(`matches the oracle when genuinely merged runs tie on maximum length: ${JSON.stringify(lengths)}`, () => {
		assert.deepEqual(outputRanges(consolidateShortSpeechUnits(sourceUnits(lengths).units, 'en')), expectedPartition(lengths));
	});
}

// Lengths cluster around the 50-code-point shortness threshold and the 120/300 capacities, because
// that is where a partition's score actually changes.
const LATIN_LENGTHS = [5, 10, 20, 30, 45, 49, 50, 55, 80, 120, 150, 200, 250, 299];
const CJK_LENGTHS = [3, 5, 10, 20, 30, 45, 49, 50, 60, 80, 119];

const GENERATED_CASES: Array<{ name: string; seed: number; language: string; limit: number; pool: number[]; shape: UnitShape }> = [
	{ name: 'latin terminal sentences', seed: 20260805, language: 'en', limit: 300, pool: LATIN_LENGTHS, shape: 'terminal' },
	{
		name: 'latin unpunctuated units with audible pauses',
		seed: 41720613,
		language: 'en',
		limit: 300,
		pool: LATIN_LENGTHS,
		shape: 'unpunctuatedAudible',
	},
	{
		name: 'latin unpunctuated units with engine-managed silence',
		seed: 90210077,
		language: 'vi',
		limit: 300,
		pool: LATIN_LENGTHS,
		shape: 'unpunctuatedSilent',
	},
	{ name: 'korean capacity of 120', seed: 13370042, language: 'ko', limit: 120, pool: CJK_LENGTHS, shape: 'terminal' },
	{
		name: 'japanese capacity of 120 with synthetic cadence',
		seed: 77003311,
		language: 'ja',
		limit: 120,
		pool: CJK_LENGTHS,
		shape: 'unpunctuatedAudible',
	},
];

for (const { name, seed, language, limit, pool, shape } of GENERATED_CASES) {
	test(`seeded property: optimizer matches the exhaustive contiguous-partition oracle (${name})`, () => {
		const random = pseudoRandom(seed);

		for (let iteration = 0; iteration < 60; iteration++) {
			const lengths = Array.from({ length: Math.floor(random() * 7) + 2 }, () => pool[Math.floor(random() * pool.length)]);
			const { units, joinOverhead } = sourceUnits(lengths, shape);
			if (lengths.some((length) => length > limit)) {
				continue;
			}
			const expected = expectedPartition(lengths, limit, joinOverhead);
			const actual = outputRanges(consolidateShortSpeechUnits(units, language));
			assert.deepEqual(
				actual,
				expected,
				`seed=${seed} shape=${shape} language=${language} limit=${limit} iteration=${iteration} lengths=${JSON.stringify(lengths)} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
			);
		}
	});
}

test('produces byte-for-byte identical output when the same units are consolidated twice', () => {
	const lengths = [45, 10, 200, 30, 49, 120, 5];
	const first = consolidateShortSpeechUnits(sourceUnits(lengths).units, 'en');
	const second = consolidateShortSpeechUnits(sourceUnits(lengths).units, 'en');
	assert.deepEqual(second, first);
});
