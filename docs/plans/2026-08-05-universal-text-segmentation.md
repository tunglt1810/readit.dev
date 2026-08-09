# Universal Text Segmentation & Short Chunk Fusion Implementation Plan (TDD)

> **For agentic workers:** Execute tasks in order. Keep every implementation change test-driven, run the focused test after each GREEN step, and do not change the 300/120 synthesis-capacity policy.

**Goal:** Implement one source-neutral, capacity-safe offscreen text-segmentation pipeline that preserves canonical text and word-map integrity, plans complete sentences first, safely splits only exceptional oversized sentences, and globally optimizes legal adjacent short-unit fusion.

**Specification:** `docs/specs/2026-08-05-universal-text-segmentation-design.md`

## Architecture and constraints

- Normalize Article, Selected Text, PDF, and Playlist Item input before language-specific planning: NFC; CRLF/CR to LF; classify blank-line runs and sentence-terminal single breaks as hard paragraph metadata; turn all other line breaks into spaces; collapse whitespace in Canonical Text.
- Keep hard-boundary metadata planning-only. It drives paragraph pause ownership but does not appear in `SpeechUnit.text` and does not block an otherwise feasible merge.
- `text` remains Canonical Text; `synthesisText ?? text` is Final Rendering. Attach Word Maps only after consolidation, index them only against `text`, and never map synthetic rendering punctuation.
- `synthesisTextLimitForLanguage()` remains the shared authority: **300 UTF-16 code units** for Latin/Vietnamese and **120** for `ko`/`ja`. Measure with JavaScript `string.length`; do not introduce or propose 400.
- Only an oversized single sentence may split internally. Priority is rightmost safe semicolon, colon, spaced dash, comma, then last safe whitespace; Protected Forms and UTF-16 surrogate pairs are never split.
- Fusion may partition only consecutive Source Units. It must preserve source order and minimize: (1) independently mergeable short outputs, (2) maximum Final Rendering length among genuinely merged outputs, then (3) one-based end-index and start-index vectors lexicographically.
- Use fixed regressions plus deterministic seeded generators. Avoid adding a property-test dependency; use a documented local seeded PRNG and exhaustive oracle for small generated inputs.

---

### Task 1: Define source-neutral normalization and planning-only boundary metadata (TDD)

**Files:**
- Create: `src/offscreen/text_normalization.ts`
- Modify: `src/offscreen/playback_preparation.ts`
- Modify: `src/offscreen/latin/speech_units.ts`
- Create: `tests/unit/text_normalization.test.ts`
- Modify: `tests/unit/playback_preparation.test.ts`

- [ ] **1.1 Write failing normalization tests.** Cover NFC composition; CRLF and CR conversion; blank-line runs taking precedence; single sentence-terminal line breaks becoming hard boundaries; ordinary wraps becoming soft breaks; whitespace collapse; metadata persistence after collapsing to spaces; and all-whitespace input yielding no planned units, maps, or synthesis calls.
- [ ] **1.2 Add a pure normalizer.** Export a result type containing normalized planning text and immutable hard-boundary positions/ranges. Classify boundaries before whitespace collapse; retain enough canonical-offset information to apply 260 ms paragraph cadence after sentence planning. Keep metadata internal to planning and exclude it from `SpeechUnit.text`.
- [ ] **1.3 Integrate the normalizer once.** Make `preparePlaybackUnits` normalize all source text before the Latin, Vietnamese, Korean/Japanese, or compatibility path. Preserve boundary metadata through Vietnamese normalized-text planning rather than allowing the source path to select its own newline policy.
- [ ] **1.4 Verify GREEN.** Run `pnpm test:unit -- text_normalization playback_preparation latin_speech_units` (or the repository-supported focused equivalent). Assert identical results for logically equivalent source-path fixtures.

### Task 2: Make Final Rendering capacity a shared guard (TDD)

**Files:**
- Modify: `src/offscreen/supertonic_helper.ts`
- Modify: `src/offscreen/playback_preparation.ts`
- Modify: `src/offscreen/audio.ts`
- Modify: `tests/unit/playback_preparation.test.ts`
- Modify: `tests/unit/offscreen_audio.test.ts`
- Create: `tests/unit/synthesis_capacity_guard.test.ts`

