# Design: System Media Controls (MediaSession)

**Date**: 2026-08-09
**Status**: Design — ready to implement
**Proposal**: superseded and deleted by this spec — see commit `431f393` for the original
**Spike**: `docs/specs/2026-08-09-media-session-spike-findings.md`

---

## 1. Context

Playback can currently only be controlled from inside the extension. The
proposal suggested registering `navigator.mediaSession` from the offscreen
document so hardware media keys, Bluetooth headsets, and the OS Now Playing
surface can control it.

The spike verified on macOS 26.6.1 / Chrome 151: **it works, with no change to
the audio path**. Pure Web Audio is enough for Chrome to build a media session;
bridging through `HTMLMediaElement` instead destroys the session and was ruled
out.

This spec settles what the proposal left underspecified, and corrects two things
it got wrong.

## 2. Three things the spike corrected in the proposal

| The proposal said | Reality |
|---|---|
| "Mirror `playbackState` in `reportProgress()`" | Right place, but the naive mapping makes the state flicker at every paragraph boundary — see §4.1 |
| "The article title already exists, no new extraction needed" | Extraction exists, but **the title never reaches offscreen**. `PlaybackContent` only carries `{content, lang}` — see §4.2 |
| "`nexttrack` is just reusing the auto-advance path" | The queue lives in the background; offscreen cannot reach it. Needs a new message plus a extracted helper — see §4.4 |
| "The tab audio indicator will get a title" | Wrong. The offscreen document is not a tab; the article tab shows no speaker icon. Drop it from user value. |

## 3. Principles

- MediaSession is only a **second entry point** into existing functions, not a
  parallel playback path.
- Every transition goes through exactly one place: `reportProgress()`
  (`src/offscreen/offscreen.ts:231`).
- Do not change `source.connect(audioCtx.destination)`.
- No new permissions.

## 4. Design

### 4.0 Testability determines the module's shape

Implementation is TDD (`docs/plans/2026-08-09-media-session-controls.md`), and
`navigator.mediaSession` does not exist in Node. Therefore:

- `src/offscreen/media_session.ts` exports a **factory**
  `createMediaSessionController(session: MediaSessionLike)`, not a function that
  reads the global itself. This matches the `createPauseKeepalive()` pattern
  already in use (`src/offscreen/pause_keepalive.ts:40`, with a fake context in
  `tests/unit/pause_keepalive.test.ts`).
- Metadata construction is extracted into a pure function in
  `src/shared/media_session_metadata.ts`, not left in `background.ts` (1986
  lines, not unit-testable).
- The `navigator.mediaSession` guard lives at the **call site** in
  `offscreen.ts`, not in the controller — the controller stays interface-pure so
  it can be tested.

### 4.1 Mirroring `playbackState`

`src/offscreen/media_session.ts` holds the pure mapping function:

```ts
export function toMediaSessionPlaybackState(status: PlaybackStatus): MediaSessionPlaybackState {
	switch (status) {
		case 'playing':
		case 'loading':
			return 'playing';
		case 'paused':
			return 'paused';
		default:
			return 'none';
	}
}
```

`'loading'` **must** map to `'playing'`. The reason (spike §5):
`reportProgress('loading')` runs at every unit boundary (`offscreen.ts:728` in
`playNextUnit`), so mapping `loading → 'none'` tells the OS "nothing to control"
over and over:

```
playbackState -> playing  (status=playing)
playbackState -> none     (status=loading)   ← every paragraph
playbackState -> playing  (status=playing)
```

Mid-session is still playing, just synthesising the next unit. Only `'stopped'`
and `'error'` are `'none'`.

Called from `reportProgress()`, immediately after `playbackStatus = status`.

### 4.2 Metadata — plumb the title from the background

Offscreen has no title. `OffscreenPlayPayload`
(`src/background/offscreen_transport.ts:19-28`) currently only carries
`documentTitle` (document-reader only). Add one field:

```ts
export type OffscreenPlayPayload = {
	// ...
	mediaSession?: { title: string; artist: string };
};
```

The background builds it at `playPayload` (`background.ts:904-915`) via the pure
function `buildMediaSessionMetadata()` in `src/shared/media_session_metadata.ts`,
from data that already exists — `input.source` for a tab source is
`{ kind: 'tab'; tabId; title; url }` (`shared/types.ts:134`). i18n labels are
passed in as parameters so the function does not depend on `chrome.i18n`:

| Flow | `title` | `artist` |
|---|---|---|
| Article (`website-dom` / `document-reader`) | `source.title` | `new URL(source.url).hostname` |
| Selection (`contentScope: 'selection'`) | `t('mediaSessionSelectedText')` | `new URL(source.url).hostname` |
| Manual Reader (`contentScope: 'manual'`) | `t('mediaSessionManualText')` | `'readit.dev'` |

**Decision**: manual and selection use a generic label and do **not** take the
opening of the content. The title shows on the OS Now Playing surface and
possibly the lock screen — pushing text the user pasted outside the browser is
an unnecessary leak.

