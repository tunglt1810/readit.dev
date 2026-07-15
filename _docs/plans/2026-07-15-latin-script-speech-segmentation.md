# Latin-Script Speech Segmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply weighted speech segmentation and boundary-specific pauses to all predominantly Latin-script text while preserving Vietnamese normalization and non-Latin compatibility audio.

**Architecture:** Move the existing punctuation scanner and policy into a shared Latin-script planner while leaving the generic scorer in `segmentation.ts`. Route Vietnamese by its primary BCP-47 subtag, route other text by a Unicode Latin-letter majority, and encode explicit versus engine-managed pause behavior in `SpeechUnit.pauseAfterMs`. Generalize the existing audio helper so every language follows the prepared unit's pause strategy without changing synthesis coordination or playback ordering.

**Tech Stack:** TypeScript 6, Node 25 built-in test runner, Unicode property escapes, pnpm, Biome, Rsbuild, Playwright, Chrome Manifest V3.

## Global Constraints

- Store this implementation plan in `_docs/plans` and its design source in `_docs/specs`.
- Use TypeScript and built-in Unicode regular expressions only; add no dependency, runtime model, network call, telemetry, or user-facing setting.
- Classify text as predominantly Latin only when it contains at least one Unicode letter and more than half of all Unicode letters match `\p{Script=Latin}`; an exact 50/50 split is non-Latin.
- Count scripts by Unicode code point, but preserve the existing segmentation limits in UTF-16 code units: preferred range `140` to `240`, scoring center `190`, and hard maximum `300`.
- Preserve the existing boundary weights and pauses: sentence `40`/`165ms`, semicolon `30`/`90ms`, colon `28`/`90ms`, spaced dash `24`/`105ms`, comma `20`/`60ms`, and paragraph `260ms`.
- Treat `vi` and any case-insensitive BCP-47 value whose primary subtag is `vi`, such as `vi-VN`, as Vietnamese.
- `SpeechUnit.pauseAfterMs: number` means internal silence `0` plus the exact appended pause; `SpeechUnit.pauseAfterMs: null` means engine-managed internal silence `0.3` seconds with no appended pause.
- Weighted Vietnamese and other weighted Latin units use numeric pauses. Vietnamese compatibility fallback uses numeric zero. Non-Vietnamese compatibility fallback uses `null`.
- Do not alter indexed synthesis keys, prefetch retry behavior, cache retention, playback sessions, source-node guards, UI, permissions, or network behavior.
- Preserve source order and content: emitted weighted units may remove only outside whitespace and must not lose, duplicate, or reorder non-whitespace source content.
- Keep all scratch artifacts under the repository's `.tmp/` directory; do not use an operating-system temporary directory. Remove `.tmp/` after the implementation is complete.
- Preserve the unrelated untracked `context_improvement.md` file.
- Follow TDD: observe each focused test fail before adding the implementation that makes it pass.
- Design source: `_docs/specs/2026-07-15-latin-script-speech-segmentation-design.md`.

---

## File structure

- Create `src/offscreen/speech_unit.ts`: language-neutral `SpeechUnit` playback contract.
- Create `src/offscreen/latin/speech_units.ts`: predominantly-Latin classifier, protected-span scanner, weighted boundary policy, and paragraph-to-unit planning.
- Delete `src/offscreen/vietnamese/speech_units.ts`: its generalized behavior moves to the Latin-script module; no duplicate compatibility wrapper remains.
- Modify `src/offscreen/vietnamese/types.ts`: retain only Vietnamese normalization types and remove `SpeechUnit` ownership.
- Rename `tests/unit/vietnamese_speech_units.test.ts` to `tests/unit/latin_speech_units.test.ts`: preserve Vietnamese fixtures and add Latin classifier/planner coverage.
- Modify `src/offscreen/playback_preparation.ts`: route by Vietnamese primary subtag and Latin-script majority, and attach explicit versus engine-managed pause semantics.
- Modify `tests/unit/playback_preparation.test.ts`: cover Vietnamese BCP-47 routing, Latin routing despite missing/wrong language tags, and non-Latin compatibility.
- Modify `src/offscreen/audio.ts`: select internal versus appended silence from `pauseAfterMs`.
- Modify `tests/unit/offscreen_audio.test.ts`: cover explicit numeric, explicit zero, and engine-managed null pauses across languages.
- Modify `src/offscreen/offscreen.ts`: load Vietnamese assets through the shared language helper and use the generalized audio helper for every language.
- Modify `_docs/specs/2026-07-15-latin-script-speech-segmentation-design.md`: record implementation and automated-verification status only after all gates pass.

