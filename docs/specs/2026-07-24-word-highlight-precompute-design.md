# Word Highlight: Pre-computed Lookup Algorithm

## Problem

The current word highlight algorithm searches the live DOM **per word, per message** using a TreeWalker cursor. This causes:

1. **"Jump back" bug**: When transitioning between speech units, `WORD_HIGHLIGHT_CLEAR` resets the cursor to `null`. The next word creates a new cursor from the document start, matching an earlier occurrence of the same word instead of the current reading position.

2. **Consecutive duplicate skip**: Offscreen dedup compares word **text** (`wordTiming.text !== lastHighlightedWord`), so consecutive identical words ("rất rất") never send the second occurrence.

3. **No visibility handling**: The 50ms highlight timer and message relay run continuously even when the tab/browser is not focused, wasting CPU on visual updates nobody sees.

4. **No auto-scroll**: The highlighted word is not scrolled into view when it moves off-screen.

## Design: Pre-compute Word→Range Map

Instead of searching the DOM per-word during playback, **walk the DOM once at session start** and build a `Map<number, Range>` (globalWordIndex → DOM Range). Highlighting becomes an O(1) lookup.

### Architecture

```
Session Start:
  Offscreen: all speech units ready → flatten wordMaps → globalWordList
  → WORD_HIGHLIGHT_INIT { sessionId, words, contentScope }
  → Background relays to content script tab
  → Content script: walks live DOM once → Map<globalIndex, Range>

During Playback:
  Offscreen: 50ms timer → findWordAtTime → wordIndex changed?
  → WORD_HIGHLIGHT_UPDATE { sessionId, wordIndex }
  → Background relays to content script tab
  → Content script: wordRanges.get(wordIndex) → CSS.highlights.set()

Tab Hidden:
  → Content script: skips CSS.highlights update, tracks currentWordIndex

Tab Visible:
  → Content script: immediately highlights currentWordIndex

Session End:
  → WORD_HIGHLIGHT_CLEAR { sessionId }
  → Content script: clear highlights + dispose pre-computed map
```

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

**3. Send WORD_HIGHLIGHT_INIT when speech units are ready**

After all speech units are created (with wordMaps), flatten them into a single array and send to background for relay:

```ts
function buildGlobalWordList(units: SpeechUnit[]): { text: string; globalIndex: number }[] {
  const words: { text: string; globalIndex: number }[] = [];
  for (const unit of units) {
    for (const entry of unit.wordMap ?? []) {
      words.push({ text: entry.text, globalIndex: words.length });
    }
  }
  return words;
}
```