Two new i18n keys in `src/shared/locales/en.json` and `vi.json`:
`mediaSessionSelectedText`, `mediaSessionManualText`.

Offscreen sets it via `controller.setMetadata(payload.mediaSession)` when
handling `PLAY` (the non-resume branch, after
`currentExtensionSessionId = sessionId` at `offscreen.ts:1191`); the controller
builds `new MediaMetadata({ title, artist, album: 'readit.dev' })`.

`album: 'readit.dev'` is fixed. No `artwork` — v1 has no thumbnail.

The pure function must survive bad input: an unparseable `url`, or a `title`
that is empty or whitespace-only → fall back to `'readit.dev'`, never throw and
never produce an empty title.

### 4.3 Action handlers — extract the bodies, do not copy them

Three branches in `handleOffscreenMessage` are currently inline in the `switch`
(`offscreen.ts:1301-1339`). Extract them into three module-level functions:

```ts
async function resumePlayback(): Promise<void>   // body of the PLAY-resume branch :1301-1312
async function pausePlayback(): Promise<boolean> // body of the PAUSE branch :1316-1332
function stopPlayback(): void                    // body of the STOP branch :1335-1339
```

The `switch` calls them and handles `sendResponse`; the MediaSession handlers
call the same functions. This is what "one entry point" in the proposal actually
means — the spike had to copy the bodies, leaving two versions, and that must
not be repeated when shipping.

`registerOffscreenMessageHandler()` (`offscreen.ts:1406`) builds the controller
from `navigator.mediaSession` (skipping if absent) and then calls
`controller.install({ play: resumePlayback, pause: pausePlayback, stop: stopPlayback })`.

The controller wraps `try/catch` around **each individual** `setActionHandler` —
Chrome throws `NotSupportedError` for actions it does not support, and one
failing action must not block the others. This behaviour has its own test (plan
step 3, case 5): it only surfaces on a different Chrome version, so manual
testing cannot catch it.

`previoustrack`, `seekto`, `seekbackward`, `seekforward`: **not registered**
(proposal §5).

### 4.4 `nexttrack` — via the background

The queue lives in the background (`playlistQueue`, `playQueueItem`, `markDone`,
`getNextPending`). Offscreen cannot access it, so `nexttrack` becomes a message.

**Background** — extract the auto-advance block at `background.ts:1359-1366`
into a helper:

```ts
async function advanceQueueAfter(queueItemId: string, tabId?: number): Promise<void> {
	playlistQueue = markDone(playlistQueue, queueItemId);
	await saveAndBroadcastQueue();
	const nextItem = getNextPending(playlistQueue);
	if (nextItem) {
		await playQueueItem(nextItem, tabId);
	}
}
```

`applyProgressMessage` calls it from the `completedNaturally` branch as before.
A new `SKIP_TO_NEXT_QUEUE_ITEM` message calls the same helper with the running
session's `queueItemId`.

**Decision**: skip marks the current item **`done`**, same as natural
completion. That is what "next" means in every music player, and leaving it
`pending` would make `getNextPending()` return the very item just skipped —
requiring a `'skipped'` status or a position cursor, disproportionate work.

**Verified (step 0)** — skip **cannot** call `advanceQueueAfter` directly.

Auto-advance runs after `clearSession()` (`background.ts:1357`), so
`activeSession` is already `null`. Skip runs while the session is alive, and its
path is:

```
advanceQueueAfter → markDone(item 1) → playQueueItem(item 2)
  → startCurrentPage → startPlayback
    → stopActiveSession('session-replaced')        (background.ts:815/821)
      → markQueueItemStatus(item 1, 'pending')     (background.ts:690-693)
```

`stopActiveSession` returns the running session's item to `'pending'`. That
overwrites the `markDone` that just ran, so **the item just skipped goes back
into the queue** and `getNextPending()` picks it again. Auto-advance is immune
because `activeSession` is already null, so `getQueueItemId()` returns
`undefined`.

Separately, `clearSession()` does **not** send `STOP` to offscreen — it only
cleans up background state. Auto-advance does not need it because offscreen
already stopped on its own (that is why it reported `'stopped'`). Skip has audio
still running and must actually stop it.

**Handling**: skip calls `stopActiveSession('queue-skipped')` first, and
`stopActiveSession` skips the queue status change for this reason:

```ts
if (queueItemId && _reason !== 'queue-skipped') {
	const releaseStatus = _reason === 'tab-removed' ? 'error' : 'pending';
	await markQueueItemStatus(queueItemId, releaseStatus);
}
```

That leaves `advanceQueueAfter` as the single place deciding the skipped item's
status, while `stopActiveSession` still owns the full teardown (`STOP` to
offscreen + `closeOffscreenWhenIdle`) like every other stop path.

Order inside the skip handler: capture `queueItemId` + `tabId` from
`activeSession` → `stopActiveSession('queue-skipped')` →
`advanceQueueAfter(queueItemId, tabId)`.

**Conditional registration**: `nexttrack` should only appear when there really
is a next item — a "next" button that does nothing is worse UX than no button.
The background computes `hasNextQueueItem: boolean` while building `playPayload`
and sends it along; offscreen only calls `setActionHandler('nexttrack', ...)`
when the flag is set, otherwise sets `null` to remove it.

