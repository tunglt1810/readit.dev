# Side Panel and Manual Text Reading Design

**Date:** 2026-07-19

**Status:** Implemented and verified

## 1. Summary

readit.dev will add an optional Chrome Side Panel that complements the existing
popup. The popup remains the quick-control surface and gains a secondary action
that opens the Side Panel. The Side Panel provides the existing current-page
reading action followed by a persistent manual-text input for locally reading
pasted or typed content.

Manual text uses the existing background-owned playback coordinator and
offscreen TTS pipeline. It is independent from browser-tab lifecycle and is
never written to extension storage. While it is being read, the Side Panel
shows a locked local reader with spoken-word highlighting. A web reading can
checkpoint the manual audio in memory and the same open Side Panel can
explicitly resume it.

## 2. Product decisions

- Keep the existing popup and its Default, Winamp, and WMP12 themes.
- Add a labeled secondary `Open Side Panel` action directly below the popup
  playback controls.
- Use a dedicated Side Panel layout rather than stretching or conditionally
  branching the popup application.
- Place current-page reading before manual-text input in the Side Panel.
- Keep the player visible at the bottom of the Side Panel.
- Let a valid manual-text request replace the active session. A valid web
  request checkpoints an active manual session before it replaces it; do not
  add a queue.
- Keep manual sessions independent from browser-tab navigation and closure.
  Closing or reloading the owning Side Panel stops audio and discards manual
  state.
- Default manual-text language selection to `Auto`, with explicit English,
  Vietnamese, and Chinese overrides.
- Keep the manual-text draft only in the active Side Panel document's memory.
- Reuse the active popup theme in the Side Panel while retaining the Side
  Panel's own spatial layout.

## 3. Goals and non-goals

### 3.1 Goals

- Make the extension useful for text that cannot be extracted through
  Readability or does not originate from the current page.
- Preserve the existing single-session playback, badge, hydration, and
  offscreen lifecycle guarantees.
- Keep pasted text on the device and out of persistent extension storage.
- Provide a persistent, accessible control surface for longer listening
  sessions without removing the compact popup.
- Keep current-page and manual-text starts visually distinct but behaviorally
  consistent after input preparation.

### 3.2 Non-goals

- Replacing the popup with the Side Panel.
- Adding a reading queue, history, saved drafts, or cross-device sync.
- Persisting pasted text, generated audio, or detected language results.
- Per-sentence language detection or mixed-language voice switching.
- Translation, summaries, cloud AI, cloud TTS, or backend integration.
- Highlighting manual text in a webpage or adding a separate reader-mode page.
- Refactoring unrelated popup controls or theme implementation.

## 4. User experience

### 4.1 Opening the Side Panel

The popup shows a full-width secondary `Open Side Panel` action immediately
below the playback controls. It includes an icon and localized text so the
action does not depend on an unfamiliar icon alone.

The action opens the extension Side Panel for the current browser window from
the popup's user gesture. Failure to open the Side Panel produces a localized,
non-destructive popup error and does not stop or alter playback.

### 4.2 Side Panel layout

The Side Panel uses this fixed information hierarchy:

1. Header with product identity, version, and the localized Buy me a coffee link.
2. Current-page card with title, host, detected page language, and the primary
   current-page read action.
3. `Or paste text` divider.
4. Manual-text area, local-processing disclosure, character count, language
   selector, Clear action, and `Read pasted text` action.
5. A bottom player with status, Voice Style, speed, and the existing
   play/pause/stop behavior.

The active popup theme controls Side Panel colors, typography, and transport
styling. The Side Panel header matches the popup header's baseline alignment
and visual separator while retaining the Side Panel's own spatial layout. The
Side Panel does not copy the popup's compact placement or add a second theme
preference.

### 4.3 Reading the current page

The current-page action sends the existing `START_CURRENT_PAGE` command. The
background resolves the active tab when the user activates the action, not
when the Side Panel was opened or last rendered. Existing restricted-page,
Readability, tab ownership, and word-highlight behavior remains unchanged.

The visible current-page card may refresh as the active tab changes, but its
displayed metadata is advisory. The background remains authoritative at start
time so a tab switch cannot cause the Side Panel to send a stale tab ID.

### 4.4 Reading pasted text

The textarea accepts typed or pasted Unicode text. The read action is disabled
when the draft is empty after trimming. Manual-text preparation:

- validates that the input is a string;
- normalizes line endings and trims outer whitespace;
- preserves paragraph boundaries for the existing segmentation pipeline;
- rejects empty or whitespace-only content before replacing playback; and
- resolves the requested language before the current session is stopped.

The character count is informational. The first version adds no manual-specific
length limit beyond the capacity already supported by the Article playback
pipeline.

A valid request locks the normalized text in a read-only reader and starts
manual playback through the shared coordinator. The reader highlights spoken
words locally, including repeated words in source order; Stop returns the same
draft to the editable textarea. Clear and language selection are locked while
the reader is active.

