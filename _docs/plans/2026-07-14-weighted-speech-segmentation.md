# Weighted Speech Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace eager Vietnamese punctuation splitting and the nominal 200-character fallback with a shared weighted planner that produces complete, ordered speech units within a 300-code-unit hard limit.

**Architecture:** Add a browser-independent segmentation module that scores caller-supplied boundaries and owns length/fallback logic. Keep Vietnamese token protection and punctuation scanning in `vietnamese/speech_units.ts`, which supplies the approved weights and pause metadata; leave non-Vietnamese `chunkText()` behavior unchanged.

**Tech Stack:** TypeScript 6, Node 25 built-in test runner, Biome, pnpm, Chrome Manifest V3 extension runtime.

## Global Constraints

- Store implementation plans in `_docs/plans` and specifications in `_docs/specs`.
- Use TypeScript only; add no dependency, runtime model, network call, telemetry, or user-facing setting.
- Use `140` and `240` UTF-16 code units as the preferred range, `190` as the scoring center, and `300` as the hard limit.
- Preserve punctuation and normalized source order through source-span coverage: each unit text must occur after the previous covered span, and every leading, inter-unit, or trailing gap must be whitespace-only. This is the binding reconstruction invariant, including forced splits inside unbroken tokens.
- Apply explicit silence only at selected unit boundaries; internal punctuation remains available to Supertonic for natural prosody.
- Keep the existing non-Vietnamese `chunkText(text, 200)` compatibility path unchanged.
- Keep all scratch artifacts under the repository's `.tmp/` directory; do not use the operating system temporary directory.
- Follow TDD: observe each new test fail before adding the implementation that makes it pass.
- Design source: `_docs/specs/2026-07-14-weighted-speech-segmentation-design.md`.

---

## File structure

- Create `src/offscreen/segmentation.ts`: generic boundary types, scoring, whitespace fallback, surrogate-safe hard splitting, and text-preservation logic.
- Create `tests/unit/segmentation.test.ts`: focused unit tests for scoring, preferred lengths, orphan avoidance, source-span coverage, and fallback safety.
- Modify `src/offscreen/vietnamese/speech_units.ts`: retain Vietnamese protected-span scanning, emit typed candidates, define the approved policy, and delegate selection to the shared planner.
- Modify `tests/unit/vietnamese_speech_units.test.ts`: replace eager-split expectations with weighted-unit, pause-precedence, protection, and reconstruction expectations.
- Read only `src/offscreen/playback_preparation.ts`: confirm the Vietnamese call site and non-Vietnamese compatibility path do not need changes.

### Task 1: Shared weighted segmentation planner

**Files:**
- Create: `tests/unit/segmentation.test.ts`
- Create: `src/offscreen/segmentation.ts`

**Interfaces:**
- Consumes: normalized paragraph text and sorted `BoundaryCandidate<Kind>[]` offsets measured in UTF-16 code units.
- Produces: `planTextSegments<Kind>(text, boundaries, policy, finalPauseAfterMs): TextSegment[]`.
- Produces: `BoundaryCandidate<Kind>`, `SegmentationPolicy<Kind>`, and `TextSegment` types for the Vietnamese adapter in Task 2.

- [ ] **Step 1: Write the failing planner tests**

Create `tests/unit/segmentation.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	planTextSegments,
	type BoundaryCandidate,
	type SegmentationPolicy,
} from '../../src/offscreen/segmentation.ts';

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
	const boundaries = [
		boundary(source, '.', 'sentence', 165),
		{ end: source.length, kind: 'sentence' as const, pauseAfterMs: 165 },
	];

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
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
node --experimental-strip-types --test tests/unit/segmentation.test.ts
```

Expected: FAIL with `ERR_ASSERTION` from an API-availability bootstrap: catch the missing-module import, observe
`typeof segmentation?.planTextSegments` as `'undefined'`, and assert that it is `'function'`. `ERR_MODULE_NOT_FOUND` itself is not RED evidence.
Add only the minimal export to make the bootstrap green, then add the behavior tests above one at a time and observe each assertion failure before
implementing that behavior.

- [ ] **Step 3: Implement the generic planner**

Create `src/offscreen/segmentation.ts` with:

