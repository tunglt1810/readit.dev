# Currently Spoken Word Highlight Design

**Date:** 2026-07-17

**Status:** Implemented base feature; strict selected-text scope correction approved on 2026-07-18

## 1. Summary

While readit.dev reads an article with TTS, it highlights the word currently being
spoken on the source page in real time. When Vietnamese normalization expands a
number, date, or abbreviation, the original source token remains the highlighted
unit. Users can enable or disable word highlighting in popup settings.

## 2. Base architecture

The offscreen document estimates each word's time window from the actual
`AudioBuffer.duration` and relative character length, then reports the current
word through `chrome.runtime.sendMessage`. The background relays that update to
the tab that owns the playback session through `chrome.tabs.sendMessage`.

The content script locates words sequentially in the live DOM with a forward-only
`TreeWalker` and renders them through the CSS Custom Highlight API without
mutating page DOM. The Vietnamese normalizer emits a word map from original source
tokens to normalized spoken-text offsets so expanded forms highlight the original
page token.

## 3. Base requirements

- Highlight the currently spoken source word in real time.
- Advance through repeated words in document order.
- Highlight an original normalized token for the full duration of its expanded
  spoken form.
- Route updates only to the tab and session that own playback.
- Clear highlights on stop, replacement, navigation, or stale-session cleanup.
- Keep highlighting local to the extension and avoid mutating page content.
- Preserve a user setting that defaults to enabled.
- Support full-article and selected-text playback.

## 4. Base non-goals

- Exact forced alignment from an external service.
- Persisting article text, selected text, word timings, or DOM ranges.
- Mutating the page with wrapper elements.
- Introducing a second playback coordinator or queue.
- Changing TTS synthesis output solely to improve highlighting.

---

## 5. Strict Selected-Text Highlight Scope Addendum

**Date:** 2026-07-18

**Status:** Approved design; implementation delta pending

### 5.1 Purpose

Selected-text playback must constrain word highlighting to the exact DOM
`Range` selected by the user. This applies equally to playback started from the
selected-text context menu and from the floating read button.

If the extension cannot establish a safe range, audio playback continues but
word highlighting stays off for that selected-text session. It must never fall
back to an article-wide search and highlight an unrelated occurrence.

The existing plan contains Vietnamese literals because they are test inputs,
expected normalized speech, or localized UI strings. Those literals remain
unchanged intentionally; all explanatory documentation is in English.

### 5.2 Reported failure and root cause

The floating-button path clones the browser selection `Range` before starting
playback. The context-menu path runs in the background service worker and
receives only `selectionText`, so the content-side highlighter has no DOM anchor
for that path.

Without an anchor, the highlighter starts at the article root. On the reported
VnExpress page, the phrase “Ông Trần Minh Khoa” appears first in an image caption
and again at the start of the selected paragraph. Audio reads the correct
selection while highlighting follows the earlier caption.

This is an integration gap between two selected-text entry points, not an
intentional behavior difference.

### 5.3 Requirements

- Both selected-text entry points use the same strict highlight scope.
- The scope is the exact browser `Range`, including partial text nodes and
  selections spanning inline or block elements.
- Every active selection scope belongs to one playback `sessionId`.
- The highlighter never searches before the range start or after the range end.
- Missing, stale, mismatched, or detached ranges disable highlighting for that
  selected-text session instead of enabling article-wide fallback.
- Full-article highlighting remains unchanged.
- TTS timing, word maps, normalization, extraction, popup settings, and
  highlight appearance remain unchanged.
- Selection text and DOM ranges remain in memory and are never persisted.

### 5.4 Approved architecture

#### 5.4.1 Pending selection capture

The top-level content script owns one in-memory pending selection capture. It
clones the active browser `Range`:

- synchronously when a `contextmenu` event opens over an eligible selection;
- immediately before the floating read button sends `START_SELECTED_TEXT`.

The capture contains the cloned `Range` and selected text for local validation.
A newer eligible capture replaces the older one. A canceled context menu may
leave a pending capture, but it is inert: full-page playback never consumes
pending selection state, and the next selected-text gesture replaces it.

#### 5.4.2 Session-bound activation

Both selected-text entry points continue converging on
`startArticlePlayback()`. The coordinator distinguishes two playback scopes:

- `article` for full-page reading;
- `selection` plus normalized selected text for selected-text reading.

After creating the new session, and before dispatching the offscreen `PLAY`
command, the background asks the owning tab to activate the pending selection
scope for that `sessionId`.

The content script accepts activation only when:

- a pending capture exists;
- the range's common ancestor is still connected to the live document;
- the range belongs to the supported top-level HTTP or HTTPS document; and
- `Range.toString()` matches the requested selected text after both values use
  the selected-text whitespace normalization rule.

Successful activation consumes the pending capture and stores an active scope
keyed by `sessionId`. Rejected activation clears the unusable capture and marks
the selected-text session as unscoped. An unscoped selected-text session must
not create an article-root cursor.

#### 5.4.3 Strict range-bounded traversal

The word-highlight cursor distinguishes article and selection scopes. Article
scope keeps the current semantic-root traversal.

