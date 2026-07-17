# Latin-Script Speech Segmentation Design

**Status:** Implemented; automated verification passed; focused multilingual listening pending

**Date:** July 15, 2026

**Scope:** Extend weighted speech-unit planning and boundary-specific pauses from Vietnamese-only routing to all predominantly Latin-script text

## 1. Goal

Apply the existing lightweight weighted segmentation behavior to Latin-script
articles without adding an NLP library, runtime model, network call, or new
user setting.

Vietnamese must retain its normalization path and current segmentation output.
Other predominantly Latin-script text should use the same balanced boundary
selection instead of the legacy nominal 200-character chunker. Non-Vietnamese
non-Latin text must keep the compatibility path until a script-specific policy
is designed.

Weighted Latin-script units must also receive the existing explicit pause for
their selected boundary. Non-Latin compatibility units must retain the TTS
engine's current `0.3`-second internal silence.

This design extends
[Weighted Speech Segmentation and Indexed Prefetch](./2026-07-14-weighted-speech-segmentation-design.md).
It supersedes that document only where it requires all non-Vietnamese text to
use `chunkText(text, 200)`. Indexed synthesis, prefetch identity, playback
ordering, and session invalidation remain unchanged.

## 2. Current behavior and problem

`preparePlaybackUnits()` currently routes only `lang === "vi"` through the
weighted planner. Every other language uses `chunkText(text, 200)`, even when
the article uses Latin punctuation and protected-value forms already handled by
the Vietnamese scanner.

The weighted planner itself is already generic and dependency-free. The
language restriction comes from the location and naming of the boundary
scanner, its constants, the `SpeechUnit` type, and the routing condition. This
leaves English and other Latin-script articles with more mechanical splits and
places generic playback contracts under the Vietnamese namespace.

## 3. Product decisions

- Use one shared Latin-script boundary scanner and weighted policy.
- Preserve Vietnamese normalization before applying that shared planner.
- Apply weighted segmentation to non-Vietnamese text when more than half of its
  Unicode letters use the Latin script.
- Use script content, not a maintained list of language codes, to cover Latin
  languages and pages with a missing or incorrect language declaration.
- Keep `chunkText(text, 200)` as the compatibility fallback for
  non-Vietnamese non-Latin text and any unexpected planner failure.
- Reuse the current length bounds, boundary weights, pause values, paragraph
  behavior, and protected-value rules for the first release.
- Represent explicit boundary pauses and engine-managed compatibility pauses in
  the `SpeechUnit` contract without reclassifying text during synthesis.
- Add no dependency and do not use `Intl.Segmenter` in this change.
- Generalize the existing audio helper so weighted units in every Latin
  language use explicit pauses while non-Latin compatibility audio is
  unchanged.
- Do not change indexed prefetch, session state, or playback control behavior.

## 4. Architecture

### 4.1 Generic weighted planner

`src/offscreen/segmentation.ts` remains unchanged in responsibility. It accepts
boundary candidates and a scoring policy, then returns balanced text segments.
It does not detect scripts, scan punctuation, normalize Vietnamese, or know
about audio playback.

### 4.2 Shared Latin-script speech-unit planner

The punctuation scanner and speech-unit planning currently located under
`src/offscreen/vietnamese/` move to a shared Latin-script module in the
offscreen layer. The module owns:

- paragraph normalization and traversal;
- protected-span detection;
- punctuation boundary candidates;
- the production length, score, and pause policy;
- conversion from planned text segments to `SpeechUnit[]`;
- the pure predominantly-Latin classifier.

The public planner name and exported production constants should describe
Latin-script behavior rather than Vietnamese-only behavior. The implementation
plan may preserve temporary re-exports only when they materially reduce test or
call-site churn; it must not maintain duplicate scanners or policies.

### 4.3 Shared speech-unit contract

`SpeechUnit` is a playback contract used by preparation, audio synthesis, and
the offscreen queue. It moves from `src/offscreen/vietnamese/types.ts` to a
language-neutral offscreen type module. Vietnamese normalization result types
remain under `src/offscreen/vietnamese/`.

The pause field distinguishes the two synthesis modes:

```ts
interface SpeechUnit {
	text: string;
	pauseAfterMs: number | null;
}
```

A numeric value, including zero, means that synthesis uses zero internal
silence and appends exactly that many milliseconds after the returned samples.
`null` means that the TTS engine owns the pause and receives the existing
`0.3`-second internal-silence argument.

This is a targeted ownership correction required by the expanded routing, not
a broader type-system refactor.

### 4.4 Playback preparation router

`preparePlaybackUnits(text, lang, normalizer)` remains the single routing
boundary. It uses the primary, lower-cased BCP-47 language subtag when checking
for Vietnamese, so both `vi` and values such as `vi-VN` select the Vietnamese
path.

The routing order is binding:

```text
primary language is vi
  -> normalize Vietnamese when the normalizer is available
  -> plan normalized text with the shared Latin-script planner

otherwise, source text is predominantly Latin
  -> plan source text directly with the shared Latin-script planner

otherwise
  -> compatibility chunkText(text, 200)
```

Vietnamese is checked before script classification. A missing, unknown, or
incorrect non-Vietnamese language tag does not prevent Latin-script routing.

### 4.5 Explicit-pause synthesis

`synthesizeSpeechUnitSamples()` becomes the single testable audio-sample path
for every language. It calls the injected TTS function once:

- when `pauseAfterMs` is numeric, pass internal silence `0`, then append the
  requested number of silence samples;
- when `pauseAfterMs` is `null`, pass internal silence `0.3`, then return the
  engine output without appending a second pause.

`offscreen.ts` no longer branches on `lang === "vi"` when constructing samples.
It still passes the article language to Supertonic unchanged. Audio decoding,
indexed synthesis keys, caching, and playback sequencing remain unchanged.

## 5. Predominantly-Latin classification

The classifier iterates Unicode code points and counts only characters matching
the Unicode `Letter` category:

```text
letterCount = number of code points matching \p{L}
latinLetterCount = number of code points matching \p{Script=Latin}
isPredominantlyLatin = letterCount > 0
                    && latinLetterCount / letterCount > 0.5
```

Numbers, punctuation, symbols, emoji, combining marks, and whitespace do not
participate in the ratio. A text with no letters is not Latin. An exact 50/50
mix is not Latin and uses compatibility chunking.

Script classification operates on Unicode code points. Segmentation length
limits continue to use UTF-16 code units, matching the existing planner and
JavaScript string indexes.

## 6. Boundary and length policy

The first shared Latin-script policy preserves the implemented Vietnamese
values:

| Setting | Value |
| --- | ---: |
| Preferred minimum | 140 UTF-16 code units |
| Scoring center | 190 UTF-16 code units |
| Preferred maximum | 240 UTF-16 code units |
| Hard maximum | 300 UTF-16 code units |

Boundary priority remains:

| Boundary | Weight |
| --- | ---: |
| Sentence end (`.`, `!`, `?`, `…`) | 40 |
| Semicolon | 30 |
| Colon | 28 |
| Spaced dash | 24 |
| Comma | 20 |

The outside-range penalty, short-remainder penalty, tie-breaking rules,
whitespace fallback, surrogate-safe hard split, and explicit pause values remain
unchanged. Paragraphs remain structural boundaries and receive the strongest
applicable pause.

The scanner continues to protect URLs, email addresses, IPv4 addresses,
versions, dates, times, decimals, measurements, and identifiers. Identifier
matching must use Unicode letter properties rather than a Vietnamese-specific
uppercase character list.

The scanner does not gain per-language abbreviation dictionaries. Sentence
punctuation is a scored candidate rather than a mandatory split, which limits
the impact of ambiguous periods while keeping the implementation small and
deterministic. Locale-specific abbreviation handling requires real failure
examples and a separate design.

## 7. Data flow and failure handling

### 7.1 Vietnamese

When a Vietnamese normalizer is available, its result is passed to the shared
Latin-script planner. If normalization fails or the normalizer is unavailable,
the original Vietnamese text is planned directly. If planning fails or yields
no usable unit, preparation falls back to compatibility chunks of the original
text. Weighted and Vietnamese fallback units use numeric explicit pauses;
compatibility chunks produced after a Vietnamese planner failure use an
explicit pause of zero to preserve current Vietnamese behavior.

This preserves the current fail-open behavior: pronunciation enhancement may
degrade, but reading should still start.

### 7.2 Other Latin-script text

Predominantly Latin source text is passed directly to the shared planner. No
language-specific normalization runs. If planning fails or yields no usable
unit, preparation falls back to compatibility chunks of the same source text.
Successfully planned units use numeric explicit pauses. Compatibility chunks
after a planner failure use `null`, preserving the pre-change non-Vietnamese
engine pause.

### 7.3 Non-Latin text

Non-Vietnamese non-Latin and exactly balanced mixed-script text bypass the
weighted planner and use the existing compatibility chunker. This design does
not claim that the compatibility path is linguistically correct for CJK, Thai,
Arabic, Cyrillic, or other scripts; it preserves current behavior until those
script families receive explicit policies. These units use `pauseAfterMs: null`
and therefore retain the TTS engine's `0.3`-second internal silence.

### 7.4 Synthesis and playback ordering

Prepared `SpeechUnit[]` continues through the existing indexed synthesis
coordinator. This change must not alter synthesis keys, prefetch retry rules,
cache retention, source-node guards, or the rule that played unit indexes are
contiguous and increasing. Existing repeated-unit regression coverage remains
a release gate. The pause strategy is already part of each coordinator input's
`SpeechUnit`; it does not become part of the synthesis key because a playback
session owns an immutable prepared-unit sequence.

## 8. Text and behavior invariants