### Task 1: Generalize the Latin-script planner and speech-unit ownership

**Files:**
- Create: `src/offscreen/speech_unit.ts`
- Create: `src/offscreen/latin/speech_units.ts`
- Delete: `src/offscreen/vietnamese/speech_units.ts`
- Modify: `src/offscreen/vietnamese/types.ts`
- Modify: `src/offscreen/playback_preparation.ts`
- Modify: `src/offscreen/audio.ts`
- Modify: `src/offscreen/offscreen.ts`
- Rename: `tests/unit/vietnamese_speech_units.test.ts` to `tests/unit/latin_speech_units.test.ts`

**Interfaces:**
- Consumes: `planTextSegments<Kind>(text, boundaries, policy, finalPauseAfterMs)` from `src/offscreen/segmentation.ts`.
- Produces: the shared numeric `SpeechUnit { text: string; pauseAfterMs: number }` contract; Task 2 widens the pause field after its null-mode tests are red.
- Produces: `isPredominantlyLatinText(text: string): boolean`.
- Produces: `planLatinSpeechUnits(text: string): SpeechUnit[]` with numeric pause values.
- Produces: `LATIN_PAUSE_MS`, `LATIN_PREFERRED_MIN_LENGTH`, `LATIN_PREFERRED_CENTER_LENGTH`, `LATIN_PREFERRED_MAX_LENGTH`, and `LATIN_MAX_UNIT_LENGTH` production constants.

- [ ] **Step 1: Rename the planner test and write the failing shared-Latin expectations**

Rename the existing test file, then replace its contents:

```bash
git mv tests/unit/vietnamese_speech_units.test.ts tests/unit/latin_speech_units.test.ts
```

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isPredominantlyLatinText,
	LATIN_MAX_UNIT_LENGTH,
	LATIN_PREFERRED_MAX_LENGTH,
	LATIN_PREFERRED_MIN_LENGTH,
	planLatinSpeechUnits,
} from '../../src/offscreen/latin/speech_units.ts';

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

test('classifies Unicode Latin letters and ignores non-letter noise', () => {
	for (const source of [
		'English text',
		'français déjà vu',
		'Falsches Üben von Xylophonmusik quält jeden größeren Zwerg',
		'español corazón',
		'Zażółć gęślą jaźń',
		'123 😀 français !!!',
		'abc中',
	]) {
		assert.equal(isPredominantlyLatinText(source), true, source);
	}
});

test('rejects no-letter, exact-half, and non-Latin text', () => {
	for (const source of ['123 😀 !!!', 'ab中文', '中文内容', 'Русский текст', 'نص عربي']) {
		assert.equal(isPredominantlyLatinText(source), false, source);
	}
});

test('keeps short clauses together and applies paragraph pause precedence', () => {
	const first = 'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.';
	const second = 'Đoạn cuối cùng đủ dài!';

	assert.deepEqual(planLatinSpeechUnits(`${first}\n\n${second}`), [
		{ text: first, pauseAfterMs: 260 },
		{ text: second, pauseAfterMs: 165 },
	]);
});

test('selects a weighted boundary in the preferred range', () => {
	const source = `${'word '.repeat(18).trim()}. ${'phrase '.repeat(14).trim()}, ${'long '.repeat(90).trim()}`;
	const units = planLatinSpeechUnits(source);

	assert.equal(units[0].text.endsWith(','), true);
	assert.ok(units[0].text.length >= LATIN_PREFERRED_MIN_LENGTH);
	assert.ok(units[0].text.length <= LATIN_PREFERRED_MAX_LENGTH);
});

test('does not split punctuation inside protected structured forms', () => {
	const protectedText =
		'admin@example.com 192.168.1.10 v2.3.4 11-07-2026 10:30 3.5kg https://a-b.example ÅBC-123';
	const source = `${'prefix '.repeat(22)}${protectedText} ${'additional content '.repeat(45).trim()}`;
	const reconstructed = planLatinSpeechUnits(source)
		.map(({ text }) => text)
		.join(' ');

	assert.equal(normalizeWhitespace(reconstructed), normalizeWhitespace(source));
	assert.equal(reconstructed.includes('admin@example.com'), true);
	assert.equal(reconstructed.includes('192.168.1.10'), true);
	assert.equal(reconstructed.includes('v2.3.4'), true);
	assert.equal(reconstructed.includes('https://a-b.example'), true);
	assert.equal(reconstructed.includes('ÅBC-123'), true);
});