- [ ] **2.1 Write failing capacity tests.** Assert `synthesisTextLimitForLanguage()` returns 300 for Latin/Vietnamese and 120 for `ko`/`ja`; verify exact-boundary acceptance and one-unit-over rejection using Final Rendering rather than `text`; include a merge whose synthetic period causes an overrun.
- [ ] **2.2 Centralize a Final Rendering accessor and deterministic capacity error.** Reuse `synthesisTextLimitForLanguage(language)` rather than duplicate constants. The guard measures `unit.synthesisText ?? unit.text` using `.length`, reports a stable error/result, does not mutate the unit, and makes no engine call after failure.
- [ ] **2.3 Guard all boundaries.** Validate planned units and consolidation candidates in preparation, retain the guard in the engine helper as capacity authority, and call the final guard in `synthesizeSpeechUnitSamples` immediately before `synthesize`.
- [ ] **2.4 Verify GREEN.** Run the three focused suites and confirm 300/120 tests, compatibility behavior, and no-request failure isolation pass. Do not change engine capacity to 400.

### Task 3: Implement sentence-first segmentation and safe ordered fallback (TDD)

**Files:**
- Modify: `src/offscreen/segmentation.ts`
- Modify: `src/offscreen/latin/speech_units.ts`
- Modify: `tests/unit/segmentation.test.ts`
- Modify: `tests/unit/latin_speech_units.test.ts`

- [ ] **3.1 Replace obsolete weighted-boundary expectations.** Add failing tests proving that a fitting sentence remains intact despite commas/whitespace and that only complete adjacent sentences are aggregated in source order. Keep useful sentence-pause regressions.
- [ ] **3.2 Expand protected-span coverage.** Test URLs, email, IPv4, semantic version, `ABC-123`, dates/times/decimals/ranges/currency/percent/unit expressions, initialisms/abbreviations, and `IRGC`, `AFP`, `CNN`, `TP.HCM`, `VnExpress`, and `PGS.TS`. Test safe candidates immediately outside protected spans and UTF-16 surrogate-pair boundaries.
- [ ] **3.3 Implement sentence-first planning.** Scan protected spans and complete sentence boundaries, aggregate only consecutive fitting sentences, and use hard-boundary metadata to override final paragraph pause. Retain the existing 180 ms period and 165 ms `!`/`?`/`…` cadence.
- [ ] **3.4 Implement the exceptional fallback.** For one oversized sentence, choose the rightmost safe boundary in the first available class: semicolon, colon, spaced dash, comma, then last safe whitespace. Reject internal hyphens, protected punctuation, and surrogate splits. Return deterministic capacity failure for an oversized protected span or whitespace-free token.
- [ ] **3.5 Verify GREEN.** Run `pnpm test:unit -- segmentation latin_speech_units` and verify every output Final Rendering fits 300 in Latin/Vietnamese fixtures.

### Task 4: Replace greedy consolidation with deterministic global DP (TDD)

**Files:**
- Modify: `src/offscreen/short_segment_consolidation.ts`
- Modify: `tests/unit/short_segment_consolidation.test.ts`
- Modify: `tests/unit/short_segment_consolidation_foundation.test.ts`
- Create: `tests/unit/short_segment_consolidation.property.test.ts`

