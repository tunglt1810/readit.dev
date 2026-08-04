# Language-based Speed Defaults, Consolidation & Audio Truncation Fix Implementation Plan (TDD)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement language-based default speed settings (`1.5` for Vietnamese `vi`, `1.1` fallback for other languages), apply short-segment consolidation (< 20 non-whitespace chars) and unpunctuated line handling uniformly across all languages, and eliminate end-of-line audio truncation on English text using strict Test-Driven Development (TDD).

**Architecture:**
1. Export `getDefaultSpeedForLanguage(lang?: string): number` in `src/shared/constants.ts` (`1.5` for `vi`, `1.1` fallback for others) and integrate it into `src/background/background.ts` session initialization and UI speed components.
2. Ensure `preparePlaybackUnits` in `src/offscreen/playback_preparation.ts` runs `consolidateShortSpeechUnits` across all languages and ensures unpunctuated speech units receive proper synthesis period/space formatting.
3. Add acoustic tail padding (`ACOUSTIC_TAIL_PADDING_MS = 60`) in `src/offscreen/audio.ts` and tail token space padding in `src/offscreen/supertonic_helper.ts` so ONNX duration predictor/vocoder allocates sufficient decay frames and playback never truncates final phonemes.

**Tech Stack:** TypeScript, Node Test Runner (`node:test`, `node:assert/strict`), React, Chrome Extension MV3, ONNX Runtime Web.

## Global Constraints

- Vietnamese (`vi`, `vi-VN`) default speed: `1.5` (`DEFAULT_VIETNAMESE_SPEED`)
- Fallback default speed for all other languages (`en`, `ko`, `ja`, etc.): `1.1` (`DEFAULT_FALLBACK_SPEED`)
- Short segment threshold: `< 20` non-whitespace characters (`MIN_RELIABLE_SYNTHESIS_CHARACTERS = 20`)
- Acoustic tail padding duration: `60ms` (`ACOUSTIC_TAIL_PADDING_MS = 60`)
- Shell commands: MUST start with leading space character and use `BypassSandbox: true` for `pnpm test:unit` if permission issues occur
- Target plan location: `docs/plans/2026-08-04-language-speed-defaults-and-consolidation.md`
- Target spec location: `docs/specs/2026-08-04-language-speed-defaults-and-consolidation.md`
- NO `git commit` commands in steps

---

### Task 1: Language-based Default Speed Resolution & Synchronization (TDD)

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/background/background.ts`
- Modify: `src/popup/App.tsx`
- Modify: `src/reader/App.tsx`
- Modify: `src/sidepanel/App.tsx`
- Create: `tests/unit/language_speed_defaults.test.ts`

**Interfaces:**
- Produces: `getDefaultSpeedForLanguage(lang?: string): number` in `src/shared/constants.ts`
- Consumes: `getDefaultSpeedForLanguage` in `background.ts` session initialization when no user custom speed preference exists.

- [ ] **Step 1: Write failing unit test for `getDefaultSpeedForLanguage`**

Create `tests/unit/language_speed_defaults.test.ts`:
```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FALLBACK_SPEED, DEFAULT_VIETNAMESE_SPEED, getDefaultSpeedForLanguage } from '../../src/shared/constants.ts';

