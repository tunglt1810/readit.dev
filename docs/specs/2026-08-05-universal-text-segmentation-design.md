# Universal Text Segmentation & Short Chunk Fusion Specification

**Date:** 2026-08-05
**Status:** Authoritative specification
**Scope:** Extension offscreen audio-synthesis text preparation (`src/offscreen/`)

This document is the single authoritative specification for universal text segmentation and short-chunk fusion. It defines the contract for preparing Article, Selected Text, PDF, and Playlist Item content for synthesis while preserving canonical source content, order, highlighting offsets, and export metadata.

## 1. Purpose, Scope, and Non-Goals

The extension sends ordered `SpeechUnit`s to Supertonic. A unit retains canonical source-facing text, may carry a TTS-only rendering, and owns its post-synthesis pause. This feature makes the planning pipeline source-neutral and final-rendering capacity-safe, retains sentence and protected-form integrity, and fuses unreliable short units without changing source order, highlights, or export metadata.

### In scope

- One normalization, planning, consolidation, word-map, and pre-synthesis contract for Article, Selected Text, PDF, and Playlist Item input.
- Resolved-language capacity policy: **300 UTF-16 code units** for Latin-script and Vietnamese synthesis and **120 UTF-16 code units** for Korean (`ko`) and Japanese (`ja`) synthesis.
- Sentence-first planning, exceptional safe fallback for an oversized sentence, globally optimized adjacent-run fusion, and deterministic metadata.

### Out of scope

- UI, content extraction, TTS-model, or source-specific policy changes.
- Raising engine capacity to **400** code units. Such a change requires a separately approved engine benchmark and capacity-policy change.
- Using preferred planning lengths to relax the engine limit; preferred lengths are quality heuristics only.

## 2. Glossary

| Term | Meaning |
| --- | --- |
| **Universal Text Segmentation System** | The offscreen pipeline that normalizes text, plans source units, optionally consolidates adjacent units, attaches word maps, and prepares synthesis requests. |
| **Supported Source Types** | Article, Selected Text, PDF, and Playlist Item. |
| **Source Unit** | One ordered canonical unit produced by sentence planning before consolidation. |
| **Output Unit** | One final `SpeechUnit` after planning and any consolidation; it represents one contiguous, ordered range of Source Units. |
| **Canonical Text** | An Output Unit's `text`: normalized source-facing text used exclusively for highlights, word-map offsets, source reconstruction, and export metadata. |
| **Final Rendering** | The string submitted to TTS: `synthesisText` when present, otherwise Canonical Text. |
| **Synthesis Capacity** | The maximum Final Rendering length accepted for the resolved language, measured with JavaScript `string.length` (UTF-16 code units). |
| **Hard Paragraph Boundary** | A blank-line run or a single line break immediately after a sentence terminal. It is retained only as planning metadata after Canonical Text whitespace normalization. |
| **Soft Line Break** | A single line break that is neither in a blank-line run nor immediately after a sentence terminal; it represents visual wrapping. |
| **Protected Form** | A span that cannot contain a sentence or fallback split boundary: URL, email, IPv4 address, semantic version, identifier, date, time, decimal, numeric range, currency, percentage, unit expression, initialism, abbreviation, organizational title, or recognized media/location form. |
| **Safe Boundary** | A candidate boundary outside every Protected Form and not between the high and low UTF-16 code units of a Unicode surrogate pair. |
| **Audible Boundary** | A Source Unit boundary whose `pauseAfterMs` is numeric and greater than zero. A `null` pause is not audible for fusion purposes. |
| **Short Output Unit** | An Output Unit containing fewer than 50 trimmed, non-whitespace Unicode code points. |
| **Independently Mergeable Short Output Unit** | A Short Output Unit that can form a feasible consecutive Source Unit run with either immediately adjacent Output Unit while preserving order and Synthesis Capacity. |
| **Genuinely Merged Output Run** | An Output Unit run containing two or more Source Units. |
| **Output Run Start/End Index** | The inclusive, one-based Source Unit indexes represented by an Output Unit run. |
| **Word Map** | Metadata whose entries identify spans in Canonical Text. For normalized Vietnamese, an entry retains original-token identity while locating the corresponding normalized spoken span. |
| **External Pause** | A numeric `pauseAfterMs` silence appended after an Output Unit's audio. `null` retains engine-managed internal silence and is not an External Pause. |

