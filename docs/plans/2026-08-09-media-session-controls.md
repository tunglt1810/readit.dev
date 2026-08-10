# Implementation Plan (TDD): System Media Controls (MediaSession)

**Date**: 2026-08-09
**Design**: `docs/specs/2026-08-09-media-session-controls-design.md`
**Spike**: `docs/specs/2026-08-09-media-session-spike-findings.md`

---

## Goal

Hardware media keys / Bluetooth headsets / OS Now Playing control playback without altering audio routing or adding new permissions.

The spike verified feasibility on macOS 26.6.1 / Chrome 151.

## How TDD changes the design

`navigator.mediaSession` does not exist in Node, so if the module called it directly, only a single mapping function would be testable. To enable test-first development across the entire module, the design must **inject dependencies** — matching the `createPauseKeepalive()` pattern used in `src/offscreen/pause_keepalive.ts:40` (tested via fake context in `tests/unit/pause_keepalive.test.ts`).

Two changes relative to the design spec:

1. `media_session.ts` exports factory `createMediaSessionController(session)` accepting `MediaSessionLike`, rather than free functions reading global state.
2. Metadata construction logic is extracted into a separate **pure function**, outside `background.ts` (a 1986-line file that cannot be unit-tested).

Both are genuine software improvements, not compromises made solely for testing.

## Boundaries: What TDD covers

| | |
|---|---|
| ✅ Test-first | State mapping, metadata construction, controller (handler registration, error handling, lifecycle), queue skipping via E2E |
| ⚠️ Refactoring with safety net | Extracting handler bodies in `offscreen.ts` — no new behavior, using existing E2E as safety net |
| ❌ Manual testing only | Whether OS displays Now Playing tile, whether hardware media keys emit actions. Unreachable by any API. |

Do not pretend to test items under category ❌.

---

## Step 0 — Verification of design §4.4 ⚠️ point ✅ DONE

Conclusion (details in design §4.4): skip **cannot** call `advanceQueueAfter` directly. `startPlayback` calls `stopActiveSession('session-replaced')` (`background.ts:815/821`), which resets the running session's item back to `'pending'` (`:690-693`) — overwriting `markDone` and causing skipped items to re-enter the queue. Additionally, `clearSession()` does not send `STOP` down to offscreen, so audio continues playing.

Fix: Add `'queue-skipped'` reason to `stopActiveSession` to bypass the queue state mutation step, and execute the skip handler in order: `stopActiveSession('queue-skipped')` → `advanceQueueAfter()`.

Impact: Step 6 adds a modification in `stopActiveSession`, and E2E tests must include a case asserting skipped items do **not** revert to `pending`.

---

## Step 1 — RED/GREEN: State mapping

**RED** — `tests/unit/media_session.test.ts` (new), styled like `tests/unit/pause_keepalive.test.ts` (`node:test` + `node:assert/strict`):

```
toMediaSessionPlaybackState('playing') === 'playing'
toMediaSessionPlaybackState('loading') === 'playing'   ← anti-regression
toMediaSessionPlaybackState('paused')  === 'paused'
toMediaSessionPlaybackState('stopped') === 'none'
toMediaSessionPlaybackState('error')   === 'none'
```

Case `'loading'` has a separate assertion with comment: spike measured that mapping to `'none'` causes `playbackState` to flicker `playing → none → playing` at **every** paragraph boundary, because `reportProgress('loading')` runs inside `playNextUnit` (`offscreen.ts:728`). Covers all 5 `PlaybackStatus` values (`shared/types.ts:47`).

→ `pnpm test:unit` **RED** (module does not exist yet).

**GREEN** — `src/offscreen/media_session.ts`, pure mapping function only.

→ `pnpm test:unit` GREEN.

---

## Step 2 — RED/GREEN: Metadata construction

**RED** — `tests/unit/media_session_metadata.test.ts` (new):

| Input | Expected |
|---|---|
| article, `source = {title:'Article X', url:'https://vnexpress.net/a'}` | `{title:'Article X', artist:'vnexpress.net'}` |
| `contentScope:'selection'` | `{title:<selected label>, artist:'vnexpress.net'}` — **no** content text |
| `contentScope:'manual'` | `{title:<manual label>, artist:'readit.dev'}` |
| unparseable URL | no throw, artist fallback `'readit.dev'` |
| empty / whitespace title | fallback `'readit.dev'`, no empty title |

Selection/manual cases assert **negative**: title must not contain user text. This is an agreed privacy constraint (title appears on Now Playing and potentially lock screens), so a test must enforce it, not just documentation.

→ RED.

**GREEN** — `src/shared/media_session_metadata.ts` (new), pure function `buildMediaSessionMetadata(input): { title, artist }`. i18n labels passed as parameters so function has no dependency on `chrome.i18n` — tests require no mocks.

→ GREEN.

---

## Step 3 — RED/GREEN: Controller

**RED** — add to `tests/unit/media_session.test.ts`, fake `MediaSessionLike` in the same way `pause_keepalive.test.ts` fakes `AudioContext`:

```ts
interface MediaSessionLike {
	metadata: unknown;
	playbackState: string;
	setActionHandler(action: string, handler: (() => void) | null): void;
}
```

Cases:
1. `sync('playing')` → `session.playbackState === 'playing'`
2. `setMetadata({...})` → `session.metadata` has correct title/artist/album
3. `clear()` → `session.metadata === null`
4. `install()` → registers `play`/`pause`/`stop`; calling registered handler → corresponding callback runs exactly once
5. **`setActionHandler` throws `NotSupportedError` on `'pause'`** → `'play'` and `'stop'` still register, `install()` does not throw externally
6. `setNextTrack(handler)` → registers `'nexttrack'`; `setNextTrack(null)` → calls `setActionHandler('nexttrack', null)` to **remove button**, rather than ignoring
7. No `previoustrack` / `seekto` / `seekbackward` / `seekforward` registered

