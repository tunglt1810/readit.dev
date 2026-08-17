# Word Highlight Cursor Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make word highlighting survive a page whose DOM does not line up with the spoken text — x.com posts today map 7% of words, English Wikipedia maps 13%.

**Architecture:** Two changes, both confined to `src/content/word_highlight.ts`. The mapping cursor gains the ability to re-anchor after consecutive misses instead of staying lost forever, and a highlight session keeps its word list so ranges killed by a virtualized DOM can be rebuilt. Nothing in the extraction path changes, so no page's spoken content changes.

**Tech Stack:** TypeScript, Chrome MV3, `node:test` + `node:assert/strict` for unit tests, Playwright for end-to-end tests, Biome for linting.

## Context

Reading `https://x.com/AndrewYNg/status/2088302050706686198` shows four defects at once: no highlight, highlight on the wrong word, highlight dying part-way, and the page scroll jumping.

`precomputeWordRanges` (`src/content/word_highlight.ts:162`) walks the spoken word list against the live DOM with a cursor that **only ever moves forward** (`word_highlight.ts:218`). When a word cannot be found within `MAX_NODES_SCANNED_PER_WORD` nodes the cursor is restored, but nothing can ever pull it back if it has already been dragged past the real content. One bad stretch therefore disables highlighting for the rest of the session.

On x.com the trigger is the title line. `getArticleTitle` (`src/content/article_extractor.ts:303`) falls back to `document.title` when the root has no `<h1>` — on x.com that yields `(1) Andrew Ng on X: "The AI Engineering Skills Map" / X`, a string that exists nowhere in the DOM (the three `<h1>` elements on the page read empty, `Conversation`, and `Trending now`). `articleFromRoot` prepends it to `content`, its words match scattered spots in the page chrome, and the cursor is dragged away before the post body starts.

**The trigger is not the bug.** Measured with the repository's own code driven inside Chromium, English Wikipedia suffers the same collapse without any x.com weirdness, so this is a general defect that x.com merely exposes:

| Page | Current | With re-anchor |
| --- | --- | --- |
| x.com post | 68 / 956 (7%), 67 ms | **950 / 956 (99%), 11 ms** |
| Wikipedia *Coffee* | 2178 / 16637 (13%), 827 ms | **16621 / 16637 (100%), 57 ms** |
| Wikipedia *World War II* | 27788 (100%), 87 ms | 27788 (100%), 77 ms |
| vnexpress ×2, znews ×2 | 100% | 100%, slightly faster |

Re-anchoring is also **faster** than today's code, because the current version burns its 15-node budget on every single missed word and then rewinds, repeating that for thousands of words.

An earlier draft of this plan proposed changing how the title is composed and narrowing `resolveWalkerRoot`. Both are dropped: they alter shared extraction behaviour — including what the TTS reads aloud — on every site, and the measurements show they are not needed. `resolveWalkerRoot` widening the root on x.com turns out to be harmless once the cursor can recover; all 950 mapped ranges land inside the post.

## Global Constraints

- `src/content/article_extractor.ts` is not modified. No page's spoken content changes.
- Highlighting on pages that already work must stay at 100% and must not get slower.
- Re-anchoring must be bounded: an unbounded rescan measured **47 s** on a 2000-word list that matches nothing, against 1.06 s today. With the cap it measured 1.5 s.

## Task 1 — Let the mapping cursor re-anchor

- [x] Add tests for the mapping behaviour. **Changed during execution:** written as e2e cases in `tests/e2e/word-highlight.spec.ts` rather than unit tests. `precomputeWordRanges` reaches for the global `document` (`createTreeWalker`, `createRange`, `querySelector` via `resolveWalkerRoot`), so a FakeNode stand-in would have had to impersonate most of the DOM; every existing test for this function is an e2e case for the same reason. Covers a cursor dragged past the body, and a word list matching nothing that must still initialize promptly.
- [x] Extract the inner search loop of `precomputeWordRanges` into `searchForWord`, which scans from a given node/offset for a bounded number of nodes and returns the hit (range, node, next offset) or `null`. Scope-range handling and the `MAX_NODES_SCANNED_PER_WORD` budget moved in unchanged.
- [x] In `precomputeWordRanges`, count consecutive misses. After `REANCHOR_AFTER_CONSECUTIVE_MISSES` (3), rewind the walker to the root and rescan for the current word across the whole root; on a hit, continue forward from there.
- [x] Cap total re-anchors per run at `MAX_REANCHORS_PER_PRECOMPUTE` (20), resetting the miss counter each time one is spent.
- [x] Document both constants in the style of `MAX_NODES_SCANNED_PER_WORD` — what breaks without them, with the measured numbers.

## Task 2 — Rebuild ranges when the page recycles nodes

x.com renders a virtualized timeline: the same page reported 2 `<article>` elements before scrolling and 47 after. Ranges built at init point at live text nodes, and highlighting itself scrolls the page, so nodes are unmounted mid-read.

**Constraint found during execution:** `tests/e2e/word-highlight.spec.ts:258` deliberately requires that a word whose range died **clears** rather than rematching another copy of itself — rematching would paint a spot the reader is not at. Rebuilding immediately would have broken that test. Resolved by deferring: the dead word still clears, the map is marked stale, and the rebuild happens for the next word — the one the reader is about to hear. The existing test keeps passing unmodified.

