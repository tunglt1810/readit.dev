# Playlist Queue Design

## Overview

Adds a **consecutive queue reading** capability to readit.dev: users can add multiple URLs/tabs to a queue; when reading completes for an article, the extension automatically navigates the active tab to the next URL and begins reading. The queue is persisted to `chrome.storage.local` and displayed in the Side Panel.

---

## Data Model

### QueueItem

```ts
interface QueueItem {
    id: string;            // crypto.randomUUID()
    url: string;           // Original URL used for display and navigation
    normalizedUrl: string; // Normalized URL used for duplicate checking
    title: string;         // Title from tab, or domain name when pasting URL manually
    addedAt: number;       // Date.now()
    status: 'pending' | 'playing' | 'done' | 'error';
}

interface PlaylistQueue {
    items: QueueItem[];
    activeIndex: number | null;
}
```

### URL Normalization

Normalization is performed **once upon addition**, and the result is stored in `normalizedUrl`. Duplicate checks compare on `normalizedUrl`.

```ts
function normalizeQueueUrl(raw: string): string {
    const url = new URL(raw); // throws if URL is invalid
    url.hash = '';            // strip fragment (#section)
    return url.href;          // retain path and query params
}
```

Query parameters are retained to distinguish paginated pages. Fragments are removed as they do not change article content.

### Storage keys

```ts
STORAGE_KEYS.PLAYLIST_QUEUE = 'readit_playlist_queue'; // add to constants.ts
STORAGE_KEYS.PENDING_QUEUE_NAVIGATION = 'readit_pending_queue_navigation';
```

---

## QueueItem.status State Machine

```
PENDING  -> PLAYING  (background begins reading this item)
PLAYING  -> DONE     (session completes naturally: completedNaturally = true)
PLAYING  -> ERROR    (article extraction fails)
PLAYING  -> PENDING  (user skips item)
DONE     -> PENDING  (user clicks Re-add)
ERROR    -> PENDING  (user clicks Re-add)
```

---

## New Module: src/background/playlist_queue.ts

Sole responsibility: manage queue state. Has no knowledge of playback.

### API

All state mutations are **pure functions**. Only `saveQueue` / `loadQueue` produce side effects.

```ts
export function normalizeQueueUrl(raw: string): string
export function createPlaylistQueue(): PlaylistQueue
export function addToQueue(
    queue: PlaylistQueue,
    item: Omit<QueueItem, 'id' | 'normalizedUrl' | 'addedAt' | 'status'>
): PlaylistQueue | { error: 'DUPLICATE_URL' }
export function markPlaying(queue: PlaylistQueue, id: string): PlaylistQueue
export function markDone(queue: PlaylistQueue, id: string): PlaylistQueue
export function markError(queue: PlaylistQueue, id: string): PlaylistQueue
export function removeItem(queue: PlaylistQueue, id: string): PlaylistQueue
export function requeueItem(queue: PlaylistQueue, id: string): PlaylistQueue
export function clearQueue(queue: PlaylistQueue): PlaylistQueue
export function getNextPending(queue: PlaylistQueue): QueueItem | null
export function saveQueue(queue: PlaylistQueue): Promise<void>
export function loadQueue(): Promise<PlaylistQueue>
```

### Duplicate check in addToQueue

```ts
const normalizedUrl = normalizeQueueUrl(item.url);
const isDuplicate = queue.items.some(
    (i) => i.status !== 'done' && i.normalizedUrl === normalizedUrl
);
if (isDuplicate) return { error: 'DUPLICATE_URL' };
```

Completed (`done`) items are excluded from duplicate checking — allowing re-adding previously read articles.

---

## Integration into background.ts

### New module-level variable

```ts
let playlistQueue: PlaylistQueue = createPlaylistQueue();
```

Initialized from storage during background hydration (alongside `activeSession`).

### Distinguishing user stop vs natural completion

Add optional field to `PlaybackProgress`:

```ts
interface PlaybackProgress {
    // ...existing fields...
    completedNaturally?: boolean; // true when TTS finishes reading all segments
}
```

Offscreen sets `completedNaturally: true` upon natural completion.

### Auto-advance logic

When background receives `status: 'stopped'` with `completedNaturally: true` and `activeSession` matches the `playing` item in the queue:

1. `markDone(playlistQueue, activeItemId)` -> save queue
2. `getNextPending(playlistQueue)` -> get next item
3. If next item exists:
   - `markPlaying(playlistQueue, nextItem.id)` -> save queue
   - `chrome.tabs.update(activeTabId, { url: nextItem.url })`
   - Wait for `chrome.tabs.onUpdated` `status: 'complete'` -> trigger `startPlayback`
