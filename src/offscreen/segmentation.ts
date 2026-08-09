export interface BoundaryCandidate<Kind extends string> {
	end: number;
	kind: Kind;
	pauseAfterMs: number;
}

export interface TextSegment {
	text: string;
	pauseAfterMs: number;
}

export class SegmentationCapacityError extends RangeError {
	readonly code = 'SYNTHESIS_CAPACITY_EXCEEDED';

	constructor(start: number, limit: number) {
		super(`No safe segmentation boundary exists after offset ${start} within the synthesis capacity of ${limit}`);
		this.name = 'SegmentationCapacityError';
	}
}

function skipWhitespace(text: string, start: number, end: number): number {
	let index = start;
	while (index < end && /\s/u.test(text[index])) {
		index++;
	}
	return index;
}

function contentEnd(text: string): number {
	let end = text.length;
	while (end > 0 && /\s/u.test(text[end - 1])) {
		end--;
	}
	return end;
}

function rightmostBoundary<Kind extends string>(
	boundaries: readonly BoundaryCandidate<Kind>[],
	start: number,
	hardEnd: number,
	kind: string,
): BoundaryCandidate<Kind> | undefined {
	for (let index = boundaries.length - 1; index >= 0; index--) {
		const boundary = boundaries[index];
		if (boundary.end > hardEnd) {
			continue;
		}
		if (boundary.end <= start) {
			break;
		}
		if (String(boundary.kind) === kind) {
			return boundary;
		}
	}
	return undefined;
}

function oversizedSentenceFallback<Kind extends string>(
	start: number,
	hardEnd: number,
	boundaries: readonly BoundaryCandidate<Kind>[],
): BoundaryCandidate<Kind> {
	for (const kind of ['semicolon', 'colon', 'spacedDash', 'comma', 'whitespace']) {
		const boundary = rightmostBoundary(boundaries, start, hardEnd, kind);
		if (boundary) {
			return boundary;
		}
	}
	throw new SegmentationCapacityError(start, hardEnd - start);
}

/**
 * Plan one Source Unit per complete sentence, in source order.
 *
 * Sentences are not packed together up to capacity here. Each one keeps its own terminal pause, and
 * deciding which neighbours are worth fusing is the consolidation pass's job — it optimizes that
 * choice globally, which a left-to-right fill cannot. The one case that splits inside a sentence is
 * a sentence that does not fit on its own, which takes the ordered fallback below.
 */
export function planTextSegments<Kind extends string>(
	text: string,
	boundaries: readonly BoundaryCandidate<Kind>[],
	hardMax: number,
	finalPauseAfterMs: number,
): TextSegment[] {
	const end = contentEnd(text);
	const units: TextSegment[] = [];
	let start = skipWhitespace(text, 0, end);
	let cursor = 0;

	while (start < end) {
		while (cursor < boundaries.length && (boundaries[cursor].end <= start || String(boundaries[cursor].kind) !== 'sentence')) {
			cursor++;
		}
		const sentence = boundaries[cursor]?.end <= end ? boundaries[cursor] : undefined;
		const sentenceEnd = sentence?.end ?? end;

		if (sentenceEnd - start <= hardMax) {
			units.push({ text: text.slice(start, sentenceEnd).trim(), pauseAfterMs: sentence?.pauseAfterMs ?? finalPauseAfterMs });
			start = skipWhitespace(text, sentenceEnd, end);
			continue;
		}

		const fallback = oversizedSentenceFallback(start, start + hardMax, boundaries);
		const unit = text.slice(start, fallback.end).trim();
		if (!unit) {
			throw new SegmentationCapacityError(start, hardMax);
		}
		units.push({ text: unit, pauseAfterMs: fallback.pauseAfterMs });
		start = skipWhitespace(text, fallback.end, end);
	}

	// A hard paragraph boundary replaces the sentence-terminal pause its paragraph ends on.
	const last = units.at(-1);
	if (last && finalPauseAfterMs > last.pauseAfterMs) {
		last.pauseAfterMs = finalPauseAfterMs;
	}
	return units;
}
