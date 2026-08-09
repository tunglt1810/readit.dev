# Background Command Queue Responsiveness Implementation Notes

**Date:** 2026-08-09
**Status:** Implemented
**Scope:** `src/background/` command serialization and playback-status sharing across surfaces

## Problem

Every UI surface froze for seconds after any playback start. Reproduced with Playwright against
`dist/chrome`, dispatching the real context-menu handler with the Side Panel open:

```
queue-response(GET_PLAYBACK_STATE) = TIMEOUT>8s
panel updates = ["null","loading","loading","loading","loading","playing"]
```

The `PLAYBACK_STATE_UPDATE` broadcast was healthy the whole time. The defect was that the background
serialized *everything* — reads, control commands, progress updates and word-highlight relays — on
one FIFO promise chain (`enqueue`, `background.ts`), and `startPlayback` held that chain while
awaiting `modelCacheWarmer.waitForCurrentWarm()` and `setupOffscreen()` →
`chrome.offscreen.createDocument()`, which resolves only after the offscreen document has loaded
onnxruntime plus a ~24 MB wasm.

## What changed

1. **`src/background/command_queue.ts` (new).** The lane is extracted from `background.ts` as
   `createCommandLane()` → `{ enqueue, runQueuedEvent }`. `runQueuedEvent` is for callers with no
   response channel (context-menu clicks, tab events, progress messages); previously those used bare
   `void enqueue(...)` and turned any throw into an unhandled service-worker rejection.

2. **`startPlayback` split.** The lane now holds only the session transition — preempt/stop the
   previous session, build the session, assign `activeSession`, `readableSurface.activate`,
   `publishSession` — and returns. The selection-scope tab message, model warm, offscreen setup and
   `PLAY` dispatch moved into `loadAndPlay()`, which runs off-lane and re-checks
   `activeSession?.sessionId` before dispatching, reusing the existing `failPendingStart()` guard.

3. **`settlePendingStart()`.** A start now answers before the offscreen document exists, so any later
   *session transition* must wait for it: `stopActiveSession`, `preemptManualForWeb`,
   `routeSessionCommand` and `changeSpeed` await it. Without this, `CHECKPOINT_MANUAL` and
   `CHANGE_SPEED` reached a document that was not up yet.

4. **`setupOffscreen` is single-flighted** with `createSingleFlight`, moved from
   `src/offscreen/single_flight.ts` to `src/shared/single_flight.ts` so the background can use it.
   Document creation is no longer serialized by the lane, and `dispatchOffscreenCommand`'s retries
   can now ask for it concurrently.

5. **`src/shared/playback_status.ts` (new).** `resolvePlaybackStatus()` replaces the
   `loading → playing` derivation that was duplicated in the popup and Side Panel, missing in the
   document reader, and skipped by the Side Panel's own manual block.

## Deliberately not done

- **Reads off the lane.** Answering `GET_PLAYBACK_STATE` without the lane broke causal ordering: a
  surface that sends START then immediately reads could observe pre-start state
  (`tests/e2e/selection-button.spec.ts:215`). With the lane no longer held for seconds, reads are
  already fast on it.
- **A separate lane for word-highlight relays.** `deliverWebsiteUpdate` drops any update arriving
  before `READABLE_SURFACE_INIT` sets `websiteReady`, and that init is a session-lane operation, so a
  relay on its own lane can overtake it and silently lose the highlight
  (`tests/e2e/word-highlight.spec.ts:311`).

## Follow-ups completed in the same pass

- **Selected-text language detection.** `createSelectedTextArticle` now resolves `lang` with the
  existing `detectContentLanguage()` (`src/shared/language_detection.ts`, already used by the PDF and
  Google Docs paths) instead of trusting the page declaration alone. The context-menu path reads that
  declaration through a `chrome.scripting.executeScript` that fails silently wherever the extension
  cannot inject, and the resulting `na` made `preparePlaybackUnits` skip Vietnamese normalization
  entirely. This covers both selection entry points.
- **`word-highlight.spec.ts:311`.** Commit `2dddbb4` made centred scrolling animated
  (`behavior: 'smooth'`), so asserting `window.scrollY` on the same tick the highlight lands was
  racing the animation. Changed to `expect.poll`, matching the sibling test at `:333`.

Still open, deliberately not changed: the *article* path resolves language from
`document.documentElement.lang` only (`src/content/content_script.ts:13`,
`src/content/article_extractor.ts:308`, which defaults to `en`), so a Vietnamese page that declares
the wrong language also loses normalization. Applying detection there changes behaviour for every
article read, so it is left as a separate decision.

## Verification

- `tests/e2e/playback-queue-responsiveness.spec.ts` pins offscreen creation to 3 s and asserts a
  state read still answers in under 1 s. Confirmed to fail on the pre-fix behaviour (3045 ms) and
  pass after.
- `tests/unit/command_queue.test.ts` covers FIFO ordering, rejection isolation, and that
  `runQueuedEvent` consumes rejections.
- `pnpm test:unit` 562/562; `pnpm evaluate:vi` f1 and preservation both 1.0; `pnpm build`
  (chrome + firefox) and both `tsc` targets clean.
- Full Playwright suite **180/180**.