A valid web reading checkpoints manual audio in offscreen memory before it
starts. The locked reader then offers explicit Resume editor reading and Stop
editor reading controls. Web completion and normal web Stop do not auto-resume
manual audio. Closing or reloading the owning Side Panel stops active audio,
discards the checkpoint and draft, and leaves the next Side Panel empty.

### 4.5 Language selection

The language selector offers `Auto`, `English`, `Tiếng Việt`, and `中文`.
`Auto` is always the initial value for a new Side Panel document and is not
persisted as a preference.

Automatic detection runs locally and deterministically after Unicode NFKC
normalization and lowercasing:

1. Select Chinese when Han code points account for at least 20 percent of the
   Unicode letters in the input.
2. Otherwise select Vietnamese when the input contains a Vietnamese-exclusive
   letter (`ă`, `đ`, `ơ`, or `ư`, including case and tone variants) or at least
   two tokens from a fixed, tested list of common Vietnamese function words.
3. Otherwise select English.

The function-word list is code-owned, local, and limited to detection; it is not
a downloadable model or user preference. The first version selects one language
for the full input and does not switch language per sentence. Explicit selection
bypasses automatic detection.

Automatic detection never claims to translate content. A low-confidence or
unknown result continues with English rather than blocking playback.

## 5. Architecture and component boundaries

### 5.1 Side Panel entry

`src/sidepanel/` is a dedicated React entry with its own HTML template,
application component, and layout stylesheet. Rsbuild emits the Side Panel page
alongside the popup, background, content script, and offscreen entries.

The Side Panel application owns layout and document-local state: draft text,
the manual language selection, current character count, and current-tab display
metadata. It does not own session serialization or call the offscreen document
directly.

### 5.2 Shared UI adapters

Popup and Side Panel share only behavior that must remain synchronized:

- playback-session hydration and runtime updates;
- Voice Style and speed preferences;
- theme preference and compatible visual tokens; and
- playback command adapters and reusable controls where their markup is
  genuinely identical.

The implementation must not turn the popup into one large surface-mode
conditional. Layout-specific components remain separate.

### 5.3 Background coordinator

The background remains the only playback coordinator. It receives
`START_MANUAL_TEXT`, validates the payload, prepares a manual playback input,
and routes it through the same replacement, preference loading, session
publication, offscreen setup, and `PLAY` dispatch path as Article and selection
playback.

Manual input preparation must finish before `stopActiveSession()` runs. Invalid
manual text therefore leaves the active session untouched. Once a valid request
has begun replacement, a later model or playback failure uses the normal shared
error lifecycle.

### 5.4 Content and offscreen boundaries

Manual text does not enter a content script and never creates a word-highlight
scope. Content scripts continue to serve only tab-owned Article extraction,
selection capture, and page highlighting.

The offscreen document receives the normal prepared playback content and
continues to own normalization, segmentation, synthesis, audio, and progress.
It does not distinguish UI surfaces or persist manual text.

## 6. Data contracts

### 6.1 Start command

```ts
interface StartManualTextMessage {
	action: 'START_MANUAL_TEXT';
	payload: {
		text: string;
		language: 'auto' | 'en' | 'vi' | 'zh';
		panelInstanceId: string;
	};
}
```

The background treats the UI payload as untrusted input. It validates both
fields and returns the existing command response shape with localized error
mapping at the UI boundary.

### 6.2 Session source

```ts
interface PlaybackSessionBase {
	sessionId: string;
	lang: string;
	status: PlaybackStatus;
	currentParagraphIndex: number;
	totalParagraphs: number;
	progressPercentage: number;
	voiceStyleId: string;
	speed: number;
	error?: string;
	updatedAt: number;
}

type PlaybackSessionSnapshot =
	| (PlaybackSessionBase & {
			contentScope: 'article' | 'selection';
			source: { kind: 'tab'; tabId: number; title: string; url: string };
	  })
	| (PlaybackSessionBase & {
			contentScope: 'manual';
			source: { kind: 'manual'; panelInstanceId: string };
	  });
```

The snapshot validator must reject invalid source and scope combinations. Tab
lifecycle cleanup consults the discriminator and ignores manual sessions.

A manual snapshot stores playback metadata and the resolved language, but not
the manual text, a source URL, or a text-derived title. Popup and Side Panel
render a localized `Pasted text` label from `contentScope` rather than storing a
language-specific title in the snapshot.

## 7. Data flow

```text
Popup user gesture
    -> chrome.sidePanel.open(current window)
    -> Side Panel hydrates shared playback and local preferences

Manual read activation
    -> Side Panel sends START_MANUAL_TEXT { text, language, panelInstanceId }
    -> background validates and normalizes text
    -> background resolves Auto or explicit language locally
    -> valid input stops the previous session
    -> background publishes a manual loading snapshot
    -> background dispatches the existing offscreen PLAY command
    -> offscreen synthesizes and plays locally
    -> progress reaches background
    -> background serializes and broadcasts the snapshot
    -> popup, Side Panel, and toolbar badge update from one state
```

