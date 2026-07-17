# Selected-Text Floating Read Button Design

**Date:** 2026-07-16

**Status:** Implemented

**Target:** Chrome 127+ Manifest V3 extension

## 1. Summary

Add a Google Translate-style affordance to `readit.dev`: after a user finishes
selecting supported page text, the content script displays a small floating
button beside the selection. The button uses the existing `readit.dev` logo.
Activating it opens the extension action popup immediately and starts reading
the selected text through the existing background/offscreen playback pipeline.

The feature does not introduce a playback queue or a second playback
coordinator. A valid selected-text request directly replaces the active session
through the same `startArticlePlayback()` path used when the user requests a new
page while another page is still being read.

## 2. Goals

- Make selected-text reading discoverable without requiring the context menu.
- Open the existing action popup immediately so loading, progress, errors, and
  playback controls remain visible.
- Reuse the current single-session playback coordinator and selected-text
  `Article` contract.
- Keep the injected page UI compact, accessible, isolated from website CSS, and
  removable without changing page content.
- Let users disable the floating button from a compact one-line popup setting.
- Preserve the Free build's local-only processing and permission boundary.

## 3. Non-goals

- Reading selections inside `iframe` documents.
- Reading selections inside `input`, `textarea`, or editable content.
- Adding an in-page mini-player or additional playback controls.
- Supporting Chrome versions older than 127.
- Adding multiple sessions, a playlist, pending-selection storage, or a
  playback queue.
- Removing or changing the existing selected-text context-menu entry point.
- Changing article extraction, Supertonic, speech preparation, or offscreen
  playback behavior.

## 4. Approved user experience

### 4.1 Eligibility

The affordance runs only in the top-level document. It is eligible when:

- the popup setting is enabled;
- the page uses HTTP or HTTPS;
- `window.getSelection()` contains non-whitespace text;
- the selection has a visible range rectangle; and
- neither end of the selection nor its common ancestor belongs to an `input`,
  `textarea`, or editable element.

The first release does not set `all_frames`, so selections in embedded documents
remain out of scope.

### 4.2 Showing and positioning the button

The content script recomputes the affordance after pointer selection finishes
and after keyboard selection settles. It does not move the button continuously
while the pointer is dragging.

Pointer-created selections do not move focus. For a keyboard-created selection,
the controller stores the previously focused element, renders the button, and
moves focus to the button so Enter or Space can activate it without traversing
the rest of the page's tab order.

The button is anchored to the bottom-right of the final visible selection
rectangle. Positioning uses viewport coordinates and a fixed host. The position
is clamped to the viewport and flips above or to the left of the selection when
the preferred placement would overflow.

The approved visual is:

- a 36 by 36 pixel white floating button;
- a subtle border, rounded corners, and elevation;
- the existing `assets/icon32.png` logo displayed at 26 by 26 pixels; and
- no text label beside the logo.

The host and button live in a Shadow DOM boundary and reset inherited styling so
page CSS cannot change their layout. The implementation must not insert the
button inside the selected content or mutate the selection's DOM.

### 4.3 Hiding the button

The content script removes the current affordance when:

- the selection collapses or changes, unless focus is moving into the
  affordance for a stored keyboard-selection snapshot;
- the user scrolls or resizes the viewport;
- the user presses `Escape`;
- the user clicks outside the affordance;
- the setting is disabled;
- the page navigates or unloads; or
- the button is activated.

The button stores a snapshot of the selected text before focus changes. Its
pointer handling preserves that snapshot even if clicking the button collapses
the browser selection. The first activation disables and removes the button so
a double-click cannot start two sessions.

When `Escape` dismisses a keyboard-focused button, focus returns to the element
that owned focus before the affordance appeared when that element is still
connected to the document.

### 4.4 Accessibility and localization

The control is a native `<button type="button">` and supports normal Enter and
Space activation. It has a visible focus indicator plus localized `aria-label`
and `title` text equivalent to “Read selected text.” The label follows the same
English/Vietnamese UI-language rule as the popup.

## 5. Popup setting