Examples of Protected Forms include `https://example.test/v1.2.3`, `reader@example.test`, `192.0.2.1`, `ABC-123`, `TP.HCM`, `VnExpress`, `PGS.TS`, `IRGC`, `AFP`, and `CNN`. Punctuation inside a Protected Form remains protected.

## 3. Architecture and Core Contracts

### 3.1 Universal pipeline

```text
[ Article / Selection / PDF / Playlist ]
                 |
                 v
1. Source-neutral normalization
   NFC, line-ending normalization, soft/hard break classification
                 |
                 v
2. Language policy, protected-form scan, sentence scan
                 |
                 v
3. Capacity-safe sentence planning
   sentence aggregation; exceptional long-sentence fallback
                 |
                 v
4. Global order-preserving consolidation
   feasible contiguous-run optimization using Final Rendering
                 |
                 v
5. Word-map attachment and synthesis
   map Canonical Text; request Final Rendering; append owned pause
```

Source origin never selects a segmentation policy. Resolved synthesis language selects the engine capacity and its language-specific sentence processing. Latin-script text and normalized Vietnamese use the Latin/Vietnamese sentence, protected-pattern, pause, and long-sentence policy. Korean and Japanese retain their existing language-specific planning while participating in the same final-rendering capacity validation and consolidation contract. Existing compatibility paths retain their engine-resolved language handling and capacity.

### 3.2 `SpeechUnit` contract

| Field | Contract |
| --- | --- |
| `text` | Canonical Text. It preserves source order after defined normalization and is the sole text for highlights, word maps, source reconstruction, and exports. It never includes punctuation invented solely for TTS cadence. |
| `synthesisText` | Optional internal TTS rendering. It equals `text` unless cadence-preserving punctuation is needed at an absorbed audible boundary. It is never canonical text or the basis for word-map offsets. |
| `wordMap` | Attached only after planning and consolidation. Each entry addresses Canonical Text; synthetic `synthesisText` punctuation has no entry. |
| `pauseAfterMs` | The silence appended after the unit's synthesized audio. A merged run owns the final Source Unit's pause; an absorbed boundary cannot also append external silence. |

All planning, fusion, and immediate pre-request capacity decisions use Final Rendering, not Canonical Text alone. Canonical reconstruction uses `text` only.

### 3.3 Pause policy

For Latin/Vietnamese numeric-pause paths, a completed period receives 180 ms and `!`, `?`, or `…` receive 165 ms. A Hard Paragraph Boundary receives 260 ms and overrides the preceding sentence-terminal pause for the paragraph's final output. Semicolons, colons, commas, and spaced dashes can retain their configured cadence only when selected by the exceptional oversized-sentence fallback; a comma is not an ordinary interior split point. `pauseAfterMs: null` preserves engine-managed silence and must not become an artificial External Pause.

## 4. Normative Requirements

All requirements use EARS-style conditions. “The system” means the Universal Text Segmentation System.

### R1. Source-neutral normalization

1. **WHEN** identical raw text and resolved synthesis language are received as each Supported Source Type, **THE system SHALL** produce byte-for-byte equivalent Canonical Text, Source Unit membership, Output Unit boundaries, Final Renderings, `pauseAfterMs` values, and Word Maps.
2. **WHEN** input text is received, **THE system SHALL** normalize it to NFC and convert every CRLF or CR line ending to LF before line-break classification and sentence planning.
3. **WHEN** a line break belongs to a blank-line run in normalized input, **THE system SHALL** classify it as a Hard Paragraph Boundary before evaluating any other line-break classification.
4. **WHEN** a single normalized line break immediately follows a sentence terminal and is not in a blank-line run, **THE system SHALL** classify it as a Hard Paragraph Boundary.
5. **WHEN** a single normalized line break is not a Hard Paragraph Boundary, **THE system SHALL** classify it as a Soft Line Break.
6. **WHEN** Canonical Text whitespace normalization follows line-break classification, **THE system SHALL** retain the Hard Paragraph Boundary metadata after replacing the corresponding Canonical Text whitespace with ordinary spaces.
7. **WHEN** a Soft Line Break occurs, **THE system SHALL** replace it with one ordinary space in Canonical Text.
8. **WHEN** Canonical Text is created, **THE system SHALL** replace every remaining whitespace run with one ordinary space and trim leading and trailing whitespace.
9. **WHEN** normalized input contains no non-whitespace Unicode code point, **THE system SHALL** produce zero Source Units, zero Output Units, zero Word Maps, and zero synthesis requests.