Send via:
```ts
chrome.runtime.sendMessage({
  action: 'WORD_HIGHLIGHT_INIT',
  sessionId: currentExtensionSessionId,
  words: buildGlobalWordList(speechUnits),
});
```

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
  chrome.runtime.sendMessage({
    action: 'WORD_HIGHLIGHT_CLEAR',
    sessionId: currentExtensionSessionId,
  });
}
```

`startWordHighlightTracking` calls `resetHighlightTimer()` (not `clearWordHighlightTracking`).

---

#### Background (`background.ts`)

**1. Relay WORD_HIGHLIGHT_INIT** — same pattern as existing WORD_HIGHLIGHT_UPDATE relay:
- Validate sessionId matches current session
- `chrome.tabs.sendMessage(tabId, { action: 'WORD_HIGHLIGHT_INIT', ... })`

**2. WORD_HIGHLIGHT_UPDATE relay** — pass `wordIndex` instead of `word` text. Keep `contentScope`.

---

#### Content Script (`word_highlight.ts`) — Rewrite

**Core state:**

```ts
let wordRanges: Map<number, Range> | null = null;
let currentWordIndex = -1;
let currentSessionId: string | null = null;
let enabled = true;
let tabVisible = true;
let styleInjected = false;
```

No more `WalkerCursor`. No more `cursor` module-level state.

**Pre-compute function:**

Reuses existing helpers: `resolveWalkerRoot`, `createWalker`, `wordVariants`, `findWordBoundaryMatch`, `isWithinNoiseRegion`.

```ts
function precomputeWordRanges(
  words: { text: string; globalIndex: number }[],
  scopeRange: Range | null,
): Map<number, Range> {
  const ranges = new Map<number, Range>();
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
          ranges.set(globalIndex, range);
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

**Key difference from current algorithm**: No rollback on miss. If word N is not found, cursor stays where it is and word N+1 searches forward from there.

**Highlight handler:**

```ts
function handleHighlightUpdate(wordIndex: number) {
  currentWordIndex = wordIndex;
  if (!enabled || !tabVisible || !wordRanges) return;
  applyHighlightForIndex(wordIndex);
}

function applyHighlightForIndex(wordIndex: number) {
  const range = wordRanges?.get(wordIndex);
  if (range) {
    ensureStyleInjected();
    CSS.highlights?.set(WORD_HIGHLIGHT_NAME, new Highlight(range));
    scrollIntoViewIfNeeded(range);
  }
}
```

**Visibility gate:**

```ts
document.addEventListener('visibilitychange', () => {
  tabVisible = document.visibilityState === 'visible';
  if (tabVisible && currentWordIndex >= 0) {
    applyHighlightForIndex(currentWordIndex);
  } else if (!tabVisible) {
    CSS.highlights?.delete(WORD_HIGHLIGHT_NAME);
  }
});
```

**Scroll-into-view:**

```ts
function scrollIntoViewIfNeeded(range: Range) {
  const rect = range.getBoundingClientRect();
  const margin = window.innerHeight * 0.15;
  if (rect.top < margin || rect.bottom > window.innerHeight - margin) {
    range.startContainer.parentElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }
}
```

Only scrolls when the highlighted word is outside the viewport (±15% margin).

**Message handler:**

```ts
chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { ... };

  if (msg.action === 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE' && ...) {
    // Same as current — activate selection scope
    currentSessionId = msg.sessionId;
    wordRanges = null;
    activatePendingSelectionScope(msg.sessionId, msg.selectionText);
    clearHighlight();
  }
  else if (msg.action === 'WORD_HIGHLIGHT_INIT' && msg.words) {
    if (msg.sessionId !== currentSessionId) {
      currentSessionId = msg.sessionId ?? null;
    }
    const scopeRange = msg.contentScope === 'selection' && currentSessionId
      ? getActiveSelectionRange(currentSessionId) : null;
    wordRanges = precomputeWordRanges(msg.words, scopeRange ?? null);
    currentWordIndex = -1;
  }
  else if (msg.action === 'WORD_HIGHLIGHT_UPDATE' && typeof msg.wordIndex === 'number') {
    if (msg.sessionId !== currentSessionId) {
      currentSessionId = msg.sessionId ?? null;
      wordRanges = null; // Will need new INIT
    }
    handleHighlightUpdate(msg.wordIndex);
  }
  else if (msg.action === 'WORD_HIGHLIGHT_CLEAR' && ...) {
    // Session end only
    clearActiveSelectionScope(msg.sessionId);
    if (msg.sessionId === currentSessionId) {
      currentSessionId = null;
      wordRanges = null;
      currentWordIndex = -1;
      clearHighlight();
    }
  }
});
```

---

#### Shared Types (`shared/word_highlight.ts`)

Add `WORD_HIGHLIGHT_INIT` action constant and word list type:

```ts
export interface WordHighlightWord {
  text: string;
  globalIndex: number;
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
- `reading_anchor.ts`
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
| Tab hidden | Timer + messages continue | ✅ Visual updates suppressed, resume on focus |
| Word off-screen | No scroll | ✅ Auto-scroll with smooth behavior |
| NFC/NFD mismatch | Both variants tried | Same (reuses wordVariants) |
| Punctuation-only word | Boundary check skipped | Same (reuses findWordBoundaryMatch) |

### Performance

| Metric | Current | New |
|--------|---------|-----|
| Startup | 0ms (lazy) | ~5-20ms (one DOM walk for typical 3000-word article) |
| Per-word highlight | ~0.01-0.5ms (TreeWalker scan) | ~0.001ms (Map.get lookup) |
| Total CPU (3000 words) | ~30-150ms scattered | ~10-23ms total |
| Memory | ~1KB cursor | ~100-300KB Range map |
| Tab hidden CPU | Same as visible | Near zero (no CSS updates) |

### Test Changes

E2E tests in `word-highlight.spec.ts` need updating:
1. Send `WORD_HIGHLIGHT_INIT` before `WORD_HIGHLIGHT_UPDATE` messages
2. `WORD_HIGHLIGHT_UPDATE` sends `wordIndex` instead of `word` text
3. Tests for cursor rollback behavior become simpler (pre-compute has no rollback)
4. Add new tests: visibility gate, scroll-into-view, consecutive duplicates