- No weighted speech unit exceeds 300 UTF-16 code units.
- No speech unit is empty.
- Unit order matches source order.
- Weighted segmentation loses, duplicates, or reorders no non-whitespace source
  content.
- A selected boundary retains its punctuation and owns its configured pause.
- Protected punctuation is not offered as a split candidate.
- Vietnamese normalization behavior and current Vietnamese planner fixtures do
  not regress.
- Predominantly Latin non-Vietnamese text uses weighted segmentation regardless
  of a missing or incorrect language tag.
- Every successfully weighted Latin-script unit uses its numeric boundary
  pause, including a valid explicit pause of zero.
- Non-Vietnamese non-Latin and exactly 50/50 mixed-script text retains
  compatibility chunking and engine-managed `0.3`-second silence.
- A classification or segmentation problem cannot prevent compatibility
  playback from being attempted.
- Synthesis and playback order are unchanged.

## 9. Testing strategy

### 9.1 Classifier unit tests

Table-driven tests cover:

- plain English;
- Latin text with French, German, Spanish, and Polish diacritics;
- Latin text surrounded by numbers, punctuation, whitespace, and emoji;
- a missing or unknown language tag at the preparation boundary;
- a majority-Latin mixed-script sample;
- an exact 50/50 Latin/non-Latin sample;
- Chinese, Cyrillic, and Arabic samples;
- input containing no Unicode letters.

Tests assert the ratio rule directly instead of relying only on downstream
chunk shapes.

### 9.2 Planner unit tests

Existing Vietnamese weighted-segmentation fixtures remain binding. They may be
moved or renamed to match shared ownership, but their expected text and pause
output must not change.

Additional Latin-script fixtures cover:

- balanced segmentation around sentence and clause punctuation;
- preservation of accented Latin text;
- Unicode uppercase identifiers;
- protected URLs, email addresses, decimals, versions, dates, times, and
  measurements;
- paragraph pause precedence;
- whitespace and surrogate-safe hard-limit fallbacks;
- hard maximum length;
- source reconstruction without loss, duplication, or reordering.

No property-testing or language-processing dependency is required.

### 9.3 Playback preparation tests

Preparation integration tests assert:

- `vi` and `vi-VN` normalize before shared weighted segmentation;
- a Vietnamese normalization failure still reads original text;
- English and accented Latin text no longer use compatibility chunking;
- Latin text with a missing or incorrect non-Vietnamese language tag still uses
  weighted segmentation;
- Chinese, Cyrillic, Arabic, and exact 50/50 mixed text retain compatibility
  output with `pauseAfterMs: null`;
- Vietnamese fallback units retain numeric explicit pauses;
- repeated calls are deterministic.

### 9.4 Audio synthesis tests

The audio-helper tests use an injected synthesis function and assert:

- a numeric Latin pause sends internal silence `0` and appends the exact rounded
  sample count;
- an explicit zero pause sends internal silence `0` and appends nothing;
- a `null` compatibility pause sends internal silence `0.3` and appends no
  additional samples;
- English and Vietnamese language codes are forwarded unchanged;
- validation of invalid sample rates and numeric pauses remains unchanged.

### 9.5 Regression and repository verification

The change requires the existing repository gates:

```text
pnpm test:unit
pnpm build
pnpm validate:manifest
pnpm test:e2e
git diff --check
```

The existing indexed-synthesis and reading-state tests remain responsible for
proving that the expanded preparation route does not reintroduce duplicate
synthesis or repeated-unit playback. The full E2E suite is required because
the implementation generalizes the offscreen synthesis branch, even though its
session and coordinator logic remain unchanged.

Focused listening should sample Vietnamese plus at least English, French,
German, Spanish, and Polish text containing long sentences and mixed
punctuation. Listening findings may motivate later policy calibration, but this
change does not create per-language settings.

## 10. Success criteria

- Vietnamese retains normalization and current weighted-segmentation behavior.
- All predominantly Latin-script non-Vietnamese text uses the weighted planner.
- Weighted units in every Latin language use explicit boundary pauses.
- Non-Latin compatibility units retain the engine's `0.3`-second silence.
- Pages with missing or inaccurate language tags are classified from text
  without adding language-detection dependencies.
- Non-Vietnamese non-Latin behavior is unchanged.
- The implementation adds no runtime or development dependency.
- Existing synthesis ordering and repeated-playback regressions remain green.
- Unit tests, production build, manifest validation, Playwright, and diff checks
  pass.

## 11. Out of scope

- Per-language length, weight, pause, or abbreviation profiles.
- `Intl.Segmenter` integration.
- Automatic Vietnamese language detection when the page does not identify
  Vietnamese; such text receives the Latin default path.
- Script-specific segmentation for CJK, Thai, Arabic, Cyrillic, or other
  non-Latin writing systems.
- Changes to the Supertonic model, voice selection, sample rate, decoding,
  indexed prefetch, playback controls, UI, manifest permissions, telemetry, or
  network behavior.