test('does not split a standalone decimal at its punctuation', () => {
	const source = 'word '.repeat(45) + '3.14 ' + 'content '.repeat(35);
	const units = planLatinSpeechUnits(source);
	const splitsDecimal = units.some(({ text }, index) => text.endsWith('3.') && units[index + 1]?.text.startsWith('14'));

	assert.equal(splitsDecimal, false);
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('keeps every unit within the hard limit and preserves all normalized text', () => {
	const source = Array.from({ length: 140 }, (_, index) => `word${index}`).join(' ');
	const units = planLatinSpeechUnits(source);

	assert.ok(units.length > 1);
	assert.ok(units.every(({ text }) => text.length <= LATIN_MAX_UNIT_LENGTH));
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('returns no empty units', () => {
	assert.deepEqual(planLatinSpeechUnits(' \n\n '), []);
});

test('keeps consecutive short sentences in one synthesis unit', () => {
	assert.deepEqual(planLatinSpeechUnits('Câu đầu… Câu sau.'), [{ text: 'Câu đầu… Câu sau.', pauseAfterMs: 165 }]);
});
```

- [ ] **Step 2: Run the renamed planner test and verify the new module is missing**

Run:

```bash
node --experimental-strip-types --test tests/unit/latin_speech_units.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/offscreen/latin/speech_units.ts`.

- [ ] **Step 3: Add the language-neutral speech-unit contract**

Create `src/offscreen/speech_unit.ts`:

```ts
export interface SpeechUnit {
	text: string;
	pauseAfterMs: number;
}
```

Delete this interface from `src/offscreen/vietnamese/types.ts` and leave every Vietnamese tokenizer, CRF, normalization, diagnostics, and asset type unchanged:

```ts
export interface SpeechUnit {
	text: string;
	pauseAfterMs: number;
}
```

- [ ] **Step 4: Create the shared Latin-script planner**

Create `src/offscreen/latin/speech_units.ts`:

```ts
import { type BoundaryCandidate, planTextSegments, type SegmentationPolicy } from '../segmentation.ts';
import type { SpeechUnit } from '../speech_unit.ts';

export const LATIN_PAUSE_MS = Object.freeze({
	comma: 60,
	colonOrSemicolon: 90,
	spacedDash: 105,
	sentenceEnd: 165,
	paragraphEnd: 260,
});
export const LATIN_PREFERRED_MIN_LENGTH = 140;
export const LATIN_PREFERRED_CENTER_LENGTH = 190;
export const LATIN_PREFERRED_MAX_LENGTH = 240;
export const LATIN_MAX_UNIT_LENGTH = 300;

type LatinBoundaryKind = 'sentence' | 'semicolon' | 'colon' | 'spacedDash' | 'comma';

const LATIN_SEGMENTATION_POLICY: SegmentationPolicy<LatinBoundaryKind> = Object.freeze({
	preferredMin: LATIN_PREFERRED_MIN_LENGTH,
	preferredCenter: LATIN_PREFERRED_CENTER_LENGTH,
	preferredMax: LATIN_PREFERRED_MAX_LENGTH,
	hardMax: LATIN_MAX_UNIT_LENGTH,
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

const LETTER_PATTERN = /\p{L}/u;
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u;

const PROTECTED_PATTERNS = [
	/https?:\/\/[^\s<>"'“”‘’]+/giu,
	/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu,
	/(?:\d{1,3}\.){3}\d{1,3}/gu,
	/v\d+(?:\.\d+)+/giu,
	/\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/gu,
	/\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/gu,
	/\d+(?:[.,]\d+)*(?:\s?[-–]\s?\d+(?:[.,]\d+)*)?\s?(?:km\/h|m²|m3|%|₫|đ|mm|cm|km|kg|mg|ml|ha|m|g|l)/giu,
	/\p{Lu}+-\d+(?:-\p{Lu}+)*/gu,
] as const;

export function isPredominantlyLatinText(text: string): boolean {
	let letterCount = 0;
	let latinLetterCount = 0;
	for (const character of text) {
		if (!LETTER_PATTERN.test(character)) {
			continue;
		}
		letterCount++;
		if (LATIN_LETTER_PATTERN.test(character)) {
			latinLetterCount++;
		}
	}
	return letterCount > 0 && latinLetterCount / letterCount > 0.5;
}

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

function scanBoundaries(text: string): BoundaryCandidate<LatinBoundaryKind>[] {
	const protectedAt = protectedPositions(text);
	const boundaries: BoundaryCandidate<LatinBoundaryKind>[] = [];
	for (let index = 0; index < text.length; index++) {
		if (protectedAt[index]) {
			continue;
		}
		const character = text[index];
		if (character === ',' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'comma', pauseAfterMs: LATIN_PAUSE_MS.comma });
		} else if (character === ':' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'colon', pauseAfterMs: LATIN_PAUSE_MS.colonOrSemicolon });
		} else if (character === ';' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))) {
			boundaries.push({ end: index + 1, kind: 'semicolon', pauseAfterMs: LATIN_PAUSE_MS.colonOrSemicolon });
		} else if ('-–—'.includes(character) && /\s/u.test(text[index - 1] ?? '') && /\s/u.test(text[index + 1] ?? '')) {
			boundaries.push({ end: index + 1, kind: 'spacedDash', pauseAfterMs: LATIN_PAUSE_MS.spacedDash });
		} else if (
			/[.!?…]/u.test(character) &&
			!(character === '.' && /\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''))
		) {
			let end = index + 1;
			while (text[end] === '.') {
				end++;
			}
			boundaries.push({ end, kind: 'sentence', pauseAfterMs: LATIN_PAUSE_MS.sentenceEnd });
			index = end - 1;
		}
	}
	return boundaries;
}

