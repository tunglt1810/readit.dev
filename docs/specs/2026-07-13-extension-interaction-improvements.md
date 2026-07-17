# Extension Interaction Improvements Specification

**Status:** Implemented
**Date:** July 13, 2026
**Scope:** Free MVP Chrome extension

## 1. Goal

Improve the extension's everyday interaction model without changing its
local-only runtime boundary. The release must let users read selected text
from the page context menu, understand playback state from the toolbar badge,
use compact accessible popup controls, and reach a single privacy-safe
feedback entry point from the popup footer.

This specification extends the [Free MVP Design
Specification](./2026-07-12-free-mvp-design.md). It does not add Pro behavior,
backend calls, telemetry, or durable article storage.

## 2. Product decisions

- The context menu has one action for text selections on supported HTTP and
  HTTPS pages.
- Selected-text playback replaces the current single playback session through
  the same coordinator used by full-page playback.
- The toolbar badge reflects the global playback state and is not scoped to
  one tab.
- The popup's primary playback controls are icon-only and remain fully
  keyboard- and screen-reader-accessible.
- The footer has one combined `Feedback` link for bug reports and feature
  requests.
- The footer displays only `v<manifest version>`, for example `v1.0.0`.
- Feedback navigation includes the extension version but never includes the
  current page URL, page title, selected text, or article content.
- No icon library or other runtime dependency is added.

## 3. Selected-text context menu

### 3.1 Registration and availability

The manifest declares the `contextMenus` permission. The background service
worker creates one stable context-menu item from `runtime.onInstalled` with:

- a stable ID;
- the `selection` context;
- HTTP and HTTPS document URL patterns only.

The menu must not appear on browser-internal pages, extension pages, file URLs,
or other unsupported schemes. Executing the menu item is an explicit user
gesture and uses the existing `activeTab` and `scripting` permissions to read
the page language when needed.

### 3.2 Selection validation and language

On activation, the background worker must:

1. trim the selected text;
2. ignore an empty or whitespace-only selection without interrupting the
   current session;
3. read `document.documentElement.lang` from the selected page;
4. normalize a regional language such as `vi-VN` to `vi`;
5. use `na` when the language is missing or cannot be read;
6. allow the existing offscreen language resolver to map an unsupported
   normalized code to `na`;
7. create the normal `Article` contract from the tab title, page URL, selected
   text, and resolved language.

Language lookup failure is not a playback failure. The runtime continues with
the documented fallback behavior and must not claim that translation occurred.

### 3.3 Shared playback pipeline

Full-page and selected-text reading converge after they have produced a valid
`Article`:

```text
Read current page -> Readability extraction --+
                                             +-> startArticlePlayback()
Context menu -> selected-text Article --------+
                                                    |
                                                    +-> stop prior session
                                                    +-> load voice and speed
                                                    +-> create session snapshot
                                                    +-> start offscreen playback
```

The common pipeline owns session replacement, local preference lookup,
session creation, offscreen setup, and the `PLAY` command. It must not duplicate
those steps for the two input sources.

Selected text and generated audio stay in extension memory for the active
session. They are not written to `chrome.storage`.

## 4. Toolbar badge

The badge uses a deterministic state mapping:

| Playback state          | Text  | Background     |
| ----------------------- | ----- | -------------- |
| `loading`               | `…`   | warning yellow |
| `playing`               | `▶`   | success green  |
| `paused`                | `Ⅱ`   | warning yellow |
| `error`                 | `!`   | danger red     |
| `stopped` or no session | empty | cleared        |

Badge mapping is a pure function. Applying the badge is asynchronous and must
be awaited inside the coordinator's serialized state flow so an older update
cannot overwrite a newer state. Hydrating a stored session synchronizes the
badge, and clearing or naturally completing a session removes it.

Badge failures must not corrupt playback state. They may be handled as local
developer diagnostics but are never sent to a remote service.

## 5. Popup controls

The primary playback area uses circular 52-by-52-pixel icon-only buttons:

- Read when no session is active or the last state is an error;
- Stop while loading, playing, or paused;
- Pause while playing;
- Resume while paused.

The Stop action remains enabled during loading. This preserves the existing
requirement that the user can cancel model setup or pending playback.