4. Broadcast `PLAYLIST_QUEUE_UPDATE` after every state change

### New Messages Side Panel -> Background

```ts
{ action: 'ADD_TAB_TO_QUEUE' }
// background retrieves title + url from active tab

{ action: 'ADD_URL_TO_QUEUE'; payload: { url: string } }
// fallback title = hostname

{ action: 'REMOVE_QUEUE_ITEM'; payload: { id: string } }

{ action: 'REQUEUE_ITEM'; payload: { id: string } }

{ action: 'CLEAR_QUEUE' }
```

### Broadcast Background -> Side Panel

```ts
{ action: 'PLAYLIST_QUEUE_UPDATE'; queue: PlaylistQueue }
```

---

## Side Panel UI

Queue card added after `manual-text-card`, before `SettingsCard`.

Layout (vertical card, following existing patterns):

```
<section class="queue-card">
  <h2>Queue đọc</h2>

  <button class="primary-button">+ Thêm tab hiện tại</button>

  <div class="queue-url-input">
    <input type="url" placeholder="Dán URL..." />
    <button>Thêm</button>
  </div>
  <!-- inline error on duplicate URL -->

  <ul class="queue-list">
    <!-- queue-item: data-status = pending | playing | done | error -->
    <!-- icon: playing=▶  pending=·  done=✓  error=✕ -->
    <!-- actions: [✕] remove if pending, [Re-add] if done or error -->
  </ul>

  <div class="queue-footer">
    <button class="secondary-button">Xóa tất cả</button>
    <span>{doneCount}/{totalCount} đã đọc</span>
  </div>
</section>
```

Side Panel subscribes to `PLAYLIST_QUEUE_UPDATE` in `useEffect` following the existing `subscribePlaybackState` pattern.

---

## Verification Plan

### Unit tests (pnpm test:unit)

- `normalizeQueueUrl`: strips fragment, keeps query, throws on invalid URL
- `addToQueue`: duplicate check accurate for pending/playing, ignores done items
- State transitions: `markDone`, `markError`, `requeueItem`
- `getNextPending`: returns first pending item, null if queue is empty or no pending items remain

### E2E tests (pnpm test:e2e)

- Add current tab -> item appears in Side Panel
- Add URL manually -> item added with title = hostname
- Add duplicate URL -> inline error shown, no new item added
- Complete reading first article -> tab navigates to second URL -> starts reading
- Remove item -> item disappears; Re-add done item -> moves to pending
- Queue persists across extension reload

---

## Explicitly out of scope

- Drag-to-reorder
- Auto-fetching title from URL (fallback title = hostname for MVP)
- Queueing from context menu or keyboard shortcut
- Loop / shuffle mode

---

## Review corrections 2026-08-02

The following invariants supplement and take precedence over the MVP description above wherever navigation ownership or lifecycle is ambiguous.

### Queue ownership and playback session

- Only a tab playback session may carry `queueItemId?: string`. Manual playback and selected-text playback must not claim queue ownership.
- Ordinary `START_CURRENT_PAGE` must not claim a queue item merely because the current URL matches `normalizedUrl`. Only Play/Replay queue flows pass explicit ownership through `queueItemId`.
- `markPlaying` must demote the current `playing` item to `pending`, ensuring that the queue has at most one `playing` item.
- When natural completion is received, the background may call `markDone` only for the item whose id equals `activeSession.queueItemId`. Manual, selection, and tab sessions without that id must not auto-advance the queue.

### Pending navigation and service-worker recovery

Pending navigation is persisted in `chrome.storage.session` with this shape:

```ts
interface PendingQueueNavigation {
    itemId: string;
    tabId: number;
    expectedUrl: string; // normalizedQueueUrl(item.url)
}
```

- Queue flows select the active tab first; a flow that continues reading a specific tab may pass an explicit `tabId`.
- The background must persist pending navigation before `tabs.update` and hydrate it before processing `tabs.onUpdated`.
- Playback may start only when `tabId` and the actual URL exactly match `expectedUrl` after normalization (hash removed, query retained). A redirect to a different URL is a mismatch and must not start the wrong content.
- A closed tab, navigation mismatch, navigation error, or pending state whose owner is missing after service-worker restart must move the correct item to `error`, clear pending state, and broadcast the queue update.
- An `error` item can always be Re-added to `pending`; a `done` item keeps the existing Re-add behavior.

### Verification additions

- Ownership unit tests: the queue item id appears only on tab sessions, and completion cannot use a different `playing` item.
- Navigation unit tests: active-tab selection, `tabId` validation, exact normalized URL matching, and mismatch/close cleanup.
- The web-to-PDF queue E2E test must preserve item ownership; the Side Panel must display the localized PDF error and allow Re-add for the failed item.