test('getDefaultSpeedForLanguage returns 1.5 for Vietnamese primary subtags and variants', () => {
	assert.equal(DEFAULT_VIETNAMESE_SPEED, 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi-VN'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('VI'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('vi-latn-VN'), 1.5);
	assert.equal(getDefaultSpeedForLanguage('  vi_VN '), 1.5);
});

test('getDefaultSpeedForLanguage returns 1.1 for fallback and non-Vietnamese languages', () => {
	assert.equal(DEFAULT_FALLBACK_SPEED, 1.1);
	assert.equal(getDefaultSpeedForLanguage('en'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('ko'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('ja'), 1.1);
	assert.equal(getDefaultSpeedForLanguage('fr'), 1.1);
	assert.equal(getDefaultSpeedForLanguage(undefined), 1.1);
	assert.equal(getDefaultSpeedForLanguage(''), 1.1);
});
```

- [ ] **Step 2: Run unit test to verify RED state (failing)**

Run: ` pnpm test:unit`
Expected: FAIL with `getDefaultSpeedForLanguage is not defined` or assertion error.

- [ ] **Step 3: Implement `getDefaultSpeedForLanguage` in `src/shared/constants.ts` and update `background.ts`**

In `src/shared/constants.ts`:
```ts
export const DEFAULT_FALLBACK_SPEED = 1.1;
export const DEFAULT_VIETNAMESE_SPEED = 1.5;
export const DEFAULT_SPEED = DEFAULT_FALLBACK_SPEED;

export function getDefaultSpeedForLanguage(lang?: string): number {
	if (typeof lang === 'string' && /^vi(?:$|[-_])/iu.test(lang.trim())) {
		return DEFAULT_VIETNAMESE_SPEED;
	}
	return DEFAULT_FALLBACK_SPEED;
}
```

In `src/background/background.ts`:
1. Import `getDefaultSpeedForLanguage` from `../shared/constants.ts`.
2. Update session initialization (around lines 828-833):
```ts
const speed = isFiniteNumber(storedSpeed) ? storedSpeed : getDefaultSpeedForLanguage(input.content.lang);
```
3. Update `publishExtractionFailure` (line 454) to use `getDefaultSpeedForLanguage(undefined)`.

In `src/popup/App.tsx`, `src/reader/App.tsx`, `src/sidepanel/App.tsx`:
Update default speed state initialization to use `getDefaultSpeedForLanguage(session?.lang)`.

- [ ] **Step 4: Run unit test to verify GREEN state (passing)**

Run: ` pnpm test:unit`
Expected: PASS with 0 failures across all unit test suites.

---

### Task 2: Cross-Language Short Segment Consolidation & Unpunctuated Line Formatting (TDD)

**Files:**
- Modify: `src/offscreen/playback_preparation.ts`
- Modify: `src/offscreen/short_segment_consolidation.ts`
- Test: `tests/unit/playback_preparation.test.ts`

**Interfaces:**
- Consumes: `consolidateShortSpeechUnits(units, lang)`
- Produces: Updated `preparePlaybackUnits` that consolidates short units across all language inputs (`en`, `vi`, `ko`, `ja`, etc.) and formats unpunctuated headings/lines with period `.`.

- [ ] **Step 1: Write failing unit test for English short segment consolidation & line ending formatting**

In `tests/unit/playback_preparation.test.ts`:
Add a test verifying English text with short lines and list items:
```ts
test('consolidates short English lines into merged speech units with proper sentence punctuation', async () => {
	const text = `DATA STRATEGY\n\nData & Analytics Enablement for Business Growth\n\n1. Purpose\n\nThe Data Strategy provides the analytics and decision-support capabilities.`;
	const units = await preparePlaybackUnits(text, 'en', null);
	assert.ok(units.length < 4, `Expected fewer than 4 units due to consolidation, got ${units.length}`);
	assert.ok(units[0].synthesisText?.includes('DATA STRATEGY.') || units[0].text.includes('DATA STRATEGY.'));
});

test('formats unpunctuated line items with terminal period in synthesisText', async () => {
	const text = `monitor performance across Personal, Private, Corporate and Intermediaries segments`;
	const units = await preparePlaybackUnits(text, 'en', null);
	assert.equal(units.length, 1);
	assert.equal(units[0].synthesisText ?? units[0].text, 'monitor performance across Personal, Private, Corporate and Intermediaries segments.');
});
```

- [ ] **Step 2: Run unit test to verify RED state (failing)**

Run: ` pnpm test:unit`
Expected: FAIL due to unconsolidated short units or missing synthesisText period formatting.

- [ ] **Step 3: Implement fix in `playback_preparation.ts` & `short_segment_consolidation.ts`**

In `src/offscreen/playback_preparation.ts`:
Ensure `preparePlaybackUnits` calls `consolidateShortSpeechUnits` on planned units for all non-Vietnamese inputs. Ensure unpunctuated single-line units receive `synthesisText` ending with `.` when `pauseAfterMs > 0`.

In `src/offscreen/short_segment_consolidation.ts`:
Verify `renderingTextForMerge` appends period `.` when `left` does not end with natural terminal cadence.

- [ ] **Step 4: Run unit test to verify GREEN state (passing)**

Run: ` pnpm test:unit`
Expected: PASS with 0 failures across all unit test suites.

---

### Task 3: Acoustic Tail Silence Padding & Audio Truncation Fix (TDD)

**Files:**
- Modify: `src/offscreen/audio.ts`
- Modify: `src/offscreen/supertonic_helper.ts`
- Test: `tests/unit/offscreen_audio.test.ts`

**Interfaces:**
- Consumes: `synthesizeSpeechUnitSamples`, `createSpeechAudioBuffer`
- Produces: `AudioBuffer` containing `ACOUSTIC_TAIL_PADDING_MS = 60` (60ms zero-sample padding) preventing end-of-line audio truncation on Web Audio API playback.

- [ ] **Step 1: Write failing unit test for acoustic tail padding in `tests/unit/offscreen_audio.test.ts`**

In `tests/unit/offscreen_audio.test.ts`:
Add test checking that synthesized speech samples receive an additional acoustic tail margin (`60ms` = `Math.round(sampleRate * 0.06)` samples):
```ts
test('appends acoustic tail padding to prevent end-of-line word truncation', async () => {
	const sampleRate = 24000;
	const dummySamples = new Float32Array(2400); // 100ms
	const pauseAfterMs = 180;
	const buffer = createSpeechAudioBuffer(mockAudioContext, dummySamples, sampleRate, pauseAfterMs);
	const expectedTailSamples = Math.round(sampleRate * 0.06); // 60ms acoustic tail padding
	const expectedPauseSamples = Math.round((sampleRate * pauseAfterMs) / 1000);
	const expectedTotalLength = dummySamples.length + expectedTailSamples + expectedPauseSamples;
	assert.equal(buffer.length, expectedTotalLength);
});
```

- [ ] **Step 2: Run unit test to verify RED state (failing)**

Run: ` pnpm test:unit`
Expected: FAIL with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal` due to missing 60ms tail padding.

- [ ] **Step 3: Implement acoustic tail padding in `src/offscreen/audio.ts` & `supertonic_helper.ts`**

In `src/offscreen/audio.ts`:
1. Define `export const ACOUSTIC_TAIL_PADDING_MS = 60;`.
2. In `createSpeechAudioBuffer`:
```ts
export function createSpeechAudioBuffer(
	audioCtx: AudioBufferFactory,
	samples: Float32Array,
	sampleRate: number,
	pauseAfterMs: number,
): AudioBuffer {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError('sample rate must be positive and finite');
	}
	if (!Number.isFinite(pauseAfterMs) || pauseAfterMs < 0) {
		throw new RangeError('pause must be non-negative and finite');
	}
	const acousticTailSamples = Math.round((sampleRate * ACOUSTIC_TAIL_PADDING_MS) / 1_000);
	const silenceSamples = Math.round((sampleRate * pauseAfterMs) / 1_000);
	const buffer = audioCtx.createBuffer(1, samples.length + acousticTailSamples + silenceSamples, sampleRate);
	buffer.getChannelData(0).set(samples);
	return buffer;
}
```

In `src/offscreen/supertonic_helper.ts`:
In `UnicodeProcessor.preprocessText`:
Ensure that when wrapping text in language tags `<${lang}>${text}</${lang}>`, if text ends with punctuation, a trailing space is added before `</${lang}>` (e.g. `<${lang}>${text} </${lang}>`) so ONNX duration predictor allocates tail frames for acoustic decay.

- [ ] **Step 4: Run unit test to verify GREEN state (passing)**

Run: ` pnpm test:unit`
Expected: PASS with 0 failures across all 490+ unit tests.

---

## Verification Plan

### Automated Tests
Run full unit test suite:
```bash
 pnpm test:unit
```
Verify that all tests pass without errors or regressions.

### Manual Verification
1. Load extension in Chrome.
2. Select or open an English article containing unpunctuated headings and bullet lists (e.g., the `DATA STRATEGY` sample text).
3. Play audio and verify:
   - Speed defaults to `1.1` for English.
   - Headings `DATA STRATEGY` and `1. Purpose` are consolidated cleanly into sentence units.
   - Final words of each line ("segments", "mix", "profitability", "productivity", "monitoring", "reporting") are spoken completely without any syllable truncation or cut-off.
4. Open a Vietnamese article (`vi`) and verify:
   - Speed defaults to `1.5`.
   - Speed control UI updates smoothly and stays in sync across Popup, Reader, and Sidepanel.