function planParagraph(text: string, paragraphPauseAfterMs: number): SpeechUnit[] {
	const boundaries = scanBoundaries(text);
	const trailingBoundary = boundaries.at(-1);
	const trailingPauseAfterMs = trailingBoundary?.end === text.length ? trailingBoundary.pauseAfterMs : 0;
	return planTextSegments(text, boundaries, LATIN_SEGMENTATION_POLICY, Math.max(trailingPauseAfterMs, paragraphPauseAfterMs));
}

export function planLatinSpeechUnits(text: string): SpeechUnit[] {
	const paragraphs = text
		.normalize('NFC')
		.split(/\n[\t ]*\n+/u)
		.map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
		.filter(Boolean);
	const units: SpeechUnit[] = [];
	for (let index = 0; index < paragraphs.length; index++) {
		units.push(...planParagraph(paragraphs[index], index < paragraphs.length - 1 ? LATIN_PAUSE_MS.paragraphEnd : 0));
	}
	return units;
}
```

Delete `src/offscreen/vietnamese/speech_units.ts`; do not leave a second policy or compatibility re-export.

- [ ] **Step 5: Update imports and planner names without changing routing yet**

In `src/offscreen/playback_preparation.ts`, use:

```ts
import { planLatinSpeechUnits } from './latin/speech_units.ts';
import type { SpeechUnit } from './speech_unit.ts';
import type { NormalizationResult } from './vietnamese/types.ts';
```

Replace every `planSpeechUnits(...)` call with `planLatinSpeechUnits(...)`; keep the existing Vietnamese-only routing and numeric compatibility pause until Task 3.

In `src/offscreen/audio.ts`, replace the type import with:

```ts
import type { SpeechUnit } from './speech_unit.ts';
```

In `src/offscreen/offscreen.ts`, replace the `SpeechUnit` import with:

```ts
import type { SpeechUnit } from './speech_unit';
```

- [ ] **Step 6: Run the planner test and production build**

Run:

```bash
node --experimental-strip-types --test tests/unit/latin_speech_units.test.ts
pnpm build
```

Expected: the focused planner tests PASS; TypeScript and the production bundle build successfully with no remaining import of `vietnamese/speech_units` or `SpeechUnit` from `vietnamese/types`.

- [ ] **Step 7: Commit the generalized planner**

```bash
git add -A -- src/offscreen/speech_unit.ts src/offscreen/latin/speech_units.ts src/offscreen/vietnamese/speech_units.ts src/offscreen/vietnamese/types.ts src/offscreen/playback_preparation.ts src/offscreen/audio.ts src/offscreen/offscreen.ts tests/unit/latin_speech_units.test.ts tests/unit/vietnamese_speech_units.test.ts
git commit -m "Generalize Latin speech unit planner"
```

### Task 2: Apply explicit pauses to every weighted Latin unit

**Files:**
- Modify: `src/offscreen/speech_unit.ts`
- Modify: `src/offscreen/audio.ts`
- Modify: `src/offscreen/offscreen.ts`
- Modify: `tests/unit/offscreen_audio.test.ts`

**Interfaces:**
- Consumes: the numeric `SpeechUnit.pauseAfterMs` contract from Task 1.
- Produces: `SpeechUnit.pauseAfterMs: number | null`, where null selects engine-managed compatibility silence.
- Preserves: `synthesizeSpeechUnitSamples(unit, lang, speed, sampleRate, synthesize): Promise<Float32Array>`.
- Numeric pause: call synthesis with `silenceDuration = 0`, then append the rounded explicit silence.
- Null pause: call synthesis with `silenceDuration = 0.3`, then return samples without appending another pause.

- [ ] **Step 1: Write the failing explicit-versus-engine pause tests**

Replace `tests/unit/offscreen_audio.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSilenceSamples, synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';

