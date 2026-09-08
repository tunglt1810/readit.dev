# Title Pause Preservation Implementation Plan

**Goal:** Stop the article title from being swallowed into the first body paragraph, so the reader pauses for its full 260 ms before starting the article.

**Architecture:** One change, confined to `src/offscreen/short_segment_consolidation.ts`. The range table refuses to extend past a leading unit that is a whole paragraph without terminal punctuation, so no feasible partition can absorb the title. Planning, extraction, and the R9 objective are untouched.

**Tech Stack:** TypeScript, Chrome MV3, `node:test` + `node:assert/strict` for unit tests, Biome for linting.

Design: `docs/specs/2026-09-08-title-pause-preservation-design.md`

## Context

Measured on the real article `mua-giay-o-nha-trang-gui-sang-nga-moi-phat-hien-hang-gia-5118064`:

```
#0 pause=260 | text="…mới phát hiện hàng giả Khánh Hòa Một phụ nữ mua hai đôi giày…"
```

The title is 43 non-whitespace code points, under `MIN_RELIABLE_SYNTHESIS_CHARACTERS = 50`, so `consolidateShortSpeechUnits` merges it rightward and `mergeSpeechUnits` adopts the right unit's `pauseAfterMs`.

The broad fix — pinning every paragraph-final unit without terminal punctuation — was measured and rejected: the six-item bullet-list fixture in `tests/unit/playback_preparation.test.ts` drops from three consolidated units to six short ones.

## Global Constraints

- The R9 lexicographic objective and its three-pass structure are not rewritten. Pinning is a feasibility constraint on row 0 of the range table.
- Compatibility-path output (`pauseAfterMs === null`) must not change.
- Existing consolidation behaviour for non-leading units — including the compensating `.` in `synthesisText` — stays as is.

## Task 1 — Failing test for the title pause

- [x] Add a unit test in `tests/unit/playback_preparation.test.ts` using the VnExpress title and sapo: `preparePlaybackUnits` must return the title as unit 0 with `pauseAfterMs === 260`, and the sapo as a separate unit.
- [x] Add a companion case: a leading paragraph that ends in a full stop keeps merging as it does today.
- **Verify:** `bun test tests/unit/playback_preparation.test.ts` fails on the new title assertion and passes the full-stop case.

## Task 2 — Pin the leading title in consolidation

- [x] In `src/offscreen/short_segment_consolidation.ts`, add a predicate for "leading unit is a title": `pauseAfterMs >= LATIN_PAUSE_MS.paragraphEnd` and not ending in `[.!?…]`.
- [x] In `buildFeasibleRanges`, stop row 0 after its singleton range when that predicate holds.
- **Verify:** `bun test tests/unit/playback_preparation.test.ts` passes, including the new title case.

## Task 3 — Reconcile the fixtures that encoded the old behaviour

- [x] Update `tests/unit/playback_preparation.test.ts` cases that assert a leading heading merges into the body (`Heading`, `Đề mục`, `Tiêu đề`, `DATA STRATEGY`) to assert the pinned-title output instead.
- [x] Check `tests/unit/short_segment_consolidation_foundation.test.ts` heading fixtures; where a case is about mid-article merging rather than the leading unit, keep its intent by not placing the heading first. **Changed during execution:** a `capacityFillingLead` unit was added so the short unit under test can only merge rightward, which is what those cases were actually asserting.
- [x] Relax the "no mergeable short unit may survive" invariant in `tests/unit/short_segment_consolidation.test.ts` for the pinned leading headline, and update `tests/unit/word_map.test.ts` to exercise a merge that is not at index 0. **Discovered during execution:** this invariant, not the fixtures, was the real cost of the change — see the spec section "The Invariant This Relaxes".
- **Verify:** `bun test tests/unit` passes in full — 853 pass, 0 fail.

## Task 4 — Confirm on the real article and refresh the graph

- [x] Re-run the planner over the extracted VnExpress text and confirm the title is its own unit with a 260 ms pause.
- [x] Run `bunx biome check` on the touched files and `graphify update .`.
- **Verify:** clean lint, planner output shows the title separated, graph updated.