### R2. Resolved capacity and Final Rendering enforcement

1. **WHERE** the resolved synthesis language uses Latin script or Vietnamese, **THE system SHALL** use a Synthesis Capacity of 300 UTF-16 code units.
2. **WHERE** the resolved synthesis language is `ko` or `ja`, **THE system SHALL** use a Synthesis Capacity of 120 UTF-16 code units.
3. **WHERE** the resolved language uses an existing compatibility path, **THE system SHALL** use the capacity resolved by the synthesis engine for that language.
4. **WHEN** the system selects a Source Unit during planning or evaluates an Output Unit run during consolidation, **THE system SHALL** compare Synthesis Capacity with Final Rendering rather than Canonical Text alone.
5. **WHEN** an Output Unit is prepared for synthesis, **THE system SHALL** measure Final Rendering with JavaScript `string.length` semantics.
6. **WHEN** Final Rendering is revalidated immediately before synthesis, **THE system SHALL** issue a request only when its length is less than or equal to the applicable Synthesis Capacity.
7. **WHEN** a preferred planning length conflicts with Synthesis Capacity, **THE system SHALL** preserve the applicable capacity.
8. **IF** a selected Source Unit or Output Unit Final Rendering exceeds capacity during planning, consolidation, or immediate pre-request validation, **THEN THE system SHALL** report a deterministic capacity failure without issuing a synthesis request or mutating Canonical Text, Final Rendering, or Word-Map metadata.

### R3. Canonical Text, Rendering Text, and Word-Map separation

1. **THE system SHALL** use Canonical Text as the sole text for highlights, Word-Map offsets, source reconstruction, and export metadata.
2. **WHEN** an Output Unit needs no cadence-preserving rendering punctuation, **THE system SHALL** use Canonical Text as its Final Rendering.
3. **WHEN** fusion absorbs an Audible Boundary and the left Source Unit Final Rendering does not end in `.`, `!`, `?`, or `…`, **THE system SHALL** append exactly one period immediately after that left component in `synthesisText` and add no other synthetic character at that boundary.
4. **WHEN** `synthesisText` contains cadence-preserving punctuation, **THE system SHALL** keep it out of Canonical Text.
5. **WHEN** planning, Source Unit-to-Output Unit assignment, and consolidation are complete, **THE system SHALL** attach Word Maps to the resulting Output Units.
6. **WHEN** a Word Map entry is created, **THE system SHALL** index and resolve it against Canonical Text.
7. **WHEN** a Vietnamese token is normalized for speech, **THE system SHALL** retain its original-token identity in the Word Map and locate the corresponding normalized spoken span in Canonical Text.
8. **WHEN** `synthesisText` contains a rendering-only character, **THE system SHALL** omit that character from the Word Map.

### R4. Protected Forms and Unicode safety

1. **WHEN** the system recognizes a Protected Form, **THE system SHALL** reject every sentence-boundary and fallback-split candidate located within it.
2. **THE system SHALL** treat periods, slashes, colons, dashes, commas, and semicolons within a Protected Form as protected punctuation.
3. **WHEN** a candidate lies immediately before the first or after the last character of a Protected Form, **THE system SHALL** permit it when it is a Safe Boundary.
4. **WHEN** selecting a sentence or fallback boundary, **THE system SHALL** select only a Safe Boundary.
5. **WHEN** a candidate lies between the UTF-16 code units of a Unicode surrogate pair, **THE system SHALL** reject it.

### R5. Ordinary sentence planning

1. **WHEN** consecutive sentence units are aggregated, **THE system SHALL** aggregate only consecutive units in Canonical Text source order.
2. **WHEN** an individual sentence Final Rendering fits Synthesis Capacity, **THE system SHALL** retain it as an intact sentence.
3. **WHEN** selecting an ordinary planning boundary for sentences that fit capacity, **THE system SHALL** select only a complete-sentence boundary.
4. **WHEN** a fitting ordinary sentence contains a comma, **THE system SHALL** retain the comma inside the intact sentence.
5. **WHEN** a fitting ordinary sentence contains whitespace, **THE system SHALL** retain the whitespace inside the intact sentence.

### R6. Exceptional oversized-sentence fallback

This is the only path permitted to split a single sentence.