test('appends the requested silence without changing waveform samples', () => {
	const output = appendSilenceSamples(new Float32Array([0.25, -0.5]), 1_000, 80);
	assert.equal(output.length, 82);
	assert.deepEqual(Array.from(output.slice(0, 2)), [0.25, -0.5]);
	assert.ok(output.slice(2).every((sample) => sample === 0));
});

test('uses zero internal silence and appends a numeric Latin pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'Hello.', pauseAfterMs: 60 }, 'en', 1.15, 1_000, async (...args) => {
		calls.push(args);
		return [0.5];
	});
	assert.deepEqual(calls, [['Hello.', 'en', 8, 1.15, 0]]);
	assert.equal(output.length, 61);
});

test('treats numeric zero as an explicit pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'No punctuation', pauseAfterMs: 0 }, 'fr', 1, 1_000, async (...args) => {
		calls.push(args);
		return [0.25];
	});
	assert.deepEqual(calls, [['No punctuation', 'fr', 8, 1, 0]]);
	assert.deepEqual(Array.from(output), [0.25]);
});

test('uses engine silence without appending for a null compatibility pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: '中文内容', pauseAfterMs: null }, 'zh', 1.05, 1_000, async (...args) => {
		calls.push(args);
		return [0.75, -0.25];
	});
	assert.deepEqual(calls, [['中文内容', 'zh', 8, 1.05, 0.3]]);
	assert.deepEqual(Array.from(output), [0.75, -0.25]);
});

test('forwards Vietnamese and appends its existing explicit pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'xin chào', pauseAfterMs: 80 }, 'vi', 1.15, 1_000, async (...args) => {
		calls.push(args);
		return [0.5];
	});
	assert.deepEqual(calls, [['xin chào', 'vi', 8, 1.15, 0]]);
	assert.equal(output.length, 81);
});

