# Playlist Queue Design

## Overview

Thêm tính năng **Queue đọc liên tiếp** cho readit.dev: người dùng có thể thêm
nhiều URL/tab vào hàng chờ; khi đọc xong một bài, extension tự chuyển tab
hiện tại sang URL tiếp theo và bắt đầu đọc. Queue được persist vào
`chrome.storage.local` và hiển thị trong Side Panel.

---

## Data Model

### QueueItem

```ts
interface QueueItem {
    id: string;            // crypto.randomUUID()
    url: string;           // URL gốc, dùng để hiển thị và navigate
    normalizedUrl: string; // URL đã normalize, dùng để check trùng
    title: string;         // title lấy từ tab hoặc domain khi dán URL thủ công
    addedAt: number;       // Date.now()
    status: 'pending' | 'playing' | 'done' | 'error';
}

interface PlaylistQueue {
    items: QueueItem[];
    activeIndex: number | null;
}
```

### URL Normalization

Normalize được thực hiện **một lần duy nhất khi add**, kết quả lưu vào
`normalizedUrl`. Duplicate check so sánh trên `normalizedUrl`.

```ts
function normalizeQueueUrl(raw: string): string {
    const url = new URL(raw); // throws nếu URL không hợp lệ
    url.hash = '';            // bỏ fragment (#section)
    return url.href;          // giữ nguyên path và query params
}
```

Query params được giữ để phân biệt các trang phân trang. Fragment bị bỏ vì
không ảnh hưởng đến nội dung bài.

### Storage key

```ts
STORAGE_KEYS.PLAYLIST_QUEUE = 'readit_playlist_queue'; // add to constants.ts
STORAGE_KEYS.PENDING_QUEUE_NAVIGATION = 'readit_pending_queue_navigation';
```

---

## State Machine của QueueItem.status

```
PENDING  -> PLAYING  (background bắt đầu đọc item này)
PLAYING  -> DONE     (session kết thúc tự nhiên: completedNaturally = true)
PLAYING  -> ERROR    (extract article thất bại)
PLAYING  -> PENDING  (user skip)
DONE     -> PENDING  (user clicks Re-add)
ERROR    -> PENDING  (user clicks Re-add)
```

---

## Module mới: src/background/playlist_queue.ts

Trách nhiệm duy nhất: quản lý state của queue. Không biết gì về playback.

### API

Tất cả hàm mutate là **pure function**. Chỉ saveQueue / loadQueue có side effect.

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

### Duplicate check trong addToQueue

```ts
const normalizedUrl = normalizeQueueUrl(item.url);
const isDuplicate = queue.items.some(
    (i) => i.status !== 'done' && i.normalizedUrl === normalizedUrl
);
if (isDuplicate) return { error: 'DUPLICATE_URL' };
```

Items done không bị check trùng — cho phép re-add bài đã đọc.

---

## Integration vào background.ts

### Biến module-level mới

```ts
let playlistQueue: PlaylistQueue = createPlaylistQueue();
```

Khởi tạo từ storage khi background hydrate (cùng với activeSession).

### Phân biệt stop do user vs stop tự nhiên

Thêm optional field vào PlaybackProgress:

```ts
interface PlaybackProgress {
    // ...fields hiện tại...
    completedNaturally?: boolean; // true khi TTS đọc hết toàn bộ segments
}
```

Offscreen set completedNaturally: true khi kết thúc tự nhiên.

### Auto-advance logic

Khi background nhận status: 'stopped' với completedNaturally: true và
activeSession là item đang playing trong queue:

1. markDone(playlistQueue, activeItemId) -> lưu queue
2. getNextPending(playlistQueue) -> lấy item tiếp theo
3. Nếu có:
   - markPlaying(playlistQueue, nextItem.id) -> lưu queue
   - chrome.tabs.update(activeTabId, { url: nextItem.url })
   - Chờ chrome.tabs.onUpdated status: 'complete' -> trigger startPlayback
4. Broadcast PLAYLIST_QUEUE_UPDATE sau mỗi thay đổi