1. **WHILE** splitting a sentence whose Final Rendering exceeds capacity, **THE system SHALL** evaluate Safe Boundary candidates no later than capacity in this strict order: semicolon (`;`), colon (`:`), spaced dash (` - `, ` – `, or ` — `), comma (`,`), then safe whitespace.
2. **WHEN** two or more Safe Boundary candidates occur in the selected punctuation priority class, **THE system SHALL** select the rightmost one.
3. **WHEN** the selected class is spaced dash, **THE system SHALL** select only the three spaced-dash forms above; a hyphen inside a word or Protected Form is ineligible.
4. **WHEN** no eligible punctuation candidate fits, **THE system SHALL** split at the last Safe Boundary formed by whitespace before capacity.
5. **WHEN** the system selects a fallback candidate, **THE system SHALL** create a current Source Unit whose Final Rendering is at or below capacity.
6. **WHEN** whitespace fallback is selected, **THE system SHALL** end the current Source Unit before the selected whitespace without splitting a word, Protected Form, or surrogate pair.
7. **IF** a whitespace-free token or Protected Form alone exceeds capacity, **THEN THE system SHALL** report a deterministic capacity-planning failure without issuing a synthesis request.

Whitespace fallback is an exceptional over-capacity behavior, never an ordinary preferred-length strategy.

### R7. Pause ownership and cadence

1. **WHERE** a Latin-script or Vietnamese path uses numeric pauses, **WHEN** a completed sentence ends with a period, **THE system SHALL** assign an External Pause of 180 ms.
2. **WHERE** a Latin-script or Vietnamese path uses numeric pauses, **WHEN** a completed sentence ends with `!`, `?`, or `…`, **THE system SHALL** assign an External Pause of 165 ms.
3. **WHERE** an Output Unit uses numeric pauses, **WHEN** it ends at a Hard Paragraph Boundary, **THE system SHALL** assign 260 ms in place of the preceding sentence-terminal pause.
4. **WHEN** feasible fusion creates a multi-Source-Unit run, **THE system SHALL** set its `pauseAfterMs` exactly to the rightmost Source Unit's value, including across a Hard Paragraph Boundary.
5. **WHEN** fusion absorbs an internal Source Unit boundary with a numeric External Pause, **THE system SHALL** omit that absorbed External Pause from the merged Output Unit.
6. **WHERE** a run's final Source Unit has `pauseAfterMs: null`, **THE system SHALL** set the Output Unit pause to `null` and shall not derive a numeric External Pause.
7. **WHEN** fusion absorbs a Source Unit boundary with `pauseAfterMs: null`, **THE system SHALL** preserve engine-managed internal silence without treating it as Audible or adding synthetic terminal punctuation for it.

### R8. Legal adjacent-run consolidation

1. **WHEN** final Output Unit runs are established before Word Maps are attached, **THE system SHALL** assign every planned Source Unit exactly once to one contiguous Output Unit run, including runs that cross a Hard Paragraph Boundary.
2. **WHEN** a candidate Output Unit run is formed, **THE system SHALL** join constituent Canonical Text values with one ordinary space in source order.
3. **WHEN** candidate feasibility is evaluated, **THE system SHALL** calculate Final Rendering with the cadence-preserving rendering rules used for synthesis.
4. **WHEN** a candidate run Final Rendering is at or below capacity, **THE system SHALL** classify it as feasible.
5. **WHEN** a candidate run Final Rendering exceeds capacity, **THE system SHALL** exclude it from consolidation.
6. **WHEN** a Hard Paragraph Boundary separates adjacent Source Units, **THE system SHALL** permit consolidation across it when the resulting run is feasible.
7. **WHEN** consolidation crosses a Hard Paragraph Boundary, **THE system SHALL** join the absorbed Canonical Text with one space and omit the absorbed paragraph External Pause.

### R9. Globally optimal short-fragment fusion