```ts
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
	const shortRemainderPenalty =
		remainderLength > 0 && remainderLength < policy.shortRemainderLength ? policy.shortRemainderPenalty : 0;
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
```

- [ ] **Step 4: Run the focused test and verify the green state**

Run:

```bash
node --experimental-strip-types --test tests/unit/segmentation.test.ts
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Format and statically check the new planner files**

Run:

```bash
pnpm exec biome check --write src/offscreen/segmentation.ts tests/unit/segmentation.test.ts
pnpm exec biome check src/offscreen/segmentation.ts tests/unit/segmentation.test.ts
```

Expected: both commands exit 0 and Biome reports no remaining diagnostics.

- [ ] **Step 6: Commit the shared planner**

```bash
git add src/offscreen/segmentation.ts tests/unit/segmentation.test.ts
git commit -m "Add weighted speech segmentation planner"
```

### Task 2: Vietnamese weighted policy and pause integration

**Files:**
- Modify: `tests/unit/vietnamese_speech_units.test.ts:1-55`
- Modify: `src/offscreen/vietnamese/speech_units.ts:1-142`
- Verify unchanged: `src/offscreen/playback_preparation.ts:1-39`
- Test: `tests/unit/playback_preparation.test.ts`

**Interfaces:**
- Consumes: `BoundaryCandidate`, `SegmentationPolicy`, and `planTextSegments` from Task 1.
- Produces: the existing `planSpeechUnits(text: string): SpeechUnit[]` API with new weighted behavior.
- Preserves: `preparePlaybackUnits(text, lang, normalizer)` and the non-Vietnamese compatibility path.

- [ ] **Step 1: Replace eager-split expectations with weighted behavior tests**

Replace `tests/unit/vietnamese_speech_units.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	planSpeechUnits,
	VI_MAX_UNIT_LENGTH,
	VI_PREFERRED_MAX_LENGTH,
	VI_PREFERRED_MIN_LENGTH,
} from '../../src/offscreen/vietnamese/speech_units.ts';

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

test('keeps short clauses together and applies paragraph pause precedence', () => {
	const first =
		'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.';
	const second = 'Đoạn cuối cùng đủ dài!';

	assert.deepEqual(planSpeechUnits(`${first}\n\n${second}`), [
		{ text: first, pauseAfterMs: 260 },
		{ text: second, pauseAfterMs: 165 },
	]);
});

test('selects a weighted Vietnamese boundary in the preferred range', () => {
	const source = `${'từ '.repeat(30).trim()}. ${'ngữ '.repeat(20).trim()}, ${'dài '.repeat(90).trim()}`;
	const units = planSpeechUnits(source);

	assert.equal(units[0].text.endsWith(','), true);
	assert.ok(units[0].text.length >= VI_PREFERRED_MIN_LENGTH);
	assert.ok(units[0].text.length <= VI_PREFERRED_MAX_LENGTH);
});

test('does not split punctuation inside protected structured forms', () => {
	const protectedText = 'Các mã 10-12, 11-07-2026, https://a-b.vn và AB-123 vẫn nằm cùng câu.';
	const source = `${protectedText} ${'nội dung '.repeat(45).trim()}`;
	const reconstructed = planSpeechUnits(source)
		.map(({ text }) => text)
		.join(' ');

	assert.equal(normalizeWhitespace(reconstructed), normalizeWhitespace(source));
	assert.equal(reconstructed.includes('https://a-b.vn'), true);
});