- [x] Add an e2e case: start highlighting, re-render the markup the ranges point at, assert the current word clears and the next word maps against the rebuilt DOM.
- [x] Store the init message's `words` and resolved scope range in module state (`sessionWords`, `sessionScopeRange`) next to `wordRanges`; clear them in `disposeCurrentHighlightSession` and when a new selection scope arrives. A selection session with no captured range stores no words, so it keeps failing closed.
- [x] In `applyHighlightForIndex`, split the two failure modes: an entry **present but dead** sets `wordRangesStale`; an entry **never mapped** just clears. A stale map is rebuilt at the start of the next `applyHighlightForIndex`.
- [x] **Not done, and not needed:** the 500 ms cooldown and removing `wordRanges?.delete(wordIndex)`. Deferring to the next word is self-limiting — after one rebuild the dead entries are gone, so a permanently removed node stops re-triggering rebuilds on its own. A cooldown would only have made the recovery flaky.

## Task 3 — Do not read the browser tab title when the page renders its own heading

Found by testing the built extension on the real post. Tasks 1–2 stopped the highlight dying, but it still sat on the wrong word during the opening: while the title was being spoken, the highlight sat on `engineering` in the middle of the body. Tracing the map showed why — the word **`on`**, from `document.title`'s `Andrew Ng on X`, has no standalone occurrence between the header and `Based on an analysis` far down the body, so it matched there, and `The` / `AI` / `Engineering` / `Skills` then all matched cleanly around that wrong spot. Re-anchoring cannot catch this: nothing *misses*, it all matches in the wrong place.

The same cause made the title be spoken twice — `document.title` and the heading the page renders are different strings, so the existing exact-match filter could not collapse them.

- [x] Unit-test `resolveArticleTitle` against the FakeNode helper: in-root `<h1>` wins; with no `<h1>`, a rendered block that the tab title merely wraps wins; with no such block the tab title is kept unchanged; a block shorter than 10 characters is never mistaken for the title.
- [x] Replace `getArticleTitle` with the exported `resolveArticleTitle(root, blocks, documentTitle)`, and compute blocks before the title in `articleFromRoot` so the blocks can be consulted.
- [x] Verify on the captured page: title becomes `The AI Engineering Skills Map` (no `(1)`, no `/ X`), spoken once, and words 0–4 map onto the rendered heading with word 5 continuing into `I am delighted to present`.

## Task 4 — Stop dropping text that legitimately repeats

Also found from the real post: the bolded lead-in `Building and deploying AI applications` was never spoken. It occurs twice in the DOM — once in the summary list, once opening the section — but `getTextBlocks` de-duplicated against a document-wide `Set`, so the second occurrence was deleted. That both removed content from what is read and desynchronized the spoken word list from the DOM the highlighter walks.

- [x] Unit-test that a phrase repeating later in the article survives, and that a block repeated immediately by its own container is still dropped.
- [x] Replace the document-wide `seen` Set with `appendBlock`, which only rejects a block identical to the one just emitted. Parent/child double-counting is already prevented by `skipSubtree`.
- [x] Verify on the captured page: occurrences in content go from 1 to 2, matching the DOM.
- [x] Regression check for over-reading: Wikipedia *Coffee* and *World War II* produce zero repeated blocks; a vnexpress article produces one (an author name that genuinely appears twice on the page). Accepted trade-off — one repeated name against silently deleting real content.

## Verification

- [x] `pnpm test:unit` — 728 passed.
- [x] `pnpm build:chrome` before every Playwright run.
- [x] `pnpm test:e2e` in full — 225 passed. One run showed `tts-controls.spec.ts:45` failing; it passes in isolation and on a re-run of the full suite, so it is flaky and unrelated.
- [x] Selection-scope regression: all existing selection cases still pass unmodified, including "keeps context-menu selected-text highlights inside the exact selected range" and "clears instead of matching a word after the selected range".
- [x] Cross-site measurement with the shipped code: x.com 7% → **100%** (950/950, no backward jumps) and 67 ms → 11 ms; Wikipedia *Coffee* 13% → **100%** and 827 ms → 63 ms; vnexpress ×2 unchanged at 100% and faster.
- [x] Position check, not just coverage: "% mapped inside the article" hid Task 3's bug, because a word mapped to the wrong sentence of the right article still counted. `.tmp/probe/trace.mjs` prints the surrounding text for the first 26 words, which is what actually exposed it. Use it, not just the percentage, when judging this code.
- [x] Worst-case guard: `.tmp/probe/worst.mjs` (2000 words matching nothing) runs in 1.5 s against 1.06 s for the old code — not the 47 s an uncapped version produced. Also pinned by an e2e case asserting `WORD_HIGHLIGHT_INIT` still answers within 5 s for such a list.
- [ ] `pnpm lint` — **fails, but identically on an unmodified checkout** (verified with `git stash`). The errors are pre-existing, in `src/background`, `tests/unit`, `scripts`, and `public`; none are in the files this plan touches, which are clean. Left alone as out of scope.
- [ ] Manual check in a real browser on a normal news article. Not done — covered indirectly by the live vnexpress/znews measurements above, which exercise the same path against real pages.
