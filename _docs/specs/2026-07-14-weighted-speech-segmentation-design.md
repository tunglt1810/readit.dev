# Weighted Speech Segmentation and Indexed Prefetch Design

**Status:** Approved design; implementation pending
**Date:** July 14, 2026
**Scope:** Shared speech-unit planning, Vietnamese segmentation policy, and offscreen synthesis ordering

## 1. Goal

Replace the current nominal 200-character segmentation behavior with a small,
deterministic planner that prefers meaningful boundaries within a soft length
range. At the same time, prevent late synthesis and prefetch results from being
played as the wrong speech unit.

The implementation must remain local, dependency-free, and compatible with the
existing Vietnamese normalization and Supertonic runtime described in
[Vietnamese Pronunciation Improvements](./2026-07-13-vietnamese-pronunciation-improvements.md).

Where the documents conflict, this design supersedes the earlier specification
only for speech-unit construction, explicit-pause placement, and indexed
prefetch behavior. The existing normalization rules, pause durations, runtime
parameters, privacy boundary, and release gates remain unchanged.

## 2. Current problems

The current Vietnamese planner does not use 200 characters as a general target.
It eagerly emits units at sentence boundaries and at sufficiently long clause
boundaries. The 200-character value is used only to find a whitespace split
when a candidate has already exceeded the 300-character hard limit. This can
produce both short, fragmented units and mechanical splits in long text that
has sparse punctuation.

The offscreen runtime also stores the next synthesized buffer without the unit
index it represents. If playback reaches unit `N` while prefetch for `N` is
still running, the foreground path can synthesize `N` again. The late prefetch
result can then be consumed as though it were `N + 1`, repeating content that
was just played.

The design treats segmentation quality and playback ordering as separate
responsibilities. Fixing one must not be used to hide a defect in the other.

## 3. Product decisions

- Use a shared, deterministic segmentation planner implemented in TypeScript.
- Use a Vietnamese-specific boundary scanner and scoring policy first.
- Preserve the existing non-Vietnamese `chunkText()` path in this change.
- Treat `140` to `240` UTF-16 code units as the preferred range, with `190` as
  the scoring center and `300` as the hard limit.
- Preserve punctuation in the text sent to Supertonic.
- Apply an explicit pause only to the boundary selected as the end of a speech
  unit. Unselected internal punctuation is left for Supertonic to render with
  its natural prosody.
- Identify every synthesis result by playback session, speech-unit index, and
  speed version.
- Add no NLP library, runtime model, network call, or user-facing setting.

## 4. Architecture

### 4.1 Vietnamese boundary scanner

The Vietnamese scanner remains under `src/offscreen/vietnamese/`. It scans a
normalized paragraph and emits boundary candidates without deciding where to
split:

```ts
interface BoundaryCandidate {
	end: number;
	kind: 'sentence' | 'semicolon' | 'colon' | 'spacedDash' | 'comma';
	pauseAfterMs: number;
}
```

The scanner recognizes sentence endings, semicolons, colons, spaced dashes,
and commas. It continues to suppress punctuation boundaries inside protected
values such as URLs, email addresses, dates, times, versions, measurements,
and identifiers.

Paragraph boundaries are structural and are not ordinary scored candidates.
They always terminate the final unit in that paragraph and receive the existing
paragraph pause.

### 4.2 Shared segmentation planner

A small module under `src/offscreen/` receives one paragraph, its candidate
list, and a policy containing the length limits and boundary weights. It does
not know about Vietnamese normalization, Supertonic, Web Audio, or Chrome APIs.

For each unit, the planner:

1. emits the entire remaining paragraph when it is at most 300 code units;
2. otherwise scores candidates no farther than 300 code units from the current
   start;
3. selects the highest-scoring valid candidate;
4. falls back to whitespace nearest the 190-code-unit center when no punctuation
   candidate is valid;
5. falls back to the hard limit only when no safe whitespace exists.

The final fallback must not split a UTF-16 surrogate pair. Every emitted unit is
trimmed at its outside edges, while punctuation and word order remain unchanged.

### 4.3 Indexed synthesis coordinator

The synthesis job and one-unit prefetch bookkeeping move into a small,
browser-independent coordinator that can be tested with an injected synthesis
function. Audio decoding and playback remain in `offscreen.ts`.

Every job and cached result has this identity:

```ts
interface SynthesisKey {
	session: number;
	unitIndex: number;
	speedVersion: number;
}
```

Voice style is implicit in the playback session because changing the article or
voice starts a replacement session. A pause and resume do not replace the
session.

## 5. Boundary scoring

The first production policy uses these boundary weights:

| Boundary                           | Weight |
| ---------------------------------- | -----: |
| Sentence end (`.`, `!`, `?`, `…`) |     40 |
| Semicolon                          |     30 |
| Colon                              |     28 |
| Spaced dash                        |     24 |
| Comma                              |     20 |

For a candidate whose resulting trimmed slice has UTF-16 length `L`, calculate:

```text
score = boundaryWeight
      - abs(L - 190) / 5
      - outsidePreferredRangePenalty
      - shortRemainderPenalty
```

`outsidePreferredRangePenalty` is `10` when `L < 140` or `L > 240`, and zero
otherwise. `shortRemainderPenalty` is `30` when selecting the candidate would
leave a non-empty paragraph remainder shorter than 80 code units, and zero
otherwise.

A punctuation candidate is valid when its score is at least zero. The planner
chooses the valid candidate with the highest score. Ties are resolved by:

1. the stronger boundary weight;
2. the smaller distance from 190;
3. the earlier boundary, which preserves lower time to first audio.

