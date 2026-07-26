# Word Highlight: Pre-computed Lookup Algorithm

## Problem

The current word highlight algorithm searches the live DOM **per word, per message** using a TreeWalker cursor. This causes:

1. **"Jump back" bug**: When transitioning between speech units, `WORD_HIGHLIGHT_CLEAR` resets the cursor to `null`. The next word creates a new cursor from the document start, matching an earlier occurrence of the same word instead of the current reading position.

2. **Consecutive duplicate skip**: Offscreen dedup compares word **text** (`wordTiming.text !== lastHighlightedWord`), so consecutive identical words ("rất rất") never send the second occurrence.

3. **No visibility handling**: The 50ms highlight timer and message relay run continuously even when the tab/browser is not focused, and the content script still paints and scrolls for an unseen document.

4. **No auto-scroll**: The highlighted word is not scrolled into view when it moves off-screen.

## Design: Pre-compute Word→Range Map

Instead of searching the DOM per-word during playback, **walk the DOM once at session start** and build a `Map<number, Range>` (globalWordIndex → DOM Range). Highlighting becomes an O(1) lookup.

### Scope and Decisions

- This change applies only to tab-owned `article` and `selection` playback. Side Panel manual highlighting keeps its existing cursor and `wordIndex` contract unchanged.
- `background.ts` passes the tab session's `contentScope` in the `PLAY` payload; offscreen stores that `article`/`selection` value solely to initialize generic highlighting. A manual `panelInstanceId` session never sends `WORD_HIGHLIGHT_INIT`.
- A word index is the zero-based position in the flattened `SpeechUnit.wordMap` sequence. The same sequence is used to build the DOM map and to offset each unit's `WordTimingWindow.wordIndex`; there is no second indexing scheme.
- Playback must never wait for, fail, or restart because a page cannot receive or build word highlights. A failed highlight initialization disables highlighting for that session only.
- Selection playback remains fail-closed: if the captured selection range is absent or invalid, no word may fall back to article-wide matching.
- When the document is hidden, the highlighter continues receiving indexes but performs no CSS mutation or scrolling. When it becomes visible it immediately renders the latest index. A visible article keeps highlighting when the extension action popup or another extension surface has focus. This deliberately keeps the offscreen 50 ms timer and its relay active so the resumed word is exact; it does not claim near-zero total highlight-pipeline CPU.
- A precomputed range is never searched for again. If DOM changes make a stored range invalid, the current visual highlight is cleared for that index rather than risking a jump to another identical word.

### Architecture

```
Session Start:
  Offscreen: all speech units ready → flatten wordMaps → globalWordList
  → WORD_HIGHLIGHT_INIT { sessionId, words, contentScope }
  → Background relays to content script tab and awaits its response
  → Content script: walks live DOM once → Map<globalIndex, Range>
  → Offscreen starts audio only after the relay completes or safely declines

During Playback:
  Offscreen: 50ms timer → findWordAtTime → wordIndex changed?
  → WORD_HIGHLIGHT_UPDATE { sessionId, wordIndex }
  → Background relays to content script tab
  → Content script: wordRanges.get(wordIndex) → CSS.highlights.set()

Tab Hidden:
  → Content script: clears CSS.highlights, tracks currentWordIndex, skips scrolling

Tab Visible (focused or not):
  → Content script: immediately highlights currentWordIndex

Session End:
  → WORD_HIGHLIGHT_CLEAR { sessionId }
  → Content script: clear highlights + dispose pre-computed map
```

### Session Protocol and Ordering

`WORD_HIGHLIGHT_INIT` is an initialization barrier, not a best-effort notification:

1. For a non-manual session, offscreen prepares every speech unit, flattens the exact `wordMap` entries, and awaits the background relay before it acknowledges `PLAY` and starts the first audio buffer.
2. The background validates that the active session is the same tab-owned session, then awaits `chrome.tabs.sendMessage` to content. Its response is `{ success: true }` only after content has synchronously built the map. The content listener must call `sendResponse({ success: true })` in that synchronous `INIT` branch; otherwise Chrome resolves the tab message with `undefined` and offscreen disables highlighting. A missing content script or a rejected response returns `{ success: false }`; audio continues with highlighting disabled.
3. Content accepts an `UPDATE` only when it has already accepted `INIT` for the same `sessionId`. It must not adopt a session ID from an update, buffer an update for a later initialization, or render a stale index.
4. A later `INIT` replaces only its own current session state. A `CLEAR` disposes state only when its `sessionId` matches the installed map; an old clear must not erase a newer session.
5. `INIT` and `CLEAR` remain serialized through the background queue. `UPDATE` keeps at most one pending message: while a tab relay is in flight, newer indexes replace the pending index so content receives the current word rather than an old backlog. A `CLEAR` discards a pending update only for that same session before it is serialized. The background still rejects all relay messages whose `sessionId` is no longer the active tab session.

This handshake avoids the first-word race without imposing a playback dependency on pages where the content script is unavailable.

### Component Changes

---

#### Offscreen (`offscreen.ts`)

**1. Dedup by wordIndex instead of text**

```ts
// Before (L329):
if (wordTiming.text !== lastHighlightedWord)

// After:
if (wordIndex !== lastHighlightedWordIndex)
```

This fixes the consecutive duplicate skip ("rất rất", "very very").

**2. Send wordIndex in WORD_HIGHLIGHT_UPDATE**

```ts
chrome.runtime.sendMessage({
  action: 'WORD_HIGHLIGHT_UPDATE',
  sessionId: currentExtensionSessionId,
  wordIndex,  // global word index across all units
});
```

Remove `word` field — content script no longer needs it.

**3. Send and await WORD_HIGHLIGHT_INIT when speech units are ready**

After all speech units are created (with wordMaps), flatten them into a single array and send to background for relay:

```ts
function buildWordHighlightWords(units: readonly SpeechUnit[]): WordHighlightWord[] {
  const words: { text: string; globalIndex: number }[] = [];
  for (const unit of units) {
    for (const entry of unit.wordMap ?? []) {
      words.push({ text: entry.text, globalIndex: words.length });
    }
  }
  return words;
}
```

The `globalIndex` must be contiguous from zero and must be derived from the same entries used by `wordIndexBase()` and `computeWordTimings()`. Do not derive it from spoken text, tokenization, or `SpeechUnit.text`.

Send via an awaited request before `sendResponse({ success: true })` and before `playNextUnit`:
```ts
const words = buildWordHighlightWords(speechUnits);
const highlightResponse = words.length > 0
  ? await chrome.runtime.sendMessage({
      action: 'WORD_HIGHLIGHT_INIT',
      sessionId: currentExtensionSessionId,
      words,
      contentScope: currentHighlightContentScope,
    })
  : { success: false };

genericHighlightReady = highlightResponse?.success === true;
```

`genericHighlightReady` is false for manual playback, an unavailable content script, an empty word list, or an invalid response. It only controls highlight messages; it never changes audio playback.

The new offscreen state is `currentHighlightContentScope: 'article' | 'selection' | null`, `genericHighlightReady: boolean`, and `lastHighlightedWordIndex: number`. Reset all three in terminal cleanup; set the scope from the new `PLAY` payload only for tab sessions.

**4. Remove inter-unit WORD_HIGHLIGHT_CLEAR**

`startWordHighlightTracking` currently calls `clearWordHighlightTracking()` which sends `WORD_HIGHLIGHT_CLEAR`. This resets the content script cursor — the root cause of "jump back".

Change: extract a separate `resetHighlightTimer()` for inter-unit use:

```ts
function resetHighlightTimer() {
  if (wordHighlightTimer !== null) {
    clearInterval(wordHighlightTimer);
    wordHighlightTimer = null;
  }
  lastHighlightedWordIndex = -1;
}

function clearWordHighlightTracking() {
  resetHighlightTimer();
  if (genericHighlightReady && currentExtensionSessionId) {
    chrome.runtime.sendMessage({ action: 'WORD_HIGHLIGHT_CLEAR', sessionId: currentExtensionSessionId });
  }
  genericHighlightReady = false;
}
```

`startWordHighlightTracking` calls `resetHighlightTimer()` (not `clearWordHighlightTracking`) and sends an update only when `genericHighlightReady` is true. `clearWordHighlightTracking()` is reserved for stop, session replacement, synthesis failure, and terminal playback cleanup, including a session that stops before its first word.

---

#### Background (`background.ts`)

**1. Relay WORD_HIGHLIGHT_INIT** — use `respondFromQueue`, so offscreen receives the result:
- Validate a non-empty `sessionId`, a contiguous word list, and `contentScope` of `article` or `selection`.
- Validate that the ID still matches the active tab-owned session.
- Await `chrome.tabs.sendMessage(tabId, { action: 'WORD_HIGHLIGHT_INIT', ... })` and return `{ success: true }` only when it resolves.
- Return `{ success: false }` on an unavailable tab/content receiver; do not call `failSession`.

**2. WORD_HIGHLIGHT_UPDATE relay** — validate a non-negative integer `wordIndex`, pass no word text, and relay only while the same initialized tab session is active. A one-slot coalescer submits at most one queued update to `enqueue`; while that relay is waiting or running, later indexes replace its pending index. `CLEAR` discards a pending index only when the session IDs match, then uses the same active-session guard through `enqueue`. This favors the audible current word over animating stale intermediate words.

Track `initializedWordHighlightSessionId` in the background after a successful relay and reset it in `clearSession`. This makes the update guard explicit rather than relying on message arrival order.

---

#### Content Script (`word_highlight.ts`) — Rewrite

**Core state:**

```ts
let wordRanges: Map<number, MappedWordRange> | null = null;
let currentWordIndex = -1;
let currentSessionId: string | null = null;
let enabled = true;
let visualUpdatesAllowed = document.visibilityState === 'visible';
let styleInjected = false;
```

No more `WalkerCursor`. No more `cursor` module-level state.

```ts
type MappedWordRange = { range: Range; variants: readonly string[] };

function disposeCurrentHighlightSession(): void {
  if (currentSessionId) clearActiveSelectionScope(currentSessionId);
  currentSessionId = null;
  wordRanges = null;
  currentWordIndex = -1;
  clearHighlight();
}

function isMappedRangeUsable(mapped: MappedWordRange): boolean {
  const { range } = mapped;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected || range.collapsed) return false;
  return wordVariants(range.toString()).some((variant) => mapped.variants.includes(variant));
}
```

**Pre-compute function:**

Reuses existing helpers: `resolveWalkerRoot`, `createWalker`, `wordVariants`, `findWordBoundaryMatch`, `isWithinNoiseRegion`.