No step writes the manual draft or playback content to `chrome.storage.local`
or `chrome.storage.session`.

## 8. Error and race behavior

| Case | Required behavior |
| --- | --- |
| Empty or whitespace-only draft | Do not send or start playback; preserve the active session. |
| Invalid command payload | Return a safe command error; preserve the active session. |
| Auto detection is uncertain | Resolve to English and continue without a translation claim. |
| Model or TTS setup fails after replacement | Publish the shared localized error state and retain the Side Panel draft for retry. |
| Stop is requested during loading | Invalidate the manual session and stop through the existing coordinator. |
| Web start while manual is active | Checkpoint manual in memory; reject the web start if checkpointing fails. |
| Side Panel closes or reloads during owned manual playback | Stop audio, discard the checkpoint and draft, and clear the reader. |
| Side Panel reopens after close or reload | Start with an empty editable draft and no manual checkpoint. |
| Active tab changes before current-page activation | Resolve the active tab at activation time. |
| Active tab navigates or closes during manual playback | Ignore the tab event and continue manual playback. |
| Restricted or unreadable current page | Fail only current-page reading; manual-text reading remains available. |
| Side Panel open fails | Show a localized popup error and preserve playback. |
| Popup and Side Panel issue concurrent starts | Serialize both through the existing queue; the latest accepted replacement owns playback. |

## 9. Privacy, permissions, and release boundaries

The feature remains Free and local-only. Pasted text is processed in extension
memory and sent only between extension contexts. It is not sent to readit.dev,
the future backend, telemetry, crash reporting, or another application service.

The manifest adds the `sidePanel` permission and a local
`side_panel.default_path`. Release validation must allow and require these
entries while preserving all existing Free-build prohibitions. The feature
adds no host permission, identity permission, backend endpoint, or remote-code
dependency.

## 10. Verification

### 10.1 Unit coverage

- Manual payload type and language validation.
- Empty and whitespace-only rejection without session replacement.
- Line-ending normalization and paragraph preservation.
- Explicit English, Vietnamese, and Chinese selection.
- Deterministic Auto detection for representative Chinese, Vietnamese, and
  English/fallback inputs.
- Session-source validation and tab/manual scope combinations.
- Tab close and navigation cleanup for tab sessions only.
- Popup Side Panel opening success and failure isolation.

### 10.2 End-to-end coverage

- Popup renders a localized secondary `Open Side Panel` action after playback
  controls and opens the Side Panel.
- Side Panel renders current-page reading before manual-text reading.
- Valid manual text starts locally and replaces the previous session.
- Empty manual text preserves active playback.
- Manual playback survives active-tab changes, navigation, and tab closure.
- Locked manual reader highlights spoken words, supports explicit web
  preemption/resume, and side-panel close/reload stops owned audio.
- Popup, Side Panel, session storage snapshot, and badge show consistent state.
- Manual text remains usable when current-page extraction is restricted.
- Default, Winamp, and WMP12 preferences apply without changing the approved
  Side Panel layout.
- Controls, labels, language selection, focus order, and keyboard behavior have
  accessible names and visible focus.

### 10.3 Verification sequence

1. Run focused manual-text, session-source, and Side Panel unit tests.
2. Run `pnpm test:unit`.
3. Run `pnpm build`.
4. Run `pnpm validate:manifest` against the production output.
5. Run targeted Side Panel and playback Playwright tests.
6. Run the complete Playwright suite.
7. Run `git diff --check`.

## 11. Documentation impact

The canonical Free MVP specification currently lists manual text input as a
non-goal. It must be updated with the approved Side Panel, manual-text privacy,
session ownership, permission, error, and verification requirements. Supporting
product, privacy, release, and store documentation should be aligned during
implementation when the shipping behavior changes.

## 12. Success criteria

The feature is complete when a user can open a Side Panel from the unchanged
popup, read the active page, or paste supported text and start local TTS. A
valid manual start replaces the previous session, survives unrelated tab
lifecycle events, and remains controllable and visible from both UI surfaces
and the toolbar badge. Manual text is never persisted or transmitted outside
the extension, and the existing Article, selection, highlighting, theme, and
Free-release behaviors continue to pass regression coverage.

## 13. Rejected alternatives

Reusing one responsive `App` for both surfaces would add surface-specific
branches to an already stateful, multi-theme popup and make the layouts harder
to evolve independently. A separate Side Panel that talks directly to the
offscreen document would create a second coordinator and risk stale popup,
badge, and playback state. Replacing the popup would remove the quick-control
workflow and existing theme presentation that this design intentionally keeps.