Add `STORAGE_KEYS.SELECTION_BUTTON_ENABLED` to `chrome.storage.local`. A missing
value means `true`, so the feature is enabled after both a fresh install and an
upgrade. The implementation does not need an install-time migration write.

The popup renders one compact row immediately before the footer:

```text
Hiện nút đọc cạnh văn bản đã chọn                         [switch]
```

The English label is “Show read button for selected text.” The row contains no
section title or helper text. It remains in the same structural position for the
Modern, Winamp, and WMP12 themes; only theme presentation may differ.

The switch is a native accessible control. Changing it persists a boolean to
`chrome.storage.local`. Content scripts listen for that key through
`chrome.storage.onChanged`, so existing tabs update immediately. Disabling the
feature removes a visible affordance but does not stop active playback.

## 6. Architecture and component boundaries

### 6.1 Selection affordance controller

A focused content-side module owns:

- reading and observing the enablement setting;
- selection eligibility and editable-region exclusion;
- selection snapshots and geometry;
- Shadow DOM host/button lifecycle;
- show, hide, clamp, and flip behavior; and
- emitting one selected-text intent on activation.

Article extraction remains separate. The existing content-script initialization
guard still guarantees that listeners and UI are installed only once.

### 6.2 Background selected-text command

The button sends a `START_SELECTED_TEXT` runtime message containing only:

- the selected-text snapshot; and
- `document.documentElement.lang`.

The background does not trust title, URL, tab ID, window ID, or frame identity
from the payload. It obtains those values from `chrome.runtime.MessageSender`
and accepts the command only when the sender belongs to frame `0` of an HTTP or
HTTPS tab.

After synchronous payload and sender validation, the background requests
`chrome.action.openPopup({ windowId })` immediately. Popup-opening failure is
isolated from playback: it is observed and ignored rather than failing a valid
read command.

The valid selection is converted through the existing selected-text helper and
routed to `startArticlePlayback()`. The context-menu handler and the floating
button must converge before playback starts; they must not duplicate session,
voice, speed, offscreen, or error handling.

### 6.3 Existing state serialization is not a playback queue

The background's current short-lived `stateQueue` serializes atomic state
transitions such as start, stop, pause, and progress. It does not wait for audio
to finish and is not a playlist.

This feature adds no new queue. A valid selection request uses the same
replacement behavior as `START_CURRENT_PAGE`:

1. validate the new selection before changing the current session;
2. call `stopActiveSession('session-replaced')` immediately;
3. invalidate the previous session and stop its offscreen playback;
4. create and publish a new loading session with a new session ID; and
5. dispatch the new `PLAY` command.

Late progress or failure callbacks from the replaced session are ignored by the
existing session-ID checks. The implementation never waits for the old text to
finish and never restores the old session if the new start fails.

### 6.4 Popup and offscreen boundaries

The popup remains a renderer and controller for the background-owned session.
Because it opens before the new loading snapshot may be published, it may first
hydrate an empty state; the subsequent session broadcast must move it to loading
without requiring a reopen.

The offscreen document and TTS pipeline receive the same `PLAY`, `STOP`, pause,
resume, speed, and progress contracts they already use. No offscreen branch is
specific to the floating button.

## 7. Data flow

```text
Selection settles
    -> content controller validates text and range
    -> content controller shows Shadow DOM logo button
    -> user activates button once
    -> content script sends START_SELECTED_TEXT
    -> background validates payload and MessageSender
    -> background requests action popup immediately
    -> shared coordinator stops the active session
    -> shared coordinator publishes the new loading session
    -> offscreen starts selected-text playback
    -> background publishes progress
    -> popup hydrates/renders loading, progress, and controls
```

The context-menu path joins the flow at selected-text validation and article
creation. Both entry points then use the same replacement and playback path.

## 8. Error and race behavior