```ts
function precomputeWordRanges(
  words: readonly WordHighlightWord[],
  scopeRange: Range | null,
): Map<number, MappedWordRange> {
  const ranges = new Map<number, MappedWordRange>();
  const root = resolveWalkerRoot(scopeRange);
  const walker = createWalker(root);
  let node = walker.nextNode() as Text | null;
  let offset = 0;

  // Skip nodes before scopeRange start (same logic as current createCursor)
  if (scopeRange) {
    while (node) {
      try {
        if (scopeRange.comparePoint(node, node.textContent?.length ?? 0) >= 0) break;
      } catch { break; }
      node = walker.nextNode() as Text | null;
    }
    if (node === scopeRange.startContainer) {
      offset = scopeRange.startOffset;
    }
  }

  for (const { text, globalIndex } of words) {
    const variants = wordVariants(text);
    if (variants.length === 0) continue;

    let found = false;
    let nodesScanned = 0;

    while (node && nodesScanned < MAX_NODES_SCANNED_PER_WORD && !found) {
      const searchText = (node.textContent ?? '').toLocaleLowerCase();
      let searchEnd = searchText.length;

      // Scope bounds for selection mode
      if (scopeRange) {
        const bounds = selectionSearchBounds(scopeRange, node, offset);
        if (bounds === 'after') break;
        if (bounds === null) {
          node = walker.nextNode() as Text | null;
          offset = 0;
          nodesScanned++;
          continue;
        }
        searchEnd = bounds.end;
        offset = bounds.start;
      }

      for (const variant of variants) {
        const matchIndex = findWordBoundaryMatch(searchText, variant, offset);
        if (matchIndex !== -1 && matchIndex + variant.length <= searchEnd) {
          const range = document.createRange();
          range.setStart(node, matchIndex);
          range.setEnd(node, matchIndex + variant.length);
          ranges.set(globalIndex, { range, variants });
          offset = matchIndex + variant.length;
          found = true;
          break;
        }
      }

      if (!found) {
        node = walker.nextNode() as Text | null;
        offset = 0;
        nodesScanned++;
      }
    }
    // If not found: skip this word (split across markup, etc.)
    // NO ROLLBACK — cursor continues forward.
  }

  return ranges;
}
```

**Key difference from current algorithm**: No rollback on miss. If word N is not found, cursor stays where it is and word N+1 searches forward from there. A missing mapping is normal for words split across markup; every later index remains independently addressable.

`MappedWordRange` retains the accepted normalized variants beside its `Range`. Before rendering, verify that both range boundary containers are connected, the range is non-collapsed, and `range.toString()` still equals one of those variants after lowercasing/Unicode normalization. If validation fails, delete that entry and clear the visual highlight. Do not re-walk the DOM or fall back to matching the word text.

**Highlight handler:**

```ts
function handleHighlightUpdate(wordIndex: number) {
  currentWordIndex = wordIndex;
  if (!enabled || !visualUpdatesAllowed || !wordRanges) return;
  applyHighlightForIndex(wordIndex);
}

function applyHighlightForIndex(wordIndex: number) {
  const mapped = wordRanges?.get(wordIndex);
  if (!mapped || !isMappedRangeUsable(mapped)) {
    wordRanges?.delete(wordIndex);
    clearHighlight();
    return;
  }
  ensureStyleInjected();
  CSS.highlights?.set(WORD_HIGHLIGHT_NAME, new Highlight(mapped.range));
  scrollIntoViewIfNeeded(mapped.range);
}
```

**Visibility gate:**

```ts
function updateVisualUpdatePermission() {
  visualUpdatesAllowed = document.visibilityState === 'visible';
  if (visualUpdatesAllowed && enabled && currentWordIndex >= 0) {
    applyHighlightForIndex(currentWordIndex);
  } else if (!visualUpdatesAllowed) {
    clearHighlight();
  }
}

document.addEventListener('visibilitychange', updateVisualUpdatePermission);
```

Changing the highlight preference follows the same rule: disabling clears immediately; enabling applies `currentWordIndex` only when visual updates are currently allowed. The map remains allocated while the setting is disabled, so re-enabling does not cause a new DOM scan.

**Scroll-into-view:**

```ts
function scrollIntoViewIfNeeded(range: Range) {
  const rect = range.getBoundingClientRect();
  if (rect.top < 0) {
    window.scrollBy({
      top: rect.top - window.innerHeight * 0.2,
      behavior: 'auto',
    });
    return;
  }
  if (rect.bottom > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
    range.startContainer.parentElement?.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest',
    });
  }
}
```

When the range is above the viewport, scroll the document so the range sits about 20% below the top edge. This avoids `nearest` treating a tall, still-partly-visible paragraph as already in view. For ranges below or horizontally outside the viewport, retain the parent `auto`/`nearest` scroll. The function is called only while visual updates are allowed.