test('returns a copy for zero silence and validates numeric inputs', () => {
	const input = new Float32Array([1]);
	const output = appendSilenceSamples(input, 24_000, 0);
	assert.notEqual(output, input);
	assert.deepEqual(output, input);
	for (const sampleRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => appendSilenceSamples(input, sampleRate, 1), /sample rate/);
	}
	for (const pause of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => appendSilenceSamples(input, 24_000, pause), /pause/);
	}
});
```

- [ ] **Step 2: Run the audio test and verify null pause handling fails**

Run:

```bash
node --experimental-strip-types --test tests/unit/offscreen_audio.test.ts
```

Expected: FAIL because null compatibility units still pass internal silence `0` and are sent to `appendSilenceSamples()` as a non-numeric pause.

- [ ] **Step 3: Widen the pause contract and generalize the audio helper**

Replace `src/offscreen/speech_unit.ts` with:

```ts
export interface SpeechUnit {
	text: string;
	pauseAfterMs: number | null;
}
```

Keep `appendSilenceSamples()` and `SpeechSynthesisCall` unchanged. Replace only `synthesizeSpeechUnitSamples()` in `src/offscreen/audio.ts`:

```ts
export async function synthesizeSpeechUnitSamples(
	unit: SpeechUnit,
	lang: string,
	speed: number,
	sampleRate: number,
	synthesize: SpeechSynthesisCall,
): Promise<Float32Array> {
	const internalSilence = unit.pauseAfterMs === null ? 0.3 : 0;
	const wav = await synthesize(unit.text, lang, 8, speed, internalSilence);
	const samples = wav instanceof Float32Array ? wav : Float32Array.from(wav);
	return appendSilenceSamples(samples, sampleRate, unit.pauseAfterMs ?? 0);
}
```

- [ ] **Step 4: Use the generalized helper for every offscreen synthesis unit**

Replace the language branch inside `synthesizeUnit()` in `src/offscreen/offscreen.ts` with:

```ts
const wav = await synthesizeSpeechUnitSamples(
	unit,
	lang,
	speed,
	ttsEngine.sampleRate,
	async (text, requestedLang, steps, requestedSpeed, silenceDuration) => {
		const result = await ttsEngine?.call(text, requestedLang, style, steps, requestedSpeed, silenceDuration);
		if (!result) {
			throw new Error('TTS Engine is not initialized');
		}
		return result.wav;
	},
);
```

Leave sample-rate selection, WAV encoding, audio decoding, `SynthesisInput`, `IndexedSynthesisCoordinator`, and every playback guard unchanged.

- [ ] **Step 5: Run audio, planner, coordinator, and build checks**

Run:

```bash
node --experimental-strip-types --test tests/unit/offscreen_audio.test.ts tests/unit/latin_speech_units.test.ts tests/unit/synthesis_coordinator.test.ts
pnpm build
```

Expected: all focused tests PASS; TypeScript and the production extension bundle build successfully.

- [ ] **Step 6: Commit explicit Latin pause synthesis**

```bash
git add src/offscreen/speech_unit.ts src/offscreen/audio.ts src/offscreen/offscreen.ts tests/unit/offscreen_audio.test.ts
git commit -m "Apply explicit pauses to Latin speech units"
```

### Task 3: Route Vietnamese and predominantly Latin text with explicit pause metadata

**Files:**
- Modify: `src/offscreen/playback_preparation.ts`
- Modify: `src/offscreen/offscreen.ts`
- Modify: `tests/unit/playback_preparation.test.ts`

**Interfaces:**
- Consumes: `isPredominantlyLatinText(text)` and `planLatinSpeechUnits(text)` from Task 1.
- Consumes: `SpeechUnit.pauseAfterMs: number | null` from Task 2.
- Produces: `isVietnameseLanguage(lang: string): boolean` for preparation routing and Vietnamese asset loading.
- Preserves: `preparePlaybackUnits(text, lang, normalizer): Promise<SpeechUnit[]>`.

- [ ] **Step 1: Replace the preparation tests with the failing routing matrix**

Replace `tests/unit/playback_preparation.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isVietnameseLanguage, preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';

const diagnostics = {
	tokenCount: 3,
	crfMs: 0,
	expansionMs: 0,
	totalMs: 0,
	usedCrf: true,
	usedAbbreviationScorer: false,
};

test('recognizes Vietnamese primary language subtags', () => {
	for (const lang of ['vi', 'VI', 'vi-VN', 'VI-latn-VN', 'vi_VN']) {
		assert.equal(isVietnameseLanguage(lang), true, lang);
	}
	for (const lang of ['', 'en', 'x-vi', 'viet']) {
		assert.equal(isVietnameseLanguage(lang), false, lang);
	}
});

test('normalizes Vietnamese BCP-47 variants once and plans explicit pauses', async () => {
	for (const lang of ['vi', 'vi-VN']) {
		let calls = 0;
		const units = await preparePlaybackUnits('ĐH mở cửa.', lang, {
			async normalize() {
				calls++;
				return { text: 'đại học mở cửa.', diagnostics };
			},
		});
		assert.equal(calls, 1);
		assert.deepEqual(units, [{ text: 'đại học mở cửa.', pauseAfterMs: 165 }]);
	}
});

test('uses weighted units for Latin text despite missing or inaccurate language tags', async () => {
	let calls = 0;
	const normalizer = {
		async normalize() {
			calls++;
			throw new Error('must not run');
		},
	};
	for (const lang of ['en', 'na', 'zh', '']) {
		assert.deepEqual(await preparePlaybackUnits('First sentence. Second sentence.', lang, normalizer), [
			{ text: 'First sentence. Second sentence.', pauseAfterMs: 165 },
		]);
	}
	assert.equal(calls, 0);
});