1. **WHEN** an Output Unit contains fewer than 50 trimmed, non-whitespace Unicode code points, **THE system SHALL** classify it as a Short Output Unit.
2. **WHEN** feasible contiguous Output Unit partitions are compared, **THE system SHALL** prefer the partition with the fewest Independently Mergeable Short Output Units.
3. **WHEN** partitions tie on that count, **THE system SHALL** compare the maximum Final Rendering length only among Genuinely Merged Output Runs, treat that maximum as zero when there is no such run, and prefer the smaller maximum.
4. **WHEN** partitions remain tied, **THE system SHALL** select the lexicographically earliest vector of one-based Output Run End Index values.
5. **WHEN** those vectors also tie, **THE system SHALL** select the lexicographically earliest vector of one-based Output Run Start Index values.
6. **WHEN** four consecutive Source Units have Final Rendering lengths `[1, 3, 2, 4]`, Source Units 3 and 4 are Short Output Units when unmerged, and pairings `1 + 2` and `3 + 4` are feasible, **THE system SHALL** group them as `[1 + 2]`, `[3 + 4]` rather than `[1]`, `[2 + 3 + 4]`.

### R10. Deterministic output integrity

1. **WHEN** identical normalized input and resolved language are processed more than once, **THE system SHALL** produce byte-for-byte equivalent Output Units, ordered Source Unit membership, Final Renderings, `pauseAfterMs` values, and Word Maps.
2. **WHEN** the system emits an Output Unit, **THE system SHALL** emit Canonical Text containing at least one non-whitespace Unicode code point.
3. **WHEN** Output Units are concatenated with normalized joins, **THE system SHALL** preserve source content and order subject only to R1 NFC, line-ending, line-break, and whitespace normalization.
4. **WHEN** a Source Unit is consolidated, **THE system SHALL** include it in exactly one Output Unit run.
5. **WHEN** an Output Unit run is created, **THE system SHALL** assign it one consecutive Source Unit range containing every Source Unit between its Start and End Index.

## 5. Required Algorithms and Component Changes

### 5.1 Normalization and planning metadata

Introduce one source-neutral line-break normalizer before language-specific sentence planning. It must produce normalized Canonical Text candidates and planning-only Hard Paragraph Boundary metadata. The metadata survives whitespace collapse but is not serialized into `SpeechUnit.text`; it is consumed to assign paragraph cadence and to preserve boundary meaning through fusion. Vietnamese normalization, when available, runs before sentence planning while preserving this source-neutral boundary contract.

### 5.2 Sentence-first segmentation

`src/offscreen/latin/speech_units.ts` and `src/offscreen/segmentation.ts` must plan complete sentences first and aggregate only complete adjacent sentences that fit. Their ordinary path must not use weighted comma or whitespace cuts. Protected spans are identified before sentence/fallback boundary selection. Only an individual oversized sentence enters the R6 ordered fallback, which must use the rightmost safe candidate in its first nonempty priority class and fail deterministically when no legal capacity-safe progress exists.

### 5.3 Final-rendering capacity guard

`src/offscreen/supertonic_helper.ts` remains the single capacity authority through `synthesisTextLimitForLanguage()`: 120 for resolved `ko`/`ja`, 300 otherwise. `src/offscreen/playback_preparation.ts` validates planned and consolidated Final Renderings; `src/offscreen/audio.ts` validates immediately before calling the engine. No helper or planner may substitute a 400-unit limit.

### 5.4 Global contiguous-run dynamic programming

`src/offscreen/short_segment_consolidation.ts` replaces sequential greedy splicing with deterministic polynomial-time dynamic programming:

1. Precompute every feasible contiguous source range `[start, end)`, including its Canonical Text, Final Rendering, final pause, non-whitespace code-point count, genuinely-merged flag, and Final Rendering length.
2. Construct only partitions made of those feasible ranges. For a candidate run, synthesize rendering by joining canonical components with one space and adding exactly one period after a left component only for an absorbed Audible Boundary lacking terminal `.`, `!`, `?`, or `…`.
3. Retain the current output run's start index and a boolean indicating whether it can merge with its immediate left neighbor in the DP state. When a next run is appended, evaluate whether the current short run is independently mergeable from that left-mergeable flag or from feasibility of the current-plus-next range. This finalizes the current run without requiring greedy traversal.
4. Carry the finalized independently-mergeable-short count, maximum genuinely-merged rendering length, and one-based end/start-index vectors in the comparison state. Compare these values in R9 order and use the same comparator for every tie.

This state is sufficient to evaluate independently mergeable short units exactly and yields a deterministic polynomial-time search; no non-adjacent merge, reordering, duplication, or omission is legal.

### 5.5 Component responsibilities