**Message handler:**

```ts
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as { ... };

  if (msg.action === 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE' && ...) {
    // Same as current — activate selection scope
    currentSessionId = msg.sessionId;
    wordRanges = null;
    activatePendingSelectionScope(msg.sessionId, msg.selectionText);
    clearHighlight();
  }
  else if (isWordHighlightInitMessage(msg)) {
    if (currentSessionId !== msg.sessionId) {
      disposeCurrentHighlightSession();
      currentSessionId = msg.sessionId;
    } else {
      clearHighlight();
      wordRanges = null;
      currentWordIndex = -1;
    }
    const scopeRange = msg.contentScope === 'selection' && currentSessionId
      ? getActiveSelectionRange(currentSessionId) : null;
    wordRanges = msg.contentScope === 'selection' && !scopeRange
      ? new Map()
      : precomputeWordRanges(msg.words, scopeRange ?? null);
    currentWordIndex = -1;
    sendResponse({ success: true });
  }
  else if (msg.action === 'WORD_HIGHLIGHT_UPDATE' && typeof msg.wordIndex === 'number') {
    if (msg.sessionId !== currentSessionId || !wordRanges) return;
    handleHighlightUpdate(msg.wordIndex);
  }
  else if (msg.action === 'WORD_HIGHLIGHT_CLEAR' && ...) {
    // Session end only
    clearActiveSelectionScope(msg.sessionId);
    if (msg.sessionId === currentSessionId) disposeCurrentHighlightSession();
  }
});
```

`isWordHighlightInitMessage` verifies a non-empty ID, `article`/`selection` scope, and a contiguous zero-based word list with non-empty text before the handler mutates state. `WORD_HIGHLIGHT_SET_SELECTION_SCOPE` remains the first message for selection playback. It activates the captured range and clears any prior session; it does not itself create a map. `INIT` for an article session also clears a prior selection scope. An invalid `INIT` or `UPDATE` must be ignored with no state mutation.

---

#### Shared Types (`shared/word_highlight.ts`)

Add `WORD_HIGHLIGHT_INIT` action constant and word list type:

```ts
export interface WordHighlightWord {
  text: string;
  globalIndex: number;
}

export interface WordHighlightInitMessage {
  action: 'WORD_HIGHLIGHT_INIT';
  sessionId: string;
  contentScope: 'article' | 'selection';
  words: readonly WordHighlightWord[];
}

export interface WordHighlightUpdateMessage {
  action: 'WORD_HIGHLIGHT_UPDATE';
  sessionId: string;
  wordIndex: number;
}
```

---

#### Sidepanel (`manual_word_highlight.ts`)

**No changes needed.** Already uses wordIndex for dedup and forward-only cursor. Works correctly.

---

### What This Design Does NOT Change

- Article extraction pipeline
- Speech unit creation (wordMaps still created the same way)
- Audio playback
- 50ms timer in offscreen (only dedup logic changes)
- Selection capture/validation semantics in `reading_anchor.ts`
- `article_extractor.ts` (helpers still exported for content script use)

### Existing Helpers Reused As-Is

| Helper | Location | Used For |
|--------|----------|----------|
| `resolveWalkerRoot` | word_highlight.ts | Scope DOM walk to article root |
| `createWalker` | word_highlight.ts | TreeWalker with noise filter |
| `wordVariants` | word_highlight.ts | NFC/NFD variant generation |
| `findWordBoundaryMatch` | word_highlight.ts | Word boundary-aware indexOf |
| `isWordBoundaryMatch` | word_highlight.ts | Boundary character check |
| `selectionSearchBounds` | word_highlight.ts | Selection mode text node clipping |
| `isWithinNoiseRegion` | article_extractor.ts | Noise region filter for walker |
| `findSemanticRoot` | article_extractor.ts | Article root detection |

