# Reading State and Tab Lifecycle Specification

**Status:** Implemented
**Date:** July 12, 2026
**Scope:** Free MVP Chrome extension

## 1. Goal

The popup must reconnect to an active reading session after it is closed and
reopened. Reading must stop when its owning tab is closed, reloaded, or
navigated to another URL. The extension supports one reading session at a
time.

This specification extends the [Free MVP Design
Specification](./2026-07-12-free-mvp-design.md) without changing its
local-only privacy boundary.

## 2. Product decisions

- Closing the popup does not stop playback.
- Reopening the popup shows the active page, status, paragraph progress, and
  playback controls.
- A session continues when the user switches to another tab.
- Opening the popup from another tab still shows and controls the active
  session. The user may explicitly replace it with the current page.
- Starting a new page stops the previous session first.
- Closing, reloading, or navigating the owning tab stops and clears the
  session.
- A browser restart does not restore playback. Audio and article content are
  not persisted.

## 3. State ownership

The background service worker owns the session coordinator. The offscreen
document owns model loading, synthesis, and audio execution. The popup is a
stateless view that queries the coordinator and subscribes to updates.

The coordinator keeps an in-memory session and mirrors its UI-safe snapshot to
`chrome.storage.session`. The snapshot contains metadata and progress only:

```ts
type PlaybackSessionSnapshot = {
  sessionId: string;
  tabId: number;
  title: string;
  url: string;
  lang: string;
  status: "loading" | "playing" | "paused" | "error" | "stopped";
  currentParagraphIndex: number;
  totalParagraphs: number;
  progressPercentage: number;
  voiceStyleId: string;
  speed: number;
  error?: string;
  updatedAt: number;
};
```

The article body remains in offscreen memory for the active session and is
never written to extension storage. `chrome.storage.session` is intentionally
used instead of `chrome.storage.local`; it supports popup/service-worker
reconnection during the current browser session without creating durable
article history.

## 4. Message and lifecycle flow

The popup sends `GET_PLAYBACK_STATE` when it mounts. The background responds
with the current snapshot or `null`, then broadcasts state changes through
`PLAYBACK_STATE_UPDATE`. Commands such as pause, resume, speed change, and
stop are routed through the background coordinator.

When starting a page, the background records the active tab ID and creates a
new `sessionId`. It stops the previous session, extracts the article, starts
the offscreen document, and sends the article plus session ID to the offscreen
runtime. Every offscreen progress or error message includes that session ID.

The background registers these tab handlers:

- `tabs.onRemoved`: stop and clear when the removed tab owns the session.
- `tabs.onUpdated`: stop and clear when the owner reloads or its URL changes.
- A new start request: stop the existing session before creating the new one.

Stopping must invalidate the current session before sending the offscreen
stop command. This prevents late synthesis or audio callbacks from restoring
old progress. The offscreen document is closed after it acknowledges stop or
when the session is invalidated by tab lifecycle events.

## 5. State transitions

```text
stopped/null -> loading -> playing <-> paused
     ^           |          |          |
     └───────────┴──────────┴──────────┘ stop/tab lifecycle

loading/playing/paused -> error -> stopped/null
playing -> stopped/null when all paragraphs finish
```

Only the current `sessionId` may transition the active session. Completion,
explicit stop, tab removal, navigation, extraction failure, model failure, and
playback failure must all publish a final state so a newly opened popup cannot
display stale “playing” UI.

## 6. Popup behavior

The popup displays the active session title and host, status, progress, and
pause/resume/stop controls. If the session belongs to another tab, it labels
the session accordingly and offers “Read this page instead”. That action
explicitly replaces the existing session; merely opening the popup never does.

The existing local voice and speed preferences remain unchanged. The active
session snapshot records the values used for its current playback so the popup
and offscreen runtime cannot disagree after reopening.

## 7. Error and race handling

- A closed or navigated tab invalidates the session before asynchronous TTS
  work can publish another progress update.
- Progress from an unknown or older session ID is ignored.
- If the offscreen document disappears unexpectedly, the coordinator clears
  or marks the session as an error and allows a fresh start.
- If extraction fails, no active playback session remains.
- If model loading or synthesis fails, the popup receives a localized retryable
  error and the session cannot remain in `playing`.
- A malformed or missing storage snapshot is treated as no active session.

The implementation must also normalize the current progress message contract:
the background should persist the actual `progress` field sent by offscreen,
not an unrelated or undefined payload.

## 8. Verification requirements

Add unit coverage for session ownership, state transitions, storage hydration,
unknown-session filtering, and tab lifecycle events. Add E2E coverage for:

1. Start reading, close the popup, reopen it, and verify title/status/progress.
2. Close the owner tab and verify stop plus cleared state.
3. Reload or navigate the owner tab and verify stop plus cleared state.
4. Start reading in tab B and verify tab A's session stops.
5. Open the popup in another tab and control the session from tab A.
6. Stop during loading and verify no late audio/progress update appears.
7. Finish playback and verify the next popup open shows no active session.

The implementation is complete only when these tests pass together with the
existing Free MVP build, unit, and E2E checks.

## 9. Out of scope

This change does not add multi-session audio, browser-restart recovery,
durable article history, cross-device synchronization, backend/API calls,
telemetry, or new permissions.