Selection scope starts at the range's start boundary and keeps an immutable end
boundary. Every candidate node and match is clipped to the part intersecting
the selection. The cursor must never:

- inspect text before the selection start;
- create a highlight past the selection end; or
- continue into later article content after exhausting the selection.

If the current spoken word is absent from the remaining selected range, the
content script clears the visible highlight for that update and restores the
cursor to its pre-search position. Later word updates may still match inside
the range, but no search may escape it.

#### 5.4.4 Scope lifecycle

`WORD_HIGHLIGHT_UPDATE` may use only a scope whose `sessionId` matches the
message. A new session, stop, navigation, or `WORD_HIGHLIGHT_CLEAR` invalidates
the active cursor, scope, and visible highlight for the affected session.

Pending and active state have separate lifecycles. Clearing an old active
session must not erase a newly captured pending range while replacement
playback is being prepared. The new range becomes active only through the
explicit session-bound activation message.

### 5.5 Component changes

#### `src/content/reading_anchor.ts`

Replace the anonymous last-range slot with pending-capture and active-scope
operations. This module owns one-shot capture consumption, text validation,
connectivity validation, and session association. It does not search the DOM or
render highlights.

#### `src/content/selection_button.ts`

Continue capturing the active `Range` before sending `START_SELECTED_TEXT`, but
use the new pending-capture API. Rendering, positioning, accessibility, and
dismissal behavior remain unchanged.

#### `src/content/word_highlight.ts`

Capture eligible context-menu selections, receive scope-activation messages,
create article or range-bounded cursors, and enforce both selection boundaries
during matching. This module continues to own CSS Custom Highlight rendering.

#### `src/background/background.ts`

Mark context-menu and floating-button requests as selection-scoped. Activate
the content-side scope for the new `sessionId` before starting offscreen
playback. Scope-activation failure remains isolated from audio playback.

The background remains the single playback coordinator. This addendum adds no
queue, persistent selection state, or second session store.

### 5.6 Data flow

```text
Selection exists in the top-level page
    -> content script clones a pending Range
       (contextmenu event or floating-button activation)
    -> selected-text intent reaches background
    -> background validates and creates the selected-text Article
    -> shared coordinator stops the previous session
    -> shared coordinator creates a new sessionId
    -> background requests selection-scope activation in the owner tab
    -> content validates text and DOM connectivity
    -> content binds the Range to sessionId, or marks the session unscoped
    -> background dispatches PLAY to offscreen
    -> word updates use only the session-bound Range
```

Full-page reading skips pending-range capture and scope activation. Its word
updates continue using the semantic article root.

### 5.7 Error and race behavior

| Case | Required behavior |
| --- | --- |
| Context menu is canceled | Keep the pending capture inert; full-page playback cannot consume it. |
| Pending text does not match playback text | Reject the scope and do not highlight for that selected-text session. |
| Captured range is detached | Reject or invalidate the scope; audio continues. |
| Scope activation cannot reach the tab | Audio continues; selected-text highlighting remains off. |
| Spoken word is absent from the remaining range | Clear the current highlight, restore the cursor, and stay inside the selection. |
| Selection ends before later word updates | Clear the highlight and ignore out-of-range matches. |
| Old-session clear races with replacement startup | Clear only the old active scope and preserve the new pending capture. |
| A stale word update arrives | Ignore it because its `sessionId` does not own the active scope. |
| Full-page playback follows a canceled context menu | Ignore pending selection state and use article scope. |
| The page navigates or unloads | Discard pending and active selection state. |

### 5.8 Regression coverage

- Context-menu capture selects a passage whose opening phrase also appears in
  an earlier image caption; every highlighted word remains in the selection.
- A range spanning multiple text nodes and inline elements highlights from its
  exact start through its exact end.
- A word that exists only after the range clears the current highlight instead
  of matching the later occurrence.
- A mismatched or detached pending range produces no selected-text highlight.
- A canceled context-menu capture does not scope the next full-page session.
- The floating-button path uses and honors the same strict scope.
- Existing full-article sequential highlighting remains unchanged.
- Background scope activation occurs before offscreen `PLAY` dispatch.

### 5.9 Verification sequence

1. Run focused unit tests for the selection-scope contract.
2. Run the targeted Playwright word-highlight suite.
3. Run the complete unit-test suite.
4. Create a production extension build.
5. Run the complete Playwright suite.
6. Run `git diff --check`.

### 5.10 Success criteria

Both selected-text entry points highlight only inside the exact browser
selection, including repeated text and multi-node selections. Missing or unsafe
range information may disable highlighting but must never produce a highlight
outside the selected range. Full-page playback, audio generation, popup
controls, and local-only privacy boundaries remain unchanged.

### 5.11 Rejected alternatives

Querying the selection after the native menu click is timing-sensitive because
the browser or page may no longer preserve the live selection. Searching for
the selected string in the article cannot reliably distinguish repeated text
and is fragile when markup or whitespace differs from the normalized playback
string. Neither alternative satisfies strict selection boundaries.