### Edge Cases

| Case | Current Behavior | New Behavior |
|------|-----------------|--------------|
| Consecutive duplicate ("rất rất") | Second word skipped (dedup by text) | ✅ Both highlighted (dedup by wordIndex) |
| Speech unit transition | Cursor reset → jump back | ✅ No reset, pre-computed ranges persist |
| Word split across markup (`<a>họ</a>c`) | Miss + rollback | Miss + skip (no rollback, no jump back) |
| Init/update race | First update can create an unscoped cursor | ✅ `INIT` relay completes before playback and updates require the installed session |
| Old session event | Can alter current cursor state | ✅ Ignore non-matching `UPDATE`/`CLEAR` |
| Selection range unavailable | May be tempted to search the article | ✅ Empty map; audio continues without page highlighting |
| DOM removes a mapped word | Cursor could search a duplicate elsewhere | ✅ Clear invalid range; never re-search |
| Tab hidden | Timer, messages, paint, and scroll continue | ✅ Timer/relay continue; paint and scroll suppressed, latest index renders when visible |
| Visible article loses focus to extension popup | Highlight clears until the article is clicked | ✅ Highlight and scrolling continue |
| Word below or horizontally outside viewport | No scroll | ✅ One `auto`/`nearest` parent scroll |
| Word above viewport inside a tall paragraph | Parent `nearest` can be a no-op | ✅ Range is positioned about 20% below the top edge |
| NFC/NFD mismatch | Both variants tried | Same (reuses wordVariants) |
| Punctuation-only word | Boundary check skipped | Same (reuses findWordBoundaryMatch) |

### Performance

| Metric | Current | New |
|--------|---------|-----|
| Startup | 0ms (lazy) | ~5-20ms (one DOM walk for typical 3000-word article) |
| Per-word highlight | ~0.01-0.5ms (TreeWalker scan) | ~0.001ms (Map.get lookup) |
| Total CPU (3000 words) | ~30-150ms scattered | ~10-23ms total |
| Memory | ~1KB cursor | ~100-300KB Range map |
| Hidden visual work | CSS mutation and scrolling | None; timer and relay deliberately remain active for exact immediate resume |

### Test Changes

E2E tests in `word-highlight.spec.ts` need updating:
1. Add typed helpers that send a contiguous `WORD_HIGHLIGHT_INIT` before index-only updates.
2. Preserve the existing exact-selection, end-boundary, NFC/NFD, noise-root, word-boundary, punctuation, split-markup, and full-article coverage under the new protocol.
3. Verify duplicate words at adjacent indexes and a later index in a second speech unit resolve to their distinct DOM occurrences.
4. Verify update-before-init, old-session update, and old-session clear cannot render or clear the accepted session.
5. Verify an invalid selection range produces no article-wide fallback highlight.
6. Add `word-highlight-runtime.spec.ts`: start a readable article through `START_CURRENT_PAGE` and assert that real offscreen playback creates a CSS highlight. This must not inject `INIT` or `UPDATE` directly.
7. The seeded Playwright profile may retain an old extension service worker. Before each cloned test profile starts, remove only its `Service Worker/ScriptCache` and `Service Worker/Database`; retain `CacheStorage` so the real model cache remains warm while the current `dist/` bundle is loaded.
8. Verify a removed/mutated stored range clears rather than matching an identical word elsewhere.
9. Verify a visible article continues rendering the latest index while `document.hasFocus()` is false; the extension popup must not suppress highlighting.
10. Verify a below-viewport word calls `scrollIntoView` once with `{ behavior: 'auto', block: 'nearest', inline: 'nearest' }`, while an in-view word does not.
11. Verify a word above the viewport inside one tall paragraph becomes visible after an update.
12. Unit-test that a slow relay transmits only its latest queued index, and that an old-session clear does not discard a new-session index.