*Known tradeoff*: the flag is computed at playback start. If the user edits the
queue mid-article, the next button can be out of sync until the following item.
Accepted for v1 — real-time sync would need another broadcast channel, not worth
it for v1.

### 4.5 Lifecycle

- **Session start** (`PLAY`, not resume): set metadata, register handlers,
  `playbackState` follows `reportProgress` as usual.
- **End / stop**: inside `stopAudio()`, after `reportProgress('stopped')` —
  `navigator.mediaSession.metadata = null`. Without clearing metadata, Now
  Playing keeps the stale tile after stopping.
- **Offscreen closes**: `closeOffscreenWhenIdle()` (`background.ts:1369`)
  destroys the document and the media session goes with it. No extra cleanup
  needed.
- **Firefox**: the `if (!navigator.mediaSession) return;` guard is a runtime
  feature check, **not** a browser gate — do not read it as "this module only
  runs on Chrome". `firefox_background.ts:2` imports `offscreen.ts` into the
  background script, so the module does ship to Firefox. What makes it inert
  there is that `install()` lives in `registerOffscreenMessageHandler()`, which
  only `offscreen_entry.ts` calls. See
  `2026-08-09-media-session-spike-findings.md` §8.

## 5. Files

| File | Change |
|---|---|
| `src/offscreen/media_session.ts` | **New** — `toMediaSessionPlaybackState()` + `createMediaSessionController(session)` |
| `src/shared/media_session_metadata.ts` | **New** — pure function `buildMediaSessionMetadata()` |
| `src/offscreen/offscreen.ts` | Extract `resumePlayback`/`pausePlayback`/`stopPlayback`; call `controller.sync()` in `reportProgress()`; `setMetadata()` on `PLAY`; `clear()` in `stopAudio()`; build + `install()` the controller in `registerOffscreenMessageHandler()` |
| `src/background/offscreen_transport.ts` | Add `mediaSession?` and `hasNextQueueItem?` to `OffscreenPlayPayload` |
| `src/background/background.ts` | Build metadata at `playPayload`; extract `advanceQueueAfter()`; handle `SKIP_TO_NEXT_QUEUE_ITEM` |
| `src/shared/locales/{en,vi}.json` | 2 new keys |
| `tests/unit/media_session.test.ts` | **New** — mapping + controller |
| `tests/unit/media_session_metadata.test.ts` | **New** — metadata builder |
| `tests/e2e/playlist-queue.spec.ts` | Add a skip case via `SKIP_TO_NEXT_QUEUE_ITEM` |

Untouched: `public/manifest.json`, `src/popup/`, `src/sidepanel/`,
`src/content/`, and the audio path in `playAudioBuffer()`.

## 6. Verification

Implement test-first — the step-by-step RED/GREEN order is in
`docs/plans/2026-08-09-media-session-controls.md`.

**Unit** (`pnpm test:unit`):

- `toMediaSessionPlaybackState()` — all 5 `PlaybackStatus` values, with
  `'loading' → 'playing'` carrying its own commented assertion (a regression
  guard for exactly the §4.1 bug).
- `buildMediaSessionMetadata()` — 3 flows plus bad input (unparseable url, empty
  title). The selection/manual cases assert **negatively**: the title must not
  contain user text — a privacy constraint needs a test holding it, not just a
  line in a doc.
- `createMediaSessionController()` — with a fake `MediaSessionLike`:
  sync/setMetadata/clear, `install()` registering all 3 actions and invoking the
  right callback, one action throwing while the others still register,
  `nexttrack` set to `null` to **remove** the button, and
  `previoustrack`/`seekto`/`seekbackward`/`seekforward` never registered.

**E2E** (`pnpm test:e2e playlist-queue.spec.ts`): send
`SKIP_TO_NEXT_QUEUE_ITEM` through `chrome.runtime.sendMessage` (existing pattern
at `:219`) — the current item becomes `done`, the next becomes `playing`; on the
last item no new session starts.

**Regression guard for the §4.3 refactor**: run `pnpm test:e2e` **before**
extracting the functions to get a baseline, then compare after. Without a
baseline, "still green" proves nothing.

**Manual** — the part no API can reach, on `dist/chrome` loaded unpacked:

1. Play an article → Now Playing shows the correct title + hostname.
2. Hardware media key (F8) → pause/resume, and the Popup/Side Panel UI follows.
3. Offscreen console: `playbackState` no longer drops to `none` at paragraph
   boundaries.
4. Read a selection → Now Playing shows "Selected text", not the content.
5. Manual Reader → shows "Manual text".
6. Queue with ≥ 2 items → the OS next button advances; the skipped item becomes
   `done`; on the last item the next button does not appear.
7. Stop → the Now Playing tile disappears with nothing left behind.
8. Full stop → offscreen closes and `chrome://media-internals` shows no session.

**Not covered** (inherited from the spike): Bluetooth headsets not tested
directly; Windows/Linux not tested.
