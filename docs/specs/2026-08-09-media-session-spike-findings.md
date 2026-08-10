# Spike Findings: MediaSession from the offscreen document

**Date**: 2026-08-09
**Status**: DONE
**Conclusion**: ✅ Feasible — the proposal can proceed as written
**Related**: `docs/specs/2026-08-09-media-session-controls-design.md` (the original proposal was superseded and deleted — see commit `431f393`)

---

## 1. The question

The proposal suggested registering `navigator.mediaSession` in the offscreen
document so hardware media keys, Bluetooth headset buttons, and the OS Now
Playing surface could control playback. The proposal itself flagged this as the
one point that could not be proven by reading source.

Exploring the codebase surfaced a risk the proposal had not raised:

- Playback runs on **pure Web Audio API**: `audioCtx.createBufferSource()` →
  `source.connect(audioCtx.destination)` (`src/offscreen/offscreen.ts:658-663`).
- The pause keepalive is also an `OscillatorNode` (`src/offscreen/pause_keepalive.ts:132-141`).
- **There is no `<audio>`/`<video>` element anywhere in the codebase.**

The hypothesis at the time: Chrome builds a media session from
`HTMLMediaElement`, so pure Web Audio might create no session for
`setActionHandler()` to attach to. The spike therefore tested two options:

- **A** — mediaSession on pure Web Audio (exactly as the proposal described).
- **B** — bridge `AudioContext` → `MediaStreamAudioDestinationNode` → `<audio srcObject>`.

**That hypothesis was refuted.** See section 4.

## 2. Environment

| | |
|---|---|
| macOS | 26.6.1 |
| Chrome | 151.0.7922.76 |
| Probe branch | `spike/media-session-offscreen` (reverted after measuring) |

## 3. Probe code

Throwaway: `src/offscreen/media_session_probe.ts` plus 4 hook points in
`offscreen.ts` (import, `reportProgress()`, `playAudioBuffer()`,
`registerOffscreenMessageHandler()`). The `play`/`pause`/`stop` handlers copied
the bodies of the `PAUSE` / resume / `STOP` branches in `handleOffscreenMessage`
verbatim (`offscreen.ts:1301-1339`). Both probes shipped in one build; B was
enabled at runtime via `__readitMediaSessionProbe.setBridge(true)`.

## 4. Results

### Probe A — pure Web Audio ✅

| # | Check | Result |
|---|---|---|
| 1 | `navigator.mediaSession` exists in the offscreen doc | ✅ yes |
| 2 | `setActionHandler` registers without throwing | ✅ no throw |
| 3 | macOS Now Playing shows readit.dev | ✅ yes |
| 4 | `playbackState` mirrored through `reportProgress()` | ✅ works (but see §5) |
| 5 | Hardware media key (F8) controls playback | ✅ yes |
| 6 | `chrome://media-internals` → an active session exists | ✅ yes |
| 7 | Article tab shows the "playing audio" indicator | ❌ **no** |

**Pure Web Audio is enough to create a media session.** No `HTMLMediaElement`
required. The original hypothesis was wrong.

### Probe B — HTMLMediaElement bridge ❌

| # | Check | Result |
|---|---|---|
| 1 | The bridge works technically | ✅ `<audio>` playing, `readyState: 4`, audible |
| 2 | Hardware media key (F8) | ❌ **stops working** |
| 3 | Active session in media-internals | ❌ **disappears** |
| 4 | Word-highlight timing | ✅ no drift |
| 5 | Pause semantics | ⚠️ off — pausing for 30s brings the session back, unpausing loses it |

**The bridge breaks what already worked.** Routing through
`MediaStreamAudioDestinationNode` makes Chrome lose the active media session —
the exact opposite of the goal. Option B is ruled out.

## 5. A design flaw the logs exposed

This is the most important finding for the design spec, and it is not a blocker:

```
[MEDIASESSION] playbackState -> playing  (status=playing)
[MEDIASESSION] playbackState -> none     (status=loading)   ← at every unit boundary
[MEDIASESSION] playbackState -> playing  (status=playing)
[MEDIASESSION] playbackState -> none     (status=loading)
```

`reportProgress('loading')` fires at **every paragraph boundary**
(`offscreen.ts:728` in `playNextUnit`). The naive mapping
(`playing → 'playing'`, everything else → `'none'`) makes `playbackState`
flicker `playing → none → playing` continuously for the whole reading session.

It caused no visible failure during the spike, but `'none'` means "nothing to
control" — enough for the OS or Chrome to drop or flicker the Now Playing tile.

**Requirement for the design spec**: `'loading'` must map to `'playing'` (a
reading session is still in progress, it is merely synthesising the next unit),
not to `'none'`. Only `'stopped'` maps to `'none'`. This is precisely the detail
that proposal section 4 — "Mirror playbackState in reportProgress()" — left
underspecified.

## 6. A proposal claim that needs correcting

Proposal section 6 stated:

> Chrome's own "tab is playing audio" toolbar indicator gets a real title
> instead of a bare audio icon with no context.

**Wrong.** The offscreen document is not a tab — the article tab shows no
speaker icon, before or after registering mediaSession. The real value is **the
OS Now Playing surface plus hardware media keys**, not a tab indicator. Drop
that bullet from the "User value" section.

## 7. Recommendation

**Proceed with the proposal as written** — move to rollout step 2 (write the
design spec). The architecture it describes is correct: register from the
offscreen document, mirror in `reportProgress()`, handlers calling into the
existing functions. No change to the audio path, no new permission, no
"parallel playback path".

The design spec needs to settle three points this spike clarified:

1. Map `'loading'` → `'playing'`; only `'stopped'` → `'none'` (§5).
2. Drop the tab audio indicator claim from user value (§6).
3. Do not use `HTMLMediaElement` — pure Web Audio suffices, and the bridge breaks it (§4).

## 8. Not covered

- **Bluetooth headsets** — not tested separately. F8 works, so the action
  handler path is proven; headset buttons go through the same media key
  mechanism so they very likely work, but there is no direct evidence.
- **Windows / Linux** — cannot be tested from this machine. Needs separate
  confirmation before shipping.
- **Firefox** — out of scope, but **not** for the reason previously recorded
  here. The old note said Firefox has no `chrome.offscreen` so the module only
  runs on Chrome; that is wrong. `src/background/firefox_background.ts:2`
  imports `offscreen.ts` directly into the background script, so this module
  **is** in the Firefox bundle (verified: `dist/firefox/background.js` contains
  `navigator.mediaSession` and `setActionHandler`). What actually blocks it is
  that `install()` is only called from `registerOffscreenMessageHandler()`
  (`offscreen.ts:1510`), which only `offscreen_entry.ts` calls — Firefox never
  does. Consequence: Firefox registers `nexttrack` (`offscreen.ts:1301`) and
  still writes metadata / `playbackState` / position, but has no
  `play`/`pause`/`stop`. This half-state is a structural accident, not a
  decision.

  The remaining unknown if we want to fix it: whether Firefox builds a media
  session for pure Web Audio at all. Having the API (115+ provides
  `MediaMetadata` / `setActionHandler` / `setPositionState`) does not mean there
  is a session to attach to, and it cannot be inferred from the Chrome result —
  §4 shows intuition about exactly this point was already wrong once.
- **`nexttrack` + Playlist Queue** — the spike only measured `play`/`pause`/`stop`.
  The registration mechanism is proven to work so the risk is low, but it was
  not measured.