| Component | Required change |
| --- | --- |
| `src/offscreen/supertonic_helper.ts` | Preserve `synthesisTextLimitForLanguage()` as the 300/120 engine authority; do not introduce 400. |
| `src/offscreen/segmentation.ts` | Replace ordinary weighted fallback behavior with sentence-first aggregation and safe ordered oversized-sentence fallback support. |
| `src/offscreen/latin/speech_units.ts` | Apply source-neutral normalized input, protected-form scan, sentence boundaries, paragraph metadata, pause ownership, and the 300-unit Latin/Vietnamese policy. |
| `src/offscreen/playback_preparation.ts` | Run normalization and policy selection before segmentation; consolidate bare units before plain or normalized Word Maps; validate Final Rendering before handoff. |
| `src/offscreen/short_segment_consolidation.ts` | Implement feasible-run construction and the deterministic global contiguous-partition optimizer; preserve canonical/rendering/pause contracts. |
| `src/offscreen/word_map.ts` | Attach maps after consolidation and resolve only Canonical Text offsets, including normalized Vietnamese token identity. |
| `src/offscreen/audio.ts` | Revalidate Final Rendering capacity immediately before synthesis and report deterministic failure before making an engine request. |

## 6. Verification Strategy

Tests must update intentionally obsolete behavior while retaining unaffected regressions. Fixed examples and deterministic seeded generators must cover source type, Unicode code points, Protected Forms, paragraph boundaries, candidate pauses, and 300/120 capacities. Seeded failures must print the generated input/source units and selected partition for reproduction.

1. **Source equivalence and normalization:** Across all Supported Source Types, equivalent raw input and language yield equivalent Canonical Text, Source Unit membership, Output Unit boundaries, Final Renderings, pauses, and Word Maps. Empty normalized input yields no units, maps, or requests; Hard Paragraph Boundary metadata survives whitespace normalization.
2. **Final-rendering capacity and failure isolation:** Every planned Source Unit, feasible Output Unit run, and issued request fits the resolved capacity. Cover Latin/Vietnamese 300, Korean/Japanese 120, compatibility paths, and synthetic cadence punctuation. Unresolvable overruns fail deterministically without a request or metadata mutation.
3. **Canonical order, sentence integrity, and partitions:** Concatenated Canonical Text preserves normalized content and source order. Every output represents one consecutive source range; no source is lost, duplicated, reordered, or skipped. A fitting ordinary sentence is never split at an internal comma or whitespace.
4. **Protected, Unicode, and fallback safety:** No selected boundary falls inside a Protected Form or surrogate pair; boundaries immediately outside protected spans remain eligible. Whitespace fallback is the last safe whitespace before capacity and its current unit fits.
5. **Pause and Word-Map integrity:** Numeric sentence/paragraph pauses use their specified values; a merged run owns only the final Source Unit's pause; absorbed numeric pauses do not append silence; `null` does not produce numeric pause or synthetic punctuation. Word Maps resolve against Canonical Text and exclude synthetic rendering characters.
6. **Global optimality and determinism:** For generated small Source Unit sequences, compare the selected partition with an exhaustive feasible-partition oracle using all R9 criteria. Repeated preparation must be byte-for-byte stable. The `[1, 3, 2, 4]` grouping is a mandatory fixed regression.

The affected test suites are `tests/unit/segmentation.test.ts`, `tests/unit/latin_speech_units.test.ts`, `tests/unit/short_segment_consolidation.test.ts`, `tests/unit/short_segment_consolidation_foundation.test.ts`, `tests/unit/playback_preparation.test.ts`, `tests/unit/word_map.test.ts`, and `tests/unit/offscreen_audio.test.ts`. Run those suites, the full unit suite, the production build, the Playwright E2E suite, and a manual extension check covering each source type and the 300/120 boundary behavior.

## 7. Acceptance Checklist

- [x] One source-neutral contract covers Article, Selected Text, PDF, and Playlist Item input.
- [x] Final Rendering is constrained to 300 UTF-16 units for Latin/Vietnamese and 120 for Korean/Japanese; 400 is out of scope.
- [x] Canonical Text, Final Rendering, Word Maps, and pause ownership have distinct contracts.
- [x] Protected Forms, surrogate pairs, ordinary sentence integrity, and ordered oversized-sentence fallback are specified.
- [x] Consolidation is globally optimal, contiguous-only, capacity-safe after rendering, and deterministic.
- [x] The specification includes the required `[1, 3, 2, 4]` counterexample and property-based verification strategy.