Cases 5 and 7 are error classes that do not expose themselves during manual testing: 5 only appears on different Chrome versions, 7 appears only as inactive extra buttons.

→ RED.

**GREEN** — `createMediaSessionController(session)` in `media_session.ts`. Guard `navigator.mediaSession` at **call site** in `offscreen.ts`, not inside controller — controller remains pure interface so it can be tested.

→ GREEN.

---

## Step 4 — Refactoring: Extracting handler bodies

No new behavior → no new tests written. Existing test suite serves as safety net.

Three branches in `handleOffscreenMessage` inline in `switch` (`offscreen.ts:1301-1339`) extracted into module-level functions:

```ts
async function resumePlayback(): Promise<void>    // :1301-1312
async function pausePlayback(): Promise<boolean>  // :1316-1332, false when audioCtx not running
function stopPlayback(): void                     // :1335-1339
```

`switch` calls them, keeping `sendResponse` intact.

→ **verify**: `pnpm test:unit` + `pnpm test:e2e` (especially `tts-controls.spec.ts`, `reading-state.spec.ts`) pass **exactly as before**. Run e2e once prior to refactoring for baseline comparison.

---

## Step 5 — Connecting to offscreen

Logic tested in Steps 1-3; this step is wiring only.

| Location | Action |
|---|---|
| `reportProgress()` `:231` | After `playbackStatus = status` → `controller.sync(status)` |
| `PLAY`, non-resume branch, after `:1191` | `controller.setMetadata(payload.mediaSession)` |
| `stopAudio()` `:600` | After `reportProgress('stopped')` → `controller.clear()` |
| `registerOffscreenMessageHandler()` `:1406` | Construct controller from `navigator.mediaSession` (ignore if unavailable) + `install()` |

Do not modify `playAudioBuffer()` — audio routing remains `source.connect(audioCtx.destination)`.

→ **verify**: `pnpm test:e2e` passes; build + load unpacked, play an article, offscreen Console **no longer** flickers `none` between paragraphs.

---

## Step 6 — RED/GREEN: Queue skipping (E2E)

**RED** — add case to `tests/e2e/playlist-queue.spec.ts`, using `chrome.runtime.sendMessage` like existing case at `:219`:

- Queue 2 articles, playing article 1 → send `{action:'SKIP_TO_NEXT_QUEUE_ITEM'}` → article 1 becomes `done`, article 2 becomes `playing`
- Playing **last article** → send skip → last article becomes `done`, no new session

Executable via message without needing physical media keys — that part remains manual.

→ RED.

**GREEN**:

`src/background/offscreen_transport.ts` — add to `OffscreenPlayPayload` (`:19-28`):
```ts
mediaSession?: { title: string; artist: string };
hasNextQueueItem?: boolean;
```

`src/background/background.ts`:
1. Build `mediaSession` at `playPayload` (`:904-915`) using `buildMediaSessionMetadata()` from Step 2, passing labels via `t()`.
2. Extract `advanceQueueAfter(queueItemId, tabId)` from block `:1359-1366`. `applyProgressMessage` calls it in `completedNaturally` branch as before. `markDone` + `getNextPending` are pure functions covered by `tests/unit/playlist_queue.test.ts` — helper is glue only.
3. Handle `SKIP_TO_NEXT_QUEUE_ITEM` → `advanceQueueAfter` with `queueItemId` of running session. Apply Step 0 conclusions regarding `clearSession()`.
4. `hasNextQueueItem` calculated when building `playPayload`; offscreen registers `nexttrack` only when flag is enabled.

`src/shared/locales/{en,vi}.json` — 2 keys:
`mediaSessionSelectedText`, `mediaSessionManualText`.

→ **verify**: `pnpm test:e2e playlist-queue.spec.ts` GREEN; `pnpm test:unit` GREEN; `pnpm validate:manifest:chrome` and `validate:manifest:firefox` pass.

---

## Step 7 — Manual verification

Remaining items unreachable by API. `pnpm build:chrome` → load unpacked `dist/chrome`:

1. News article → Now Playing shows correct title + hostname
2. F8 → pause/resume, Popup/Side Panel UI updates accordingly
3. Highlighted selection → "Selected text", **no** content displayed
4. Manual Reader → "Manual text"
5. Queue ≥ 2 articles → OS next button switches article; last article has no next button
6. Stop → Now Playing tile disappears
7. Full stop → `chrome://media-internals` has no remaining session

---

## Files

| File | |
|---|---|
| `tests/unit/media_session.test.ts` | new — Steps 1, 3 |
| `tests/unit/media_session_metadata.test.ts` | new — Step 2 |
| `tests/e2e/playlist-queue.spec.ts` | added skip case — Step 6 |
| `src/offscreen/media_session.ts` | new — mapping + controller |
| `src/shared/media_session_metadata.ts` | new — pure function for metadata construction |
| `src/offscreen/offscreen.ts` | extracted 3 functions + 4 connection points |
| `src/background/offscreen_transport.ts` | 2 payload fields |
| `src/background/background.ts` | metadata + `advanceQueueAfter` + `SKIP_TO_NEXT_QUEUE_ITEM` |
| `src/shared/locales/{en,vi}.json` | 2 keys |

Untouched: `public/manifest.json`, `src/popup/`, `src/sidepanel/`, `src/content/`, `playAudioBuffer()`.

## Uncovered

- Bluetooth headsets not directly tested (F8 works, so handler pipeline is verified).
- Windows / Linux not tested — requires separate confirmation prior to release.
- Firefox out of scope: no `chrome.offscreen`, rsbuild strips permission (`rsbuild.config.ts:43`).
