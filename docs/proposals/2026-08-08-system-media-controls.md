# Feature Proposal: System Media Controls (Media Session Integration)

**Created Date**: 2026-08-08
**Status**: Proposed (not yet designed or scheduled)
**Author**: Claude (agent proposal, for team review)

---

## 1. Problem

Playback today can only be controlled from inside the extension's own
surfaces — Popup, Side Panel, the selection-button, or the two bound
`chrome.commands` shortcuts (`_execute_action`, `open_side_panel`; see
`public/manifest.json`). There is no way to:

- Pause/resume from a Bluetooth headset or a keyboard's hardware media keys.
- See "readit.dev — *<article title>*" in Chrome's own global media-control
  popup (the toolbar icon that already appears whenever a tab plays audio).
- Tie the Playlist Queue's "next" concept to a standard "next track" control.

A user who starts playback and then switches away — alt-tabs to another app,
or just wants to use the same headset buttons they use for music/podcasts —
has to come back to the browser and click inside the Side Panel/Popup UI to
pause. Every other audio app on the same machine already responds to those
controls; readit.dev doesn't.

## 2. Proposal

Register the standard Web `MediaSession` API (`navigator.mediaSession`) from
the offscreen document that already owns audio playback, so the OS/browser
exposes play / pause / stop / next controls for the current reading session,
backed entirely by the existing playback engine — no new playback path.

## 3. Why this fits the existing architecture

- Audio playback already runs in a dedicated offscreen document created
  specifically with `chrome.offscreen.Reason.AUDIO_PLAYBACK`
  (`src/background/background.ts:520-521`, justification: "Local ONNX TTS
  speech playback..."). This is exactly the context an extension is expected
  to register `navigator.mediaSession` from for its audio — the
  `AUDIO_PLAYBACK` offscreen reason is what makes a proper "now playing"
  surface available at all.
- Play/pause/stop already have single, well-defined entry points inside
  `src/offscreen/offscreen.ts` (`playAudioBuffer`, `stopAudio`,
  `stopCurrentSource`, `playNextUnit`). `MediaSession` action handlers
  (`play`, `pause`, `stop`, `nexttrack`) would call into those same
  functions — the same ones Popup/Side Panel buttons already trigger via
  message actions — not a parallel playback path.
- `reportProgress()` (`src/offscreen/offscreen.ts:231`) already centralizes
  every status transition (`playing` / `paused` / `stopped`) for every
  existing consumer (Popup, Side Panel, badge). Updating
  `navigator.mediaSession.playbackState` at that same call site keeps system
  controls in sync automatically, instead of wiring each UI surface
  separately.
- The Playlist Queue (`src/background/playlist_queue.ts`) already models
  "what's next" (`getNextPending`) and drives auto-advance on natural
  completion. `nexttrack` maps directly onto "skip to next queue item" —
  reusing state that already exists rather than inventing new "next" logic.
- Article/page title is already surfaced in the Popup and Side Panel headers,
  so `MediaMetadata` can be populated with a real title and host without any
  new extraction work.

## 4. Scope (v1)

- On session start: `navigator.mediaSession.metadata = new MediaMetadata({ title, artist: hostname, album: 'readit.dev' })`.
- Register `setActionHandler` for `play`, `pause`, `stop`, wired to the same
  internal functions the existing message handlers already call — not new
  logic, just a second entry point into it.
- Mirror `playbackState` (`'playing' | 'paused' | 'none'`) inside
  `reportProgress()` so every status-transition source (Popup, Side Panel,
  selection button, keyboard shortcut, natural completion) stays correct
  automatically.
- When a Playlist Queue is active, register `nexttrack` → advance to the
  next pending queue item, reusing the auto-advance path already built for
  natural completion. Leave `previoustrack` unregistered in v1: Manual
  Reader and single-article sessions have no "previous" to go to yet, and
  inventing that semantics is out of scope here.
- No new permissions required — `MediaSession` is a standard Web API
  available inside the existing offscreen document.

## 5. Out of scope for v1

- Seek/scrub controls (`seekto`, `seekbackward`, `seekforward`) — progress
  today is paragraph-indexed, not time-scrubbable from outside the reader,
  so external seeking needs its own design.
- Lock-screen/notification artwork — no article thumbnail extraction exists
  today; ship with title/host text only.
- New `chrome.commands` keyboard shortcuts for the same actions — related
  but independent; `public/manifest.json` currently binds 2 of the ~4
  commands Chrome allows, so there's room, but that's a separate, smaller
  proposal from system-level media-key support.

## 6. User value

- Bluetooth headset and hardware media-key play/pause work immediately,
  matching the behavior users already expect from every other audio source
  on the same device.
- Chrome's own "tab is playing audio" toolbar indicator gets a real title
  instead of a bare audio icon with no context.
- Playlist Queue gets a standard system "skip" control without opening the
  Side Panel.

## 7. Risks / open questions

- `navigator.mediaSession` is per-document; since all playback already
  funnels through one offscreen document (one active Playback Session at a
  time, per the README's Playback Session concept), there's exactly one
  MediaSession to manage — no risk of conflicting sessions across tabs.
- Need to confirm current Chrome behavior for `MediaSession` registered in
  an **offscreen document** (vs. a visible tab) reliably surfaces OS-level
  controls across platforms (Windows/macOS/Linux) — this is the one part
  not provable by reading source alone and deserves a small manual spike
  before a full design spec is written.
- The `stop` handler should route through the existing `stopAudio()` cleanup
  (offscreen teardown, session clearing) rather than a shortcut path, so
  system-triggered stop can't diverge from the one existing stop flow.

## 8. Suggested rollout

1. Spike: confirm `navigator.mediaSession` action handlers actually surface
   system media controls from the offscreen document (small throwaway
   check, not a shipped change).
2. Design spec at `docs/specs/<date>-media-session-controls-design.md`
   covering the exact `reportProgress()` integration point and handler
   wiring.
3. Implement metadata + play/pause/stop handlers, gated behind the existing
   playback-status transitions.
4. Add `nexttrack` wiring once reuse of the queue's auto-advance path is
   confirmed.
5. Manual verification: Bluetooth/keyboard media keys, Chrome's toolbar
   media popup, and that a system-triggered action still enforces the
   single-active-session invariant.