Icons are inline SVG elements and are decorative. Each button supplies its
meaning through an explicit localized `aria-label` and matching tooltip. The
buttons have a visible keyboard focus state and do not rely on emoji or icon
glyph names for their accessible name.

This work does not implement the complete canonical EN/VI translation system.
Until that work lands, new user-facing strings follow the popup's current
language. The later i18n implementation must include the context-menu label,
button tooltips, accessibility labels, Feedback label, and error text.

## 6. Footer and feedback

The footer contains:

1. Buy Me a Coffee;
2. Feedback;
3. Privacy Policy;
4. the standalone version text `v<manifest version>`.

The version comes from `chrome.runtime.getManifest().version`. The footer does
not repeat the extension name or show a separate copyright line beside it.

The `Feedback` link opens a new GitHub issue with a neutral template for either
a bug report or a feature request. The template may contain:

- a Bug / Feature request choice;
- a description prompt;
- the extension version.

It must not prefill the active or session URL, tab title, selected text,
article content, browsing history, or other page-derived data. Opening GitHub
is an explicit user-initiated navigation.

## 7. Error and privacy behavior

| Case                              | Required behavior                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Whitespace-only selection         | Ignore it and preserve the current session.                                                         |
| Page language lookup fails        | Use `na` and continue.                                                                              |
| Offscreen setup or playback fails | Publish the existing error state, show `!` on the badge, and allow retry.                           |
| User stops during loading         | Invalidate the session, cancel playback work, and clear the badge.                                  |
| Session completes naturally       | Clear the session and badge.                                                                        |
| Feedback is opened                | Send only the GitHub request and explicitly composed template fields; include no page-derived data. |

No selected text, article content, generated audio, badge transition, or error
event is sent to readit.dev, analytics, crash reporting, or another telemetry
service.

## 8. Test strategy

### 8.1 Unit tests

Add unit coverage for:

- every badge mapping, including `null` and `stopped`;
- trimming selected text and rejecting whitespace-only input;
- regional page-language normalization and `na` fallback;
- selected-text `Article` metadata;
- Feedback URL construction, including the extension version;
- absence of page URL, page title, selected text, and article content from the
  Feedback URL.

Tests target small pure helpers instead of importing the side-effectful
background service worker or mocking the entire Chrome runtime.

### 8.2 End-to-end tests

Update or add E2E coverage for:

- Read, Pause, Resume, and Stop controls by accessible name;
- icon-only control content and explicit accessibility labels;
- Stop remaining available during loading;
- exact footer version text such as `v1.0.0`;
- one unambiguous Feedback link and the existing support/privacy links;
- the Feedback URL containing version but no page URL;
- badge transitions for loading, playing, paused, error, and stopped;
- badge clearing after explicit stop and natural completion.

Playwright does not need to automate Chrome's native context-menu surface.
The selection contract is covered at the unit boundary, while E2E verifies the
coordinator and badge behavior that follows a playback start.

## 9. Documentation and release verification

The canonical Free MVP specification must mention selected-text reading,
icon-only accessible controls, badge behavior, the Feedback/version footer,
GitHub's feedback privacy boundary, and the `contextMenus` permission.

The built manifest must contain `contextMenus` and must not add broader host,
tabs, identity, history, cookie, or backend-related permissions. Release
verification continues to enforce the local-only Free boundary.

## 10. Acceptance criteria

Implementation is complete only when:

1. valid selected text starts through the same playback pipeline as a full
   article;
2. whitespace-only selected text does not replace an active session;
3. selected-text language follows page-language normalization and fallback;
4. badge state matches the latest coordinator state and clears on stop;
5. popup controls are icon-only, accessible, and stoppable during loading;
6. the footer displays only `v<version>` for version metadata;
7. one Feedback link supports bugs and feature requests without page-derived
   data;
8. unit tests, targeted E2E tests, the full E2E suite, and the production build
   pass;
9. `git diff --check` is clean;
10. built-manifest verification confirms the intended permission set.

## 11. Out of scope

This change does not add multiple simultaneous sessions, arbitrary text input,
selection highlighting, context-menu settings, badge counters, notification
permissions, telemetry, backend calls, or the Vietnamese speech-normalization
ideas currently recorded in `context_improvement.md`.