test('does not split a standalone decimal at its punctuation', () => {
	const source = 'từ '.repeat(45) + '3.14 ' + 'nội dung '.repeat(35);
	const units = planSpeechUnits(source);
	const splitsDecimal = units.some(({ text }, index) => text.endsWith('3.') && units[index + 1]?.text.startsWith('14'));

	assert.equal(splitsDecimal, false);
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('keeps every unit within the hard limit and preserves all normalized text', () => {
	const source = Array.from({ length: 140 }, (_, index) => `từ${index}`).join(' ');
	const units = planSpeechUnits(source);

	assert.ok(units.length > 1);
	assert.ok(units.every(({ text }) => text.length <= VI_MAX_UNIT_LENGTH));
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('returns no empty units', () => {
	assert.deepEqual(planSpeechUnits(' \n\n '), []);
});

test('keeps consecutive short sentences in one synthesis unit', () => {
	assert.deepEqual(planSpeechUnits('Câu đầu… Câu sau.'), [{ text: 'Câu đầu… Câu sau.', pauseAfterMs: 165 }]);
});
```

- [ ] **Step 2: Run the Vietnamese speech-unit test and verify the behavioral failures**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_speech_units.test.ts
```

Expected: bootstrap the two public constants through a dynamic import of the existing module and verify `ERR_ASSERTION` because the properties are
`undefined`, not through a named-import or compile failure. Add only the minimal constant exports to make that bootstrap green, then add each behavior
test one at a time and observe its assertion failure because the old planner still emits eager punctuation units. Import and compile failures are not
RED evidence.

- [ ] **Step 3: Replace the Vietnamese planner with a scanner and weighted policy adapter**

Replace `src/offscreen/vietnamese/speech_units.ts` with:

```ts
import {
	planTextSegments,
	type BoundaryCandidate,
	type SegmentationPolicy,
} from '../segmentation.ts';
import type { SpeechUnit } from './types.ts';

export const VI_PAUSE_MS = Object.freeze({
	comma: 60,
	colonOrSemicolon: 90,
	spacedDash: 105,
	sentenceEnd: 165,
	paragraphEnd: 260,
});
export const VI_PREFERRED_MIN_LENGTH = 140;
export const VI_PREFERRED_CENTER_LENGTH = 190;
export const VI_PREFERRED_MAX_LENGTH = 240;
export const VI_MAX_UNIT_LENGTH = 300;

type VietnameseBoundaryKind = 'sentence' | 'semicolon' | 'colon' | 'spacedDash' | 'comma';

const VI_SEGMENTATION_POLICY: SegmentationPolicy<VietnameseBoundaryKind> = Object.freeze({
	preferredMin: VI_PREFERRED_MIN_LENGTH,
	preferredCenter: VI_PREFERRED_CENTER_LENGTH,
	preferredMax: VI_PREFERRED_MAX_LENGTH,
	hardMax: VI_MAX_UNIT_LENGTH,
	outsidePreferredPenalty: 10,
	shortRemainderLength: 80,
	shortRemainderPenalty: 30,
	minimumScore: 0,
	boundaryWeights: Object.freeze({
		sentence: 40,
		semicolon: 30,
		colon: 28,
		spacedDash: 24,
		comma: 20,
	}),
});

const PROTECTED_PATTERNS = [
	/https?:\/\/[^\s<>"'“”‘’]+/giu,
	/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
	/(?:\d{1,3}\.){3}\d{1,3}/gu,
	/v\d+(?:\.\d+)+/giu,
	/\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/gu,
	/\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/gu,
	/\d+(?:[.,]\d+)*(?:\s?[-–]\s?\d+(?:[.,]\d+)*)?\s?(?:km\/h|m²|m3|%|₫|đ|mm|cm|km|kg|mg|ml|ha|m|g|l)/giu,
	/[A-ZĐĂÂÊÔƠƯ]+-\d+(?:-[A-ZĐĂÂÊÔƠƯ]+)*/gu,
] as const;

function protectedPositions(text: string): Uint8Array {
	const positions = new Uint8Array(text.length);
	for (const pattern of PROTECTED_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			let value = match[0];
			if (pattern === PROTECTED_PATTERNS[0]) {
				value = value.replace(/[….,!?;:]+$/u, '');
			}
			const start = match.index ?? 0;
			positions.fill(1, start, start + value.length);
		}
	}
	return positions;
}

function scanBoundaries(text: string): BoundaryCandidate<VietnameseBoundaryKind>[] {
	const protectedAt = protectedPositions(text);
	const boundaries: BoundaryCandidate<VietnameseBoundaryKind>[] = [];
	for (let index = 0; index < text.length; index++) {
		if (protectedAt[index]) {
			continue;
		}
		const character = text[index];
		if (character === ',' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'comma', pauseAfterMs: VI_PAUSE_MS.comma });
		} else if (character === ':' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'colon', pauseAfterMs: VI_PAUSE_MS.colonOrSemicolon });
		} else if (character === ';' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'semicolon', pauseAfterMs: VI_PAUSE_MS.colonOrSemicolon });
		} else if ('-–—'.includes(character) && /\s/u.test(text[index - 1] ?? '') && /\s/u.test(text[index + 1] ?? '')) {
			boundaries.push({ end: index + 1, kind: 'spacedDash', pauseAfterMs: VI_PAUSE_MS.spacedDash });
		} else if (
			/[.!?…]/u.test(character) &&
			!(character === '.' && /\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))
		) {
			let end = index + 1;
			while (text[end] === '.') {
				end++;
			}
			boundaries.push({ end, kind: 'sentence', pauseAfterMs: VI_PAUSE_MS.sentenceEnd });
			index = end - 1;
		}
	}
	return boundaries;
}

function planParagraph(text: string, paragraphPauseAfterMs: number): SpeechUnit[] {
	const boundaries = scanBoundaries(text);
	const trailingBoundary = boundaries.at(-1);
	const trailingPauseAfterMs = trailingBoundary?.end === text.length ? trailingBoundary.pauseAfterMs : 0;
	return planTextSegments(text, boundaries, VI_SEGMENTATION_POLICY, Math.max(trailingPauseAfterMs, paragraphPauseAfterMs));
}

export function planSpeechUnits(text: string): SpeechUnit[] {
	const paragraphs = text
		.normalize('NFC')
		.split(/\n[\t ]*\n+/u)
		.map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
		.filter(Boolean);
	const units: SpeechUnit[] = [];
	for (let index = 0; index < paragraphs.length; index++) {
		units.push(...planParagraph(paragraphs[index], index < paragraphs.length - 1 ? VI_PAUSE_MS.paragraphEnd : 0));
	}
	return units;
}
```

- [ ] **Step 4: Run Vietnamese planner and playback-preparation tests**

Run:

```bash
node --experimental-strip-types --test tests/unit/segmentation.test.ts tests/unit/vietnamese_speech_units.test.ts tests/unit/playback_preparation.test.ts
```

Expected: all focused tests pass; the non-Vietnamese compatibility test still returns `chunkText(text, 200)` units with zero explicit pause.

- [ ] **Step 5: Format and check the Vietnamese integration**

Run:

```bash
pnpm exec biome check --write src/offscreen/vietnamese/speech_units.ts tests/unit/vietnamese_speech_units.test.ts
pnpm exec biome check src/offscreen/segmentation.ts src/offscreen/vietnamese/speech_units.ts tests/unit/segmentation.test.ts tests/unit/vietnamese_speech_units.test.ts
```

Expected: both commands exit 0 with no remaining diagnostics.

- [ ] **Step 6: Commit the Vietnamese policy integration**

```bash
git add src/offscreen/vietnamese/speech_units.ts tests/unit/vietnamese_speech_units.test.ts
git commit -m "Use weighted Vietnamese speech units"
```

### Task 3: Segmentation verification gate

**Files:**
- Verify: `src/offscreen/segmentation.ts`
- Verify: `src/offscreen/vietnamese/speech_units.ts`
- Verify: `src/offscreen/playback_preparation.ts`
- Verify: `tests/unit/segmentation.test.ts`
- Verify: `tests/unit/vietnamese_speech_units.test.ts`
- Verify: `tests/e2e/vietnamese-pronunciation.spec.ts`

**Interfaces:**
- Consumes: the shared planner and Vietnamese adapter completed in Tasks 1 and 2.
- Produces: a verified segmentation checkpoint for the indexed-prefetch plan.

- [ ] **Step 1: Run the complete unit suite**

Run:

```bash
pnpm test:unit
```

Expected: exit 0 with no failed, skipped, or cancelled tests.

- [ ] **Step 2: Build the production extension**

Run:

```bash
pnpm build
```

Expected: TypeScript and Rsbuild exit 0 and produce `dist/`.

- [ ] **Step 3: Run the Vietnamese extension E2E test**

Run:

```bash
pnpm test:e2e:vi
```

Expected: exit 0 with the Vietnamese local-processing/cancellation test passing.

- [ ] **Step 4: Check the complete worktree diff**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` prints nothing. `git status --short` shows no segmentation implementation changes after the two task commits; unrelated pre-existing files remain untouched.

- [ ] **Step 5: Record the checkpoint commit**

Run:

```bash
git log -2 --oneline
```

Expected: the two most recent implementation commits are `Use weighted Vietnamese speech units` and `Add weighted speech segmentation planner`.
