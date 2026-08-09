import type { SpeechUnit } from './speech_unit.ts';
import { synthesisTextLimitForLanguage } from './supertonic_helper.ts';

/** Minimum reliable synthesis size measured in trimmed non-whitespace Unicode code points. */
export const MIN_RELIABLE_SYNTHESIS_CHARACTERS = 50;

export function nonWhitespaceCodePointCount(text: string): number {
	return Array.from(text.trim()).filter((character) => !/\s/u.test(character)).length;
}

export function shortThresholdForLanguage(_language: string): number {
	return MIN_RELIABLE_SYNTHESIS_CHARACTERS;
}

export function isShortSpeechUnit(unit: Pick<SpeechUnit, 'text'>, language = 'en'): boolean {
	return nonWhitespaceCodePointCount(unit.text) < shortThresholdForLanguage(language);
}

function synthesisTextForUnit(unit: SpeechUnit): string {
	return unit.synthesisText ?? unit.text;
}

function hasNaturalTerminalCadence(text: string): boolean {
	return /[.!?…]$/u.test(text.trimEnd());
}

function hasAudiblePause(unit: Pick<SpeechUnit, 'pauseAfterMs'>): boolean {
	return typeof unit.pauseAfterMs === 'number' && unit.pauseAfterMs > 0;
}

function joinUnitText(left: string, right: string): string {
	return `${left.trimEnd()} ${right.trimStart()}`;
}

function renderingTextForMerge(left: SpeechUnit, right: SpeechUnit): string {
	const leftRendering = synthesisTextForUnit(left).trimEnd();
	const renderedLeft = hasAudiblePause(left) && !hasNaturalTerminalCadence(leftRendering) ? `${leftRendering}.` : leftRendering;
	return joinUnitText(renderedLeft, synthesisTextForUnit(right));
}

function mergeSpeechUnits(left: SpeechUnit, right: SpeechUnit): SpeechUnit {
	const text = joinUnitText(left.text, right.text);
	const synthesisText = renderingTextForMerge(left, right);
	const { wordMap: _leftWordMap, synthesisText: _leftSynthesisText, ...leftWithoutDerivedFields } = left;

	return {
		...leftWithoutDerivedFields,
		text,
		...(synthesisText === text ? {} : { synthesisText }),
		pauseAfterMs: right.pauseAfterMs,
	};
}

interface FeasibleRange {
	unit: SpeechUnit;
	isGenuinelyMerged: boolean;
	renderingLength: number;
	isShort: boolean;
}

/**
 * Every feasible contiguous range, indexed as `[start][end - start - 1]`. Merging only ever appends
 * to the rendering, so a range's length grows strictly with its end: the first range that overruns
 * capacity ends the row, and no longer range from that start can fit either.
 */
type FeasibleRangeTable = readonly (readonly FeasibleRange[])[];

function buildFeasibleRanges(units: readonly SpeechUnit[], limit: number, threshold: number): FeasibleRangeTable {
	const table: FeasibleRange[][] = [];
	for (let start = 0; start < units.length; start++) {
		const ranges: FeasibleRange[] = [];
		let merged: SpeechUnit | null = units[start];
		for (let end = start + 1; end <= units.length && merged; end++) {
			const renderingLength = synthesisTextForUnit(merged).length;
			if (renderingLength > limit) {
				break;
			}
			ranges.push({
				unit: merged,
				isGenuinelyMerged: end - start > 1,
				renderingLength,
				isShort: nonWhitespaceCodePointCount(merged.text) < threshold,
			});
			merged = end < units.length ? mergeSpeechUnits(merged, units[end]) : null;
		}
		if (ranges.length === 0) {
			throw new RangeError(`Source Unit ${start + 1} exceeds synthesis capacity ${limit}`);
		}
		table.push(ranges);
	}
	return table;
}

function rangeAt(table: FeasibleRangeTable, start: number, end: number): FeasibleRange | undefined {
	return table[start]?.[end - start - 1];
}

/**
 * Whether a range may be chosen as an output run under the current maximum-merged-length bound. The
 * bound belongs to the R9.3 search, not to R9.2 mergeability, so adjacency tests use plain capacity
 * feasibility instead.
 */
function isSelectable(range: FeasibleRange | undefined, mergedLengthBound: number): range is FeasibleRange {
	return range !== undefined && (!range.isGenuinelyMerged || range.renderingLength <= mergedLengthBound);
}

function stateKey(runStart: number, canMergeLeft: boolean): number {
	return runStart * 2 + (canMergeLeft ? 1 : 0);
}

/**
 * For every state "run `[runStart, end)` was just committed and can/cannot merge with its left
 * neighbour", the fewest Independently Mergeable Short Output Units contributed by that run and
 * everything after it. Whether the run itself counts depends on the run that follows, which is
 * exactly why the open run stays in the state.
 */