| Case | Required behavior |
| --- | --- |
| Empty or whitespace-only selection | Ignore it, do not open the popup, and preserve the active session. |
| Selection belongs to an editable region or child frame | Do not show the button or send a command. |
| Selection changes before activation | Remove the stale button and snapshot. |
| Button is activated twice | Accept the first activation only. |
| New valid selection arrives during active playback | Stop and invalidate the active session, then start the new selection immediately. |
| Popup API rejects | Continue starting playback; badge and session remain authoritative. |
| New playback setup fails after replacement | Publish the existing error behavior; do not resume the replaced session. |
| Old progress arrives after replacement | Ignore it because its session ID is stale. |
| Setting turns off while a button is visible | Remove the button; leave playback unchanged. |

## 9. Privacy and manifest boundary

Selected text is carried through extension messages to the existing offscreen
TTS pipeline. It is not written to `chrome.storage.local` or the background
session snapshot, and it is not sent to readit.dev, telemetry, feedback URLs, or
another backend.

The source manifest adds:

- `"minimum_chrome_version": "127"`; and
- a web-accessible-resource entry for `assets/icon32.png` limited to HTTP and
  HTTPS pages.

The logo is a public packaged asset and contains no user data. No new permission
or host permission is added. The exact Free permission boundary remains:

- `activeTab`;
- `scripting`;
- `storage`;
- `offscreen`;
- `contextMenus`; and
- `https://huggingface.co/*` as the only host permission.

Release validation must enforce the minimum Chrome version, the narrowly scoped
logo exposure, and the unchanged permission lists.

## 10. Test strategy

### 10.1 Unit tests

Add focused coverage for:

- missing, enabled, and disabled setting values;
- selected-text trimming and invalid payload rejection;
- top-frame and HTTP/HTTPS sender validation;
- editable-region exclusion helpers;
- bottom-right placement, viewport clamping, and flip decisions;
- single-activation behavior;
- immediate popup invocation after validation;
- popup rejection not preventing playback replacement;
- active-session replacement before the new session is published;
- stale session progress remaining ignored; and
- manifest minimum version, logo resource scope, permissions, and host
  permissions.

### 10.2 End-to-end tests

Use the existing local routed-page fixture to verify the real extension:

- pointer selection displays the button after selection settles;
- keyboard selection focuses an accessible button, Enter/Space activates it,
  and Escape restores the previous focus target;
- the button uses the packaged `readit.dev` logo and approved dimensions;
- editable regions and unsupported selections do not show it;
- collapse, scroll, resize, Escape, outside click, and setting disable remove it;
- the one-line setting defaults on, persists, updates an open tab immediately,
  and renders correctly in English and Vietnamese;
- one activation opens the real action popup and creates one loading session;
- a new selection stops the active session before starting a new one;
- double-clicking does not create duplicate sessions;
- popup hydration receives subsequent loading/progress broadcasts; and
- the existing context-menu, playback controls, badge, tab lifecycle, themes,
  and privacy tests remain green.

### 10.3 Verification order

Run fresh verification in this order:

1. `pnpm test:unit`;
2. `CI=true pnpm build`;
3. `pnpm validate:manifest`;
4. targeted Playwright suites for selection, reading state, popup settings, and
   themes;
5. `CI=true pnpm test:e2e`;
6. built-artifact privacy checks; and
7. `git diff --check`.

## 11. Acceptance criteria

Implementation is complete only when:

1. a valid top-document selection shows the approved logo-only button;
2. mouse and keyboard selection are supported after the selection settles,
   including deterministic keyboard focus, activation, and dismissal;
3. editable regions and child frames do not show the affordance;
4. one activation opens the action popup immediately and starts selected-text
   playback through `startArticlePlayback()`;
5. a new valid selection stops the active session before starting the new
   selection, exactly like requesting a new page during playback;
6. no playback queue, pending selection, or second coordinator is introduced;
7. popup loading, progress, controls, errors, and badge remain driven by the
   background-owned session;
8. the compact one-line setting defaults on, persists, and updates open tabs;
9. selected text remains local and is not persisted in settings/session state or
   transmitted externally;
10. Chrome 127+, logo exposure, permissions, and host permissions match the
    documented manifest boundary; and
11. unit tests, build, manifest validation, targeted E2E, full E2E, privacy
    checks, and `git diff --check` pass.