test('uses weighted units for accented Latin languages', async () => {
	for (const [lang, text] of [
		['fr', 'Déjà vu. Très bien.'],
		['de', 'Größere Übung. Alles gut.'],
		['es', 'Corazón español. Muy bien.'],
		['pl', 'Zażółć gęślą jaźń. Dobrze.'],
	] as const) {
		assert.deepEqual(await preparePlaybackUnits(text, lang, null), [{ text, pauseAfterMs: 165 }]);
	}
});

test('keeps non-Latin and exact-half text on engine-managed compatibility pauses', async () => {
	for (const text of ['中文内容。', 'Русский текст.', 'نص عربي.', 'ab中文', '123 😀 !!!']) {
		assert.deepEqual(await preparePlaybackUnits(text, 'unknown', null), [{ text, pauseAfterMs: null }]);
	}
});

test('fails open to explicit units from the exact original Vietnamese text', async () => {
	const units = await preparePlaybackUnits('Một câu, vẫn đọc được.', 'vi', {
		async normalize() {
			throw new Error('expected failure');
		},
	});
	assert.deepEqual(units, [{ text: 'Một câu, vẫn đọc được.', pauseAfterMs: 165 }]);
});

test('returns identical units for identical selected and article text', async () => {
	const text = 'Nội dung giống nhau.';
	const normalizer = {
		async normalize() {
			return { text, diagnostics };
		},
	};
	assert.deepEqual(await preparePlaybackUnits(text, 'vi', normalizer), await preparePlaybackUnits(text, 'vi', normalizer));
});

test('does not return empty units when normalization yields whitespace', async () => {
	const units = await preparePlaybackUnits('Vẫn phải đọc.', 'vi', {
		async normalize() {
			return { text: ' \n\n ', diagnostics };
		},
	});
	assert.deepEqual(units, [{ text: 'Vẫn phải đọc.', pauseAfterMs: 165 }]);
});
```

- [ ] **Step 2: Run the preparation test and verify routing expectations fail**

Run:

```bash
node --experimental-strip-types --test tests/unit/playback_preparation.test.ts
```

Expected: FAIL because `isVietnameseLanguage` is not exported, `vi-VN` does not normalize, and non-Vietnamese units still use compatibility pause zero.

- [ ] **Step 3: Implement primary-language and Latin-script routing**

Replace `src/offscreen/playback_preparation.ts` with:

```ts
import { isPredominantlyLatinText, planLatinSpeechUnits } from './latin/speech_units.ts';
import type { SpeechUnit } from './speech_unit.ts';
import { chunkText } from './supertonic_helper.ts';
import type { NormalizationResult } from './vietnamese/types.ts';

export interface VietnameseTextNormalizer {
	normalize(text: string): Promise<NormalizationResult>;
}

export function isVietnameseLanguage(lang: string): boolean {
	return /^vi(?:$|[-_])/iu.test(lang.trim());
}

function compatibilityUnits(text: string, pauseAfterMs: number | null): SpeechUnit[] {
	return chunkText(text, 200)
		.map((unit) => unit.trim())
		.filter(Boolean)
		.map((unit) => ({ text: unit, pauseAfterMs }));
}

function plannedUnits(text: string, fallbackPauseAfterMs: number | null): SpeechUnit[] {
	try {
		const units = planLatinSpeechUnits(text).filter(({ text: unit }) => unit.trim().length > 0);
		return units.length > 0 ? units : compatibilityUnits(text, fallbackPauseAfterMs);
	} catch {
		return compatibilityUnits(text, fallbackPauseAfterMs);
	}
}

function vietnameseFallback(text: string): SpeechUnit[] {
	return plannedUnits(text, 0);
}