If no punctuation candidate is valid, the planner chooses the whitespace
nearest 190 without exceeding the 300-code-unit limit. If two whitespace
positions are equally near, it chooses the earlier one. If there is no
whitespace, it cuts at or immediately before 300 at a surrogate-safe boundary.

The weights are internal production constants, not user settings. Future
changes require listening evidence and regression tests rather than exposing a
configuration surface.

## 6. Text and pause invariants

- No speech unit exceeds 300 UTF-16 code units.
- No unit is empty.
- Unit order is identical to source order.
- Every unit text covers an exact source span after the preceding unit. Gaps
  before, between, and after covered spans contain only whitespace. This is the
  binding reconstruction invariant: it proves no source content is lost,
  duplicated, or reordered while allowing an empty gap when a forced split
  falls inside an unbroken token.
- Protected punctuation is not offered as a scored boundary.
- A selected boundary retains its punctuation and owns its configured
  `pauseAfterMs`.
- Unselected punctuation remains inside the unit and receives no separately
  appended silence.
- The paragraph's final unit receives at least the paragraph pause when another
  paragraph follows.

These invariants deliberately separate a synthesis unit from every grammatical
clause. Several short sentences may share one synthesis unit, and one long
sentence may be split at a weaker boundary when that is the best safe choice.

## 7. Synthesis and playback ordering

The coordinator exposes one `ensureSynthesis(key)` operation for both prefetch
and foreground playback:

1. The first request for a key creates the synthesis promise.
2. A later request for the same key reuses that promise instead of starting a
   duplicate synthesis.
3. A completed result is cached with its full key.
4. Playback accepts a result only when all key fields match the unit currently
   requested.
5. A stop, article replacement, or voice replacement invalidates the session.
6. A speed change invalidates the speed version.
7. Work that cannot be cancelled may finish, but a stale result is discarded.
8. The coordinator retains at most the current and next unit's work or buffer.

Source-node `onended` callbacks must still verify both the playback session and
the active source identity before incrementing the unit index. The sequence of
played indexes within a session must be exactly `0, 1, 2, ...`.

## 8. Error handling

- A failed prefetch removes its failed job from the coordinator.
- When playback later requires that unit, the foreground path may retry it once.
- A failed foreground attempt reports playback `error`; it must not silently
  skip the unit.
- Stop and replacement paths clear current/next cached state without waiting for
  stale ONNX work to finish.
- Pause and resume retain the session and do not synthesize the active unit
  again.
- Empty segmentation output continues to use the existing unreadable-content
  error path.

If listening still reveals a repeated sound inside one buffer that was
synthesized and played exactly once, that is recorded as an acoustic-model
issue. It must not be misclassified as a queue-ordering regression.

## 9. Testing strategy

### 9.1 Segmentation unit tests

Tests cover:

- combining consecutive short sentences into a balanced unit;
- preferring punctuation near the 140-to-240 range;
- selecting a weaker nearby boundary over a mechanical whitespace cut;
- whitespace and surrogate-safe hard-limit fallbacks;
- avoiding a short final remainder when a better candidate exists;
- paragraph pause precedence;
- protection of URLs, dates, versions, decimals, measurements, and identifiers;
- no empty or over-limit units;
- source-span coverage of the normalized input without loss, duplication, or
  reordering, including a forced split inside an unbroken token;
- unchanged non-Vietnamese compatibility output.

The binding reconstruction assertion walks emitted unit spans in source order
and requires every uncovered gap to be whitespace-only. Ordinary
whitespace-separated Vietnamese prose may additionally be joined with one space
and normalized as a useful test, but that is not a universal invariant because
a forced split may occur inside an unbroken token. The reconstruction and
length invariants use a table of varied Vietnamese text and long
punctuation-sparse input. No property-testing dependency is required.

### 9.2 Synthesis coordinator unit tests

Tests use controllable deferred promises to force these orderings:

- prefetch for unit `N` completes after playback requests `N`;
- unit `N + 1` synthesis completes before unit `N`;
- speed changes while a job is running;
- stop or article replacement while jobs are running;
- prefetch failure followed by one foreground retry;
- stale source callbacks after session replacement.

Every case asserts that each unit index is played at most once and that played
indexes are contiguous and increasing.

### 9.3 Repository verification

Implementation verification requires:

```text
pnpm test:unit
pnpm build
pnpm test:e2e
git diff --check
```

Human listening must include long sentences, consecutive short sentences,
mixed punctuation, and samples previously perceived as repeating or
stuttering. The reviewer records whether the repetition is a whole-unit replay
or an acoustic repetition inside a single buffer.

## 10. Success criteria

- Speech segmentation uses the preferred range as a soft scoring signal, not a
  fixed 200-character cut.
- Vietnamese units prefer meaningful boundaries and never exceed 300 code
  units.
- The segmentation output contains every normalized source character exactly
  once, apart from normalized inter-unit whitespace.
- A synthesis result cannot be played for a different unit index, session, or
  speed version.
- Delayed and out-of-order synthesis results do not repeat, skip, or reorder
  speech units.
- Non-Vietnamese behavior remains unchanged.
- No dependency, model, network call, telemetry, or new user setting is added.

## 11. Non-goals

- Replacing the Vietnamese normalizer or abbreviation scorer.
- Applying the weighted policy to every supported language in this change.
- Solving model-internal acoustic stutters by rewriting source text.
- Adding linguistic parsing, generative AI, or a heavyweight NLP package.
- Making segmentation weights user-configurable.