function minimumRemainingShortCounts(table: FeasibleRangeTable, count: number, mergedLengthBound: number): Array<Map<number, number>> {
	const remaining: Array<Map<number, number>> = Array.from({ length: count + 1 }, () => new Map());
	for (let end = count; end >= 1; end--) {
		for (let runStart = end - 1; runStart >= 0; runStart--) {
			const range = rangeAt(table, runStart, end);
			if (!isSelectable(range, mergedLengthBound)) {
				break;
			}
			for (const canMergeLeft of [false, true]) {
				let best = Number.POSITIVE_INFINITY;
				if (end === count) {
					best = range.isShort && canMergeLeft ? 1 : 0;
				} else {
					for (let nextEnd = end + 1; nextEnd <= count; nextEnd++) {
						if (!isSelectable(rangeAt(table, end, nextEnd), mergedLengthBound)) {
							break;
						}
						const canMergeRight = rangeAt(table, runStart, nextEnd) !== undefined;
						const rest = remaining[nextEnd].get(stateKey(end, canMergeRight));
						if (rest === undefined) {
							continue;
						}
						best = Math.min(best, (range.isShort && (canMergeLeft || canMergeRight) ? 1 : 0) + rest);
					}
				}
				if (best !== Number.POSITIVE_INFINITY) {
					remaining[end].set(stateKey(runStart, canMergeLeft), best);
				}
			}
		}
	}
	return remaining;
}

function minimumShortCount(remaining: Array<Map<number, number>>, table: FeasibleRangeTable, count: number, bound: number): number {
	let best = Number.POSITIVE_INFINITY;
	for (let end = 1; end <= count; end++) {
		if (!isSelectable(rangeAt(table, 0, end), bound)) {
			break;
		}
		const total = remaining[end].get(stateKey(0, false));
		if (total !== undefined) {
			best = Math.min(best, total);
		}
	}
	return best;
}

/**
 * Walk the optimum forward, always taking the earliest end that still reaches it. Taking the
 * earliest feasible end at every step is precisely the lexicographically smallest end-index vector
 * (R9.4); because runs are contiguous, each run's start is the previous run's end, so the
 * start-index vector (R9.5) is decided along with it.
 */
function selectEarliestOptimalPartition(
	table: FeasibleRangeTable,
	count: number,
	bound: number,
	remaining: Array<Map<number, number>>,
	total: number,
): SpeechUnit[] {
	const chosen: SpeechUnit[] = [];
	let runStart = 0;
	let canMergeLeft = false;
	let value = total;
	let end = 1;
	while (remaining[end].get(stateKey(runStart, canMergeLeft)) !== value) {
		end++;
	}

	for (;;) {
		const range = rangeAt(table, runStart, end) as FeasibleRange;
		chosen.push(range.unit);
		if (end === count) {
			return chosen;
		}

		// The next run decides whether this one counted as independently mergeable, so it is picked
		// once here rather than re-derived on the following pass, where the left-mergeability flag
		// would no longer match the end that produced it.
		for (let nextEnd = end + 1; ; nextEnd++) {
			if (!isSelectable(rangeAt(table, end, nextEnd), bound)) {
				continue;
			}
			const canMergeRight = rangeAt(table, runStart, nextEnd) !== undefined;
			const rest = remaining[nextEnd].get(stateKey(end, canMergeRight));
			if (rest === undefined || (range.isShort && (canMergeLeft || canMergeRight) ? 1 : 0) + rest !== value) {
				continue;
			}
			value = rest;
			runStart = end;
			canMergeLeft = canMergeRight;
			end = nextEnd;
			break;
		}
	}
}

/**
 * Globally partition consecutive bare Source Units into feasible output runs.
 *
 * The R9 objective is lexicographic — fewest independently mergeable short outputs, then the
 * smallest maximum rendering length among genuinely merged runs, then the earliest end-index vector
 * — and only the first term is additive along a partition. Keeping one best prefix per state and
 * comparing the whole tuple therefore discards prefixes that carry a larger running maximum but tie
 * on the final maximum and win on the end vector. So each term is optimized in its own pass: a
 * backward dynamic program for the count, a binary search for the smallest maximum that still
 * attains that count, then an earliest-end walk under both.
 */
export function consolidateShortSpeechUnits(units: readonly SpeechUnit[], language: string): SpeechUnit[] {
	if (units.length === 0) {
		return [];
	}

	const count = units.length;
	const table = buildFeasibleRanges(units, synthesisTextLimitForLanguage(language), shortThresholdForLanguage(language));

	const unbounded = Number.POSITIVE_INFINITY;
	const optimalCount = minimumShortCount(minimumRemainingShortCounts(table, count, unbounded), table, count, unbounded);

	// Zero stands for "no genuinely merged run at all", which the all-singletons partition always
	// satisfies, so a bound is always attainable and the search below always terminates.
	const bounds = [
		0,
		...new Set(table.flatMap((ranges) => ranges.filter((range) => range.isGenuinelyMerged).map((range) => range.renderingLength))),
	].sort((left, right) => left - right);

	let low = 0;
	let high = bounds.length - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const bound = bounds[middle];
		if (minimumShortCount(minimumRemainingShortCounts(table, count, bound), table, count, bound) === optimalCount) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}

	const bound = bounds[low];
	return selectEarliestOptimalPartition(table, count, bound, minimumRemainingShortCounts(table, count, bound), optimalCount);
}