export async function preparePlaybackUnits(text: string, lang: string, normalizer: VietnameseTextNormalizer | null): Promise<SpeechUnit[]> {
	if (!isVietnameseLanguage(lang)) {
		return isPredominantlyLatinText(text) ? plannedUnits(text, null) : compatibilityUnits(text, null);
	}
	if (!normalizer) {
		return vietnameseFallback(text);
	}
	try {
		const result = await normalizer.normalize(text);
		const units = planLatinSpeechUnits(result.text).filter(({ text: unit }) => unit.trim().length > 0);
		return units.length > 0 ? units : vietnameseFallback(text);
	} catch {
		return vietnameseFallback(text);
	}
}
```

- [ ] **Step 4: Reuse the Vietnamese-language helper for asset loading**

In `src/offscreen/offscreen.ts`, change the preparation import to:

```ts
import { isVietnameseLanguage, preparePlaybackUnits, VietnameseTextNormalizer } from './playback_preparation';
```

Replace only the normalizer asset gate:

```ts
let normalizer: VietnameseTextNormalizer | null = null;
if (isVietnameseLanguage(article.lang)) {
	const assets = await loadVietnameseNormalizerAssets();
	normalizer = {
		normalize: (text) => normalizeVietnameseText(text, { assets, now: () => performance.now() }),
	};
}
```

- [ ] **Step 5: Run focused routing tests and build**

Run:

```bash
node --experimental-strip-types --test tests/unit/playback_preparation.test.ts tests/unit/latin_speech_units.test.ts
pnpm build
```

Expected: all focused tests PASS; TypeScript and the production extension bundle build successfully.

- [ ] **Step 6: Commit the routing behavior**

```bash
git add src/offscreen/playback_preparation.ts src/offscreen/offscreen.ts tests/unit/playback_preparation.test.ts
git commit -m "Route Latin text through weighted speech units"
```

### Task 4: Complete repository verification and close the design status

**Files:**
- Modify: `_docs/specs/2026-07-15-latin-script-speech-segmentation-design.md`
- Modify: `_docs/plans/2026-07-15-latin-script-speech-segmentation.md`
- Verify only: `dist/manifest.json`
- Preserve: `context_improvement.md`
- Preserve until final review: `.tmp/sdd/`

**Interfaces:**
- Consumes: completed Tasks 1 through 3.
- Produces: a verified extension build whose manifest and playback regressions remain within the approved Free-extension boundary.
- Produces: an honest design status that distinguishes automated completion from pending focused listening.

- [ ] **Step 1: Run the complete unit suite**

Run:

```bash
pnpm test:unit
```

Expected: all unit tests PASS with zero failures, including Latin classification, preparation routing, explicit audio pauses, indexed synthesis, and existing Vietnamese normalization coverage.

- [ ] **Step 2: Run formatting and static checks on the touched TypeScript files**

Run:

```bash
pnpm exec biome check src/offscreen/speech_unit.ts src/offscreen/latin/speech_units.ts src/offscreen/vietnamese/types.ts src/offscreen/playback_preparation.ts src/offscreen/audio.ts src/offscreen/offscreen.ts tests/unit/latin_speech_units.test.ts tests/unit/playback_preparation.test.ts tests/unit/offscreen_audio.test.ts
pnpm exec tsc --noEmit
git diff --check
```

Expected: Biome reports no diagnostics; TypeScript exits successfully; Git reports no whitespace errors.

- [ ] **Step 3: Build and validate the production manifest**

Run:

```bash
CI=true pnpm build
pnpm validate:manifest
```

Expected: the production build succeeds and `dist/manifest.json` passes the checked-in Free-manifest validator without new permissions or hosts.

- [ ] **Step 4: Run the full extension E2E suite**

Run:

```bash
CI=true pnpm test:e2e
```

Expected: every Playwright test passes, including reading-state coverage that rejects duplicate/replayed units during loading, prefetch, speed changes, and session replacement.

- [ ] **Step 5: Record automated completion without claiming unperformed listening**

In `_docs/specs/2026-07-15-latin-script-speech-segmentation-design.md`, replace the status line only after Steps 1 through 4 pass:

```markdown
**Status:** Implemented; automated verification passed; focused multilingual listening pending
```

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 6: Commit verified documentation status**

```bash
git add _docs/specs/2026-07-15-latin-script-speech-segmentation-design.md _docs/plans/2026-07-15-latin-script-speech-segmentation.md
git commit -m "Record Latin segmentation verification"
```

- [ ] **Step 7: Confirm final task scope while preserving review artifacts**

Run:

```bash
git status --short --branch
git log -5 --oneline
```

Expected: tracked files are clean; `.tmp/sdd/` remains available for task and final review; `context_improvement.md` remains untouched in the parent checkout; the task commits appear at the top of the feature branch. The controller removes the worktree and parent `.tmp/` only after all reviews and integration finish.

## Focused listening follow-up

Automated completion does not replace a listening pass. Use Vietnamese, English, French, German, Spanish, and Polish samples containing long sentences, consecutive short sentences, commas, semicolons, colons, spaced dashes, and paragraph breaks. Record whether a defect is an incorrect boundary pause, a repeated whole unit, or an acoustic repetition inside one synthesized buffer; do not alter indexed playback code to compensate for an acoustic-model issue.