### Messages mới Side Panel -> Background

```ts
{ action: 'ADD_TAB_TO_QUEUE' }
// background lấy title + url từ tab active

{ action: 'ADD_URL_TO_QUEUE'; payload: { url: string } }
// title tạm = hostname

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

Queue card thêm sau manual-text-card, trước SettingsCard.

Layout (vertical card, theo pattern hiện có):

```
<section class="queue-card">
  <h2>Queue đọc</h2>

  <button class="primary-button">+ Thêm tab hiện tại</button>

  <div class="queue-url-input">
    <input type="url" placeholder="Dán URL..." />
    <button>Thêm</button>
  </div>
  <!-- inline error nếu trùng URL -->

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

Side Panel subscribe PLAYLIST_QUEUE_UPDATE trong useEffect theo pattern
subscribePlaybackState hiện tại.

---

## Verification Plan

### Unit tests (pnpm test:unit)

- normalizeQueueUrl: bỏ fragment, giữ query, throw với URL invalid
- addToQueue: duplicate check đúng với pending/playing, bỏ qua done
- State transitions: markDone, markError, requeueItem
- getNextPending: trả item pending đầu tiên, null nếu queue trống/hết pending

### E2E tests (pnpm test:e2e)

- Thêm tab hiện tại -> item xuất hiện trong Side Panel
- Thêm URL thủ công -> item với title = hostname
- Thêm URL trùng -> error inline, không thêm item mới
- Đọc xong bài đầu -> tab navigate sang URL thứ hai -> bắt đầu đọc
- Xóa item -> item biến mất; Re-add done -> về pending
- Queue persist sau khi reload extension

---

## Explicitly out of scope

- Drag-to-reorder
- Auto-fetch title từ URL (title tạm = hostname cho MVP)
- Queue từ context menu hoặc keyboard shortcut
- Loop / shuffle mode

---

## Review corrections 2026-08-02

The following invariants supplement and take precedence over the MVP
description above wherever navigation ownership or lifecycle is ambiguous.

### Queue ownership and playback session

- Only a tab playback session may carry `queueItemId?: string`. Manual
  playback and selected-text playback must not claim queue ownership.
- Ordinary `START_CURRENT_PAGE` must not claim a queue item merely because the
  current URL matches `normalizedUrl`. Only Play/Replay queue flows pass
  explicit ownership through `queueItemId`.
- `markPlaying` must demote the current `playing` item to `pending`, ensuring
  that the queue has at most one `playing` item.
- When natural completion is received, the background may call `markDone` only
  for the item whose id equals `activeSession.queueItemId`. Manual, selection,
  and tab sessions without that id must not auto-advance the queue.

### Pending navigation and service-worker recovery

Pending navigation is persisted in `chrome.storage.session` with this shape:

```ts
interface PendingQueueNavigation {
    itemId: string;
    tabId: number;
    expectedUrl: string; // normalizedQueueUrl(item.url)
}
```

- Queue flows select the active tab first; a flow that continues reading a
  specific tab may pass an explicit `tabId`.
- The background must persist pending navigation before `tabs.update` and
  hydrate it before processing `tabs.onUpdated`.
- Playback may start only when `tabId` and the actual URL exactly match
  `expectedUrl` after normalization (hash removed, query retained). A redirect
  to a different URL is a mismatch and must not start the wrong content.
- A closed tab, navigation mismatch, navigation error, or pending state whose
  owner is missing after service-worker restart must move the correct item to
  `error`, clear pending state, and broadcast the queue update.
- An `error` item can always be Re-added to `pending`; a `done` item keeps the
  existing Re-add behavior.

### Verification additions

- Ownership unit tests: the queue item id appears only on tab sessions, and
  completion cannot use a different `playing` item.
- Navigation unit tests: active-tab selection, `tabId` validation, exact
  normalized URL matching, and mismatch/close cleanup.
- The web-to-PDF queue E2E test must preserve item ownership; the Side Panel
  must display the localized PDF error and allow Re-add for the failed item.
