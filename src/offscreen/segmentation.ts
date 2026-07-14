export interface BoundaryCandidate<Kind extends string> {
	end: number;
	kind: Kind;
	pauseAfterMs: number;
}

export interface SegmentationPolicy<Kind extends string> {
	preferredMin: number;
	preferredCenter: number;
	preferredMax: number;
	hardMax: number;
	outsidePreferredPenalty: number;
	shortRemainderLength: number;
	shortRemainderPenalty: number;
	minimumScore: number;
	boundaryWeights: Readonly<Record<Kind, number>>;
}

export interface TextSegment {
	text: string;
	pauseAfterMs: number;
}

interface ScoredBoundary<Kind extends string> {
	boundary: BoundaryCandidate<Kind>;
	score: number;
	weight: number;
	distance: number;
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

function scoreCandidate<Kind extends string>(
	text: string,
	start: number,
	end: number,
	boundary: BoundaryCandidate<Kind>,
	policy: SegmentationPolicy<Kind>,
): ScoredBoundary<Kind> {
	const length = text.slice(start, boundary.end).trim().length;
	const remainderStart = skipWhitespace(text, boundary.end, end);
	const remainderLength = end - remainderStart;
	const outsidePreferredPenalty = length < policy.preferredMin || length > policy.preferredMax ? policy.outsidePreferredPenalty : 0;
	const shortRemainderPenalty = remainderLength > 0 && remainderLength < policy.shortRemainderLength ? policy.shortRemainderPenalty : 0;
	const weight = policy.boundaryWeights[boundary.kind];
	const distance = Math.abs(length - policy.preferredCenter);

	return {
		boundary,
		weight,
		distance,
		score: weight - distance / 5 - outsidePreferredPenalty - shortRemainderPenalty,
	};
}

function isBetter<Kind extends string>(candidate: ScoredBoundary<Kind>, current: ScoredBoundary<Kind> | null): boolean {
	if (!current || candidate.score !== current.score) {
		return !current || candidate.score > current.score;
	}
	if (candidate.weight !== current.weight) {
		return candidate.weight > current.weight;
	}
	if (candidate.distance !== current.distance) {
		return candidate.distance < current.distance;
	}
	return candidate.boundary.end < current.boundary.end;
}

function nearestWhitespace(text: string, start: number, hardEnd: number, center: number): number {
	let best = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = start + 1; index <= hardEnd && index < text.length; index++) {
		if (!/\s/u.test(text[index])) {
			continue;
		}
		const distance = Math.abs(index - start - center);
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	}
	return best;
}

function surrogateSafeSplit(text: string, split: number): number {
	if (split <= 0 || split >= text.length) {
		return split;
	}
	const previous = text.charCodeAt(split - 1);
	const next = text.charCodeAt(split);
	return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? split - 1 : split;
}

export function planTextSegments<Kind extends string>(
	text: string,
	boundaries: readonly BoundaryCandidate<Kind>[],
	policy: SegmentationPolicy<Kind>,
	finalPauseAfterMs: number,
): TextSegment[] {
	const end = contentEnd(text);
	const units: TextSegment[] = [];
	let start = skipWhitespace(text, 0, end);

	while (start < end) {
		if (end - start <= policy.hardMax) {
			units.push({ text: text.slice(start, end).trim(), pauseAfterMs: finalPauseAfterMs });
			break;
		}

		const hardEnd = Math.min(start + policy.hardMax, end);
		let best: ScoredBoundary<Kind> | null = null;
		for (const boundary of boundaries) {
			if (boundary.end <= start) {
				continue;
			}
			if (boundary.end > hardEnd) {
				break;
			}
			const scored = scoreCandidate(text, start, end, boundary, policy);
			if (scored.score >= policy.minimumScore && isBetter(scored, best)) {
				best = scored;
			}
		}

		const whitespace = nearestWhitespace(text, start, hardEnd, policy.preferredCenter);
		const split = best?.boundary.end ?? (whitespace > start ? whitespace : surrogateSafeSplit(text, hardEnd));
		const unit = text.slice(start, split).trim();
		if (unit) {
			units.push({ text: unit, pauseAfterMs: best?.boundary.pauseAfterMs ?? 0 });
		}
		start = skipWhitespace(text, split, end);
	}

	return units;
}