- [ ] **4.1 Write fixed RED regressions.** Change the short threshold to `< 50` trimmed non-whitespace Unicode code points. Cover capacity-blocked candidates, cross-paragraph fusion, final-rendering-only overflow, exact final-pause ownership, `null` pause behavior, deterministic ties, and required `[1, 3, 2, 4]` grouping as `[1 + 2]`, `[3 + 4]`.
- [ ] **4.2 Build feasible run descriptors.** For every consecutive source range, derive canonical single-space joins, cadence-preserving Final Rendering, final/rightmost pause, code-point count, final-rendering length, and whether the run is genuinely merged. Reject descriptors exceeding the language limit.
- [ ] **4.3 Preserve canonical/rendered/pause semantics.** Add exactly one rendering-only period after an absorbed numeric audible boundary only if the left rendering lacks `.`, `!`, `?`, or `…`. Never add it for an absorbed `null` pause. Keep punctuation out of canonical text and give merged output exactly the final source pause.
- [ ] **4.4 Implement the DP state and comparator.** State for a partial partition must retain the current run start plus whether that run can merge with its left neighbor; appending a next run finalizes whether the current short output is independently mergeable. Accumulate finalized mergeable-short count, maximum length among genuinely merged runs (zero if absent), and one-based end/start vectors. Compare candidates in that exact order to select a polynomial-time deterministic optimum.
- [ ] **4.5 Add seeded property tests.** Use named fixed seeds and small sequences so an exhaustive contiguous-partition oracle can evaluate every feasible partition. Generate Unicode code points, Protected Forms, hard boundaries, numeric/`null` pauses, and 300/120 language limits. Failure messages must print the seed, source units, feasible ranges, selected partition, and oracle partition.
- [ ] **4.6 Verify GREEN.** Run all short-consolidation suites and confirm repeated equal input returns byte-for-byte equivalent units, renderings, pauses, and membership ranges.

### Task 5: Integrate word maps, normalizer output, and audio handoff (TDD)

**Files:**
- Modify: `src/offscreen/playback_preparation.ts`
- Modify: `src/offscreen/word_map.ts`
- Modify: `src/offscreen/audio.ts`
- Modify: `tests/unit/playback_preparation.test.ts`
- Modify: `tests/unit/word_map.test.ts`
- Modify: `tests/unit/offscreen_audio.test.ts`

- [ ] **5.1 Write integration failures.** Verify source-equivalent preparation, canonical source reconstruction after normalized joins, no empty units, one contiguous source range per output, word-map offsets resolving against canonical text, Vietnamese original-token identity, synthetic period omission, numeric pause absorption, and `null` pause preservation.
- [ ] **5.2 Order the pipeline correctly.** Normalize; resolve language-specific planning; construct bare Source Units; globally consolidate; attach plain or normalized maps; revalidate Final Rendering; then synthesize. Ensure map attachment never precedes a merge.
- [ ] **5.3 Preserve audio behavior while guarding requests.** Keep `null` pause's engine-managed silence behavior and existing acoustic-tail padding. The new pre-synthesis capacity check must run before engine invocation and must not alter valid audio data.
- [ ] **5.4 Verify GREEN.** Run the three integration suites and inspect assertions for canonical-versus-rendered text, word-map spans, pause handoff, and rejected over-capacity engine calls.

### Task 6: End-to-end and release verification

**Files:**
- Create: `tests/e2e/universal-text-segmentation.spec.ts`
- Modify only if fixture support is required: `tests/e2e/fixtures.ts`

- [ ] **6.1 Add E2E coverage.** Drive representative Article, Selected Text, PDF, and Playlist Item fixtures with equivalent text. Assert equivalent prepared canonical/rendered units, stable pauses/highlights, and no request above 300 for Latin/Vietnamese or 120 for Korean/Japanese. Use safe test doubles; do not run model inference merely to inspect unit preparation.
- [ ] **6.2 Run focused automated verification.** Run the affected unit suites from Tasks 1–5, then `pnpm test:unit`.
- [ ] **6.3 Run build and E2E verification.** Run `pnpm build`, then `pnpm test:e2e` after confirming the extension bundle is current.
- [ ] **6.4 Perform manual extension checks.** In each Supported Source Type, verify soft wraps read as spaces, blank/sentence-terminal breaks receive paragraph cadence, fitting comma-heavy sentences remain intact, an oversized sentence follows the ordered fallback, protected forms and emoji remain uncut, short adjacent units fuse without duplicate pauses, highlights follow canonical text, and 300/120 boundary requests succeed while one-unit-over cases fail before synthesis.

## Completion criteria

- Every normative requirement in the specification is covered by a fixed test, seeded property test, or E2E/manual check.
- No test or implementation path uses a 400-unit capacity.
- The DP result matches the exhaustive oracle for all generated small cases and remains deterministic under repeated runs.
- `pnpm test:unit`, `pnpm build`, and `pnpm test:e2e` pass, and manual checks confirm source-neutral playback and highlighting behavior.
