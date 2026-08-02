# Playlist Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm tính năng Queue đọc liên tiếp vào readit.dev — user thêm URL/tab vào queue, extension tự chuyển tab và đọc bài tiếp khi xong bài hiện tại.

**Architecture:** Module `playlist_queue.ts` độc lập quản lý state queue bằng pure functions. Background.ts tích hợp queue qua biến module-level, lắng nghe `completedNaturally` từ offscreen để auto-advance. Side Panel hiển thị queue card dọc và gửi message commands vào background.

**Tech Stack:** TypeScript strict, Node test runner (unit), Playwright (e2e), chrome.storage.local (persist), chrome.runtime.onMessage (IPC).

## Global Constraints

- TypeScript strict mode — không dùng `any`, không bypass type guard
- Biome formatter: tabs, 4-space tab width, 140-char line width
- Tên file: lowercase/snake_case cho modules, PascalCase cho React components
- Tất cả string action phải là string literal const (không magic string lẻ)
- `chrome.storage.local` cho persist (không phải `session`)
- Unit test dùng Node built-in `test` + `assert/strict` — không cần framework ngoài
- E2E test: Playwright, reuse `tests/e2e/fixtures.ts`, tên file `*.spec.ts`

---

## File Map

| File | Action | Trách nhiệm |
|---|---|---|
| `src/background/playlist_queue.ts` | CREATE | Pure functions + storage cho queue |
| `src/shared/types.ts` | MODIFY | Thêm `QueueItem`, `PlaylistQueue`, `completedNaturally` vào `PlaybackProgress` |
| `src/shared/constants.ts` | MODIFY | Thêm `STORAGE_KEYS.PLAYLIST_QUEUE` |
| `src/background/background.ts` | MODIFY | Tích hợp queue, hydrate, auto-advance, message handlers |
| `src/sidepanel/App.tsx` | MODIFY | Thêm QueueCard section |
| `src/sidepanel/sidepanel.css` | MODIFY | Style cho queue card và items |
| `src/offscreen/` | MODIFY | Set `completedNaturally: true` khi TTS kết thúc tự nhiên |
| `tests/unit/playlist_queue.test.ts` | CREATE | Unit tests cho module playlist_queue |
| `tests/e2e/playlist-queue.spec.ts` | CREATE | E2E tests cho queue flow |

---

## Task 1: Types + Constants

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`

**Interfaces:**
- Produces: `QueueItem`, `PlaylistQueue`, updated `PlaybackProgress` — dùng trong mọi task sau

- [ ] **Step 1: Thêm types vào `src/shared/types.ts`**

Mở file, thêm sau block `PlaybackProgress` (dòng 58):

```typescript
export interface QueueItem {
    id: string;
    url: string;
    normalizedUrl: string;
    title: string;
    addedAt: number;
    status: 'pending' | 'playing' | 'done' | 'error';
}

export interface PlaylistQueue {
    items: QueueItem[];
    activeIndex: number | null;
}
```

Sửa interface `PlaybackProgress` (dòng 50-58) — thêm field `completedNaturally`:

```typescript
export interface PlaybackProgress {
    status: PlaybackStatus;
    currentParagraphIndex: number;
    totalParagraphs: number;
    progressPercentage: number;
    duration?: number;
    currentTime?: number;
    error?: string;
    completedNaturally?: boolean;
}
```

- [ ] **Step 2: Thêm storage key vào `src/shared/constants.ts`**

Trong object `STORAGE_KEYS` (dòng 38-47), thêm entry cuối:

```typescript
export const STORAGE_KEYS = {
    ACTIVE_VOICE: 'readit_active_voice',
    SPEED: 'readit_speed',
    READ_MODE_SETTINGS: 'readit_read_mode_settings',
    PLAYBACK_SESSION: 'readit_playback_session',
    AUDIO_EXPORT_JOB: 'readit_audio_export_job',
    THEME: 'readit_active_theme',
    SELECTION_BUTTON_ENABLED: 'readit_selection_button_enabled',
    WORD_HIGHLIGHT_ENABLED: 'readit_word_highlight_enabled',
    PLAYLIST_QUEUE: 'readit_playlist_queue',
};
```

- [ ] **Step 3: Build để kiểm tra type**

```bash
 pnpm build 2>&1 | head -30
```

Expected: build thành công, không có type error

- [ ] **Step 4: Commit**

```bash
 git add src/shared/types.ts src/shared/constants.ts
 git commit -m "feat(types): add QueueItem, PlaylistQueue types and PLAYLIST_QUEUE storage key"
```

---

## Task 2: Module `playlist_queue.ts` + Unit Tests (TDD)

**Files:**
- Create: `src/background/playlist_queue.ts`
- Create: `tests/unit/playlist_queue.test.ts`

**Interfaces:**
- Consumes: `QueueItem`, `PlaylistQueue` từ `src/shared/types.ts`; `STORAGE_KEYS` từ `src/shared/constants.ts`
- Produces:
  - `normalizeQueueUrl(raw: string): string`
  - `createPlaylistQueue(): PlaylistQueue`
  - `addToQueue(queue: PlaylistQueue, item: { url: string; title: string }): PlaylistQueue | { error: 'DUPLICATE_URL' }`
  - `markPlaying(queue: PlaylistQueue, id: string): PlaylistQueue`
  - `markDone(queue: PlaylistQueue, id: string): PlaylistQueue`
  - `markError(queue: PlaylistQueue, id: string): PlaylistQueue`
  - `removeItem(queue: PlaylistQueue, id: string): PlaylistQueue`
  - `requeueItem(queue: PlaylistQueue, id: string): PlaylistQueue`
  - `clearQueue(queue: PlaylistQueue): PlaylistQueue`
  - `getNextPending(queue: PlaylistQueue): QueueItem | null`
  - `saveQueue(queue: PlaylistQueue): Promise<void>`
  - `loadQueue(): Promise<PlaylistQueue>`

- [ ] **Step 1: Viết failing unit tests**

Tạo file `tests/unit/playlist_queue.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    addToQueue,
    clearQueue,
    createPlaylistQueue,
    getNextPending,
    markDone,
    markError,
    markPlaying,
    normalizeQueueUrl,
    removeItem,
    requeueItem,
} from '../../src/background/playlist_queue.ts';

// --- normalizeQueueUrl ---

test('normalizeQueueUrl strips fragment', () => {
    assert.equal(
        normalizeQueueUrl('https://example.com/article#section-1'),
        'https://example.com/article',
    );
});

test('normalizeQueueUrl keeps query params', () => {
    assert.equal(
        normalizeQueueUrl('https://example.com/page?p=2'),
        'https://example.com/page?p=2',
    );
});

test('normalizeQueueUrl throws on invalid URL', () => {
    assert.throws(() => normalizeQueueUrl('not-a-url'), { name: 'TypeError' });
});

// --- addToQueue ---

test('addToQueue adds item with pending status', () => {
    const queue = createPlaylistQueue();
    const result = addToQueue(queue, { url: 'https://example.com/a', title: 'Article A' });
    assert.ok(!('error' in result));
    const q = result as import('../../src/shared/types.ts').PlaylistQueue;
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0].status, 'pending');
    assert.equal(q.items[0].title, 'Article A');
    assert.equal(q.items[0].normalizedUrl, 'https://example.com/a');
});

test('addToQueue rejects duplicate pending URL', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const result = addToQueue(q1, { url: 'https://example.com/a#section', title: 'A again' });
    assert.deepEqual(result, { error: 'DUPLICATE_URL' });
});

test('addToQueue allows re-add of done item', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const q2 = markDone(q1, q1.items[0].id);
    const result = addToQueue(q2, { url: 'https://example.com/a', title: 'A' });
    assert.ok(!('error' in result));
    const q3 = result as import('../../src/shared/types.ts').PlaylistQueue;
    assert.equal(q3.items.length, 2);
});

// --- markPlaying / markDone / markError ---

test('markPlaying changes status to playing', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const id = q1.items[0].id;
    const q2 = markPlaying(q1, id);
    assert.equal(q2.items[0].status, 'playing');
});

test('markDone changes status to done', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const id = q1.items[0].id;
    const q2 = markDone(q1, id);
    assert.equal(q2.items[0].status, 'done');
});

test('markError changes status to error', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const id = q1.items[0].id;
    const q2 = markError(q1, id);
    assert.equal(q2.items[0].status, 'error');
});

// --- requeueItem ---

test('requeueItem changes done to pending', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const id = q1.items[0].id;
    const q2 = markDone(q1, id);
    const q3 = requeueItem(q2, id);
    assert.equal(q3.items[0].status, 'pending');
});

// --- removeItem ---

test('removeItem removes item from queue', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const id = q1.items[0].id;
    const q2 = removeItem(q1, id);
    assert.equal(q2.items.length, 0);
});

// --- getNextPending ---

test('getNextPending returns first pending item', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://a.com', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const q2 = addToQueue(q1, { url: 'https://b.com', title: 'B' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const q3 = markPlaying(q2, q2.items[0].id);
    const next = getNextPending(q3);
    assert.ok(next !== null);
    assert.equal(next.title, 'B');
});

test('getNextPending returns null when no pending items', () => {
    const queue = createPlaylistQueue();
    assert.equal(getNextPending(queue), null);
});

// --- clearQueue ---

test('clearQueue removes all items', () => {
    const queue = createPlaylistQueue();
    const q1 = addToQueue(queue, { url: 'https://a.com', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
    const q2 = clearQueue(q1);
    assert.equal(q2.items.length, 0);
    assert.equal(q2.activeIndex, null);
});
```

- [ ] **Step 2: Run tests — xác nhận fail**

```bash
 pnpm test:unit -- --test-name-pattern "playlist_queue" 2>&1 | tail -20
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/background/playlist_queue.ts`**

```typescript
import { STORAGE_KEYS } from '../shared/constants.ts';
import type { PlaylistQueue, QueueItem } from '../shared/types.ts';

export function normalizeQueueUrl(raw: string): string {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
}

export function createPlaylistQueue(): PlaylistQueue {
    return { items: [], activeIndex: null };
}

export function addToQueue(
    queue: PlaylistQueue,
    item: { url: string; title: string },
): PlaylistQueue | { error: 'DUPLICATE_URL' } {
    const normalizedUrl = normalizeQueueUrl(item.url);
    const isDuplicate = queue.items.some(
        (i) => i.status !== 'done' && i.normalizedUrl === normalizedUrl,
    );
    if (isDuplicate) {
        return { error: 'DUPLICATE_URL' };
    }
    const newItem: QueueItem = {
        id: crypto.randomUUID(),
        url: item.url,
        normalizedUrl,
        title: item.title,
        addedAt: Date.now(),
        status: 'pending',
    };
    return { ...queue, items: [...queue.items, newItem] };
}

function updateItemStatus(queue: PlaylistQueue, id: string, status: QueueItem['status']): PlaylistQueue {
    return {
        ...queue,
        items: queue.items.map((item) => (item.id === id ? { ...item, status } : item)),
    };
}

export function markPlaying(queue: PlaylistQueue, id: string): PlaylistQueue {
    const index = queue.items.findIndex((i) => i.id === id);
    return {
        ...updateItemStatus(queue, id, 'playing'),
        activeIndex: index >= 0 ? index : queue.activeIndex,
    };
}

export function markDone(queue: PlaylistQueue, id: string): PlaylistQueue {
    return updateItemStatus(queue, id, 'done');
}

export function markError(queue: PlaylistQueue, id: string): PlaylistQueue {
    return updateItemStatus(queue, id, 'error');
}

export function removeItem(queue: PlaylistQueue, id: string): PlaylistQueue {
    return {
        ...queue,
        items: queue.items.filter((i) => i.id !== id),
        activeIndex:
            queue.activeIndex !== null && queue.items[queue.activeIndex]?.id === id
                ? null
                : queue.activeIndex,
    };
}

export function requeueItem(queue: PlaylistQueue, id: string): PlaylistQueue {
    return updateItemStatus(queue, id, 'pending');
}

export function clearQueue(queue: PlaylistQueue): PlaylistQueue {
    return { ...queue, items: [], activeIndex: null };
}

export function getNextPending(queue: PlaylistQueue): QueueItem | null {
    return queue.items.find((i) => i.status === 'pending') ?? null;
}

export async function saveQueue(queue: PlaylistQueue): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLIST_QUEUE]: queue });
}

export async function loadQueue(): Promise<PlaylistQueue> {
    const result = await chrome.storage.local.get(STORAGE_KEYS.PLAYLIST_QUEUE);
    const stored = result[STORAGE_KEYS.PLAYLIST_QUEUE];
    if (!stored || typeof stored !== 'object') {
        return createPlaylistQueue();
    }
    // Basic shape validation — tolerate stale storage
    const q = stored as Record<string, unknown>;
    if (!Array.isArray(q.items)) {
        return createPlaylistQueue();
    }
    return stored as PlaylistQueue;
}
```

- [ ] **Step 4: Run tests — xác nhận pass**

```bash
 pnpm test:unit -- --test-name-pattern "playlist_queue" 2>&1 | tail -20
```

Expected: tất cả tests PASS

- [ ] **Step 5: Run toàn bộ unit tests — không có regression**

```bash
 pnpm test:unit 2>&1 | tail -10
```

Expected: tất cả pass

- [ ] **Step 6: Commit**

```bash
 git add src/background/playlist_queue.ts tests/unit/playlist_queue.test.ts
 git commit -m "feat(queue): add playlist_queue module with pure state functions"
```

---

## Task 3: Offscreen — emit `completedNaturally`

**Files:**
- Modify: offscreen TTS completion handler (tìm nơi emit `status: 'stopped'`)

**Interfaces:**
- Consumes: `PlaybackProgress` từ `src/shared/types.ts` (đã có `completedNaturally?`)
- Produces: progress message với `completedNaturally: true` khi TTS kết thúc hết segments

- [ ] **Step 1: Tìm nơi offscreen emit stopped**

```bash
 grep -rn "status.*stopped\|stopped.*status" src/offscreen/ 2>&1
```

Ghi lại file và dòng.

- [ ] **Step 2: Tìm hàm emit PlaybackProgress trong offscreen**

```bash
 grep -rn "PLAYBACK_PROGRESS_UPDATE\|progressPercentage\|currentParagraphIndex" src/offscreen/ 2>&1 | head -20
```

- [ ] **Step 3: Thêm `completedNaturally: true` vào progress emit cuối**

Trong handler kết thúc TTS tự nhiên (khi đọc hết toàn bộ segments, không phải khi bị STOP command), thêm field:

```typescript
// Ví dụ — điều chỉnh theo code thực tế:
chrome.runtime.sendMessage({
    action: 'PLAYBACK_PROGRESS_UPDATE',
    sessionId: currentSessionId,
    progress: {
        status: 'stopped',
        currentParagraphIndex: totalParagraphs - 1,
        totalParagraphs,
        progressPercentage: 100,
        completedNaturally: true,  // <-- thêm dòng này
    },
});
```

Khi bị STOP command (user stop hoặc session replaced) — **không** set `completedNaturally`.

- [ ] **Step 4: Build và xác nhận không có type error**

```bash
 pnpm build 2>&1 | head -20
```

Expected: build thành công

- [ ] **Step 5: Commit**

```bash
 git add src/offscreen/
 git commit -m "feat(offscreen): emit completedNaturally flag when TTS finishes all segments"
```

---

## Task 4: Background — tích hợp queue + auto-advance

**Files:**
- Modify: `src/background/background.ts`

**Interfaces:**
- Consumes:
  - `createPlaylistQueue`, `addToQueue`, `markPlaying`, `markDone`, `markError`, `removeItem`, `requeueItem`, `clearQueue`, `getNextPending`, `saveQueue`, `loadQueue` từ `./playlist_queue.ts`
  - `QueueItem`, `PlaylistQueue` từ `../shared/types.ts`
- Produces: handlers cho messages `ADD_TAB_TO_QUEUE`, `ADD_URL_TO_QUEUE`, `REMOVE_QUEUE_ITEM`, `REQUEUE_ITEM`, `CLEAR_QUEUE`, `GET_PLAYLIST_QUEUE`; broadcast `PLAYLIST_QUEUE_UPDATE`

- [ ] **Step 1: Import playlist_queue vào background.ts**

Thêm import ở đầu file (sau các import hiện tại):

```typescript
import {
    addToQueue,
    clearQueue,
    createPlaylistQueue,
    getNextPending,
    loadQueue,
    markDone,
    markError,
    markPlaying,
    removeItem,
    requeueItem,
    saveQueue,
} from './playlist_queue.ts';
import type { PlaylistQueue } from '../shared/types.ts';
```

- [ ] **Step 2: Thêm biến module-level `playlistQueue`**

Sau dòng `let hydrated = false;` (dòng ~90), thêm:

```typescript
let playlistQueue: PlaylistQueue = createPlaylistQueue();
```

- [ ] **Step 3: Hydrate queue trong `ensureHydrated()`**

Trong function `ensureHydrated()` (dòng ~198), sau dòng `hydrated = true;`, thêm:

```typescript
playlistQueue = await loadQueue();
```

- [ ] **Step 4: Thêm `broadcastQueue()` helper**

Sau function `broadcastSession` (dòng ~234), thêm:

```typescript
async function broadcastQueue(queue: PlaylistQueue): Promise<void> {
    try {
        await chrome.runtime.sendMessage({ action: 'PLAYLIST_QUEUE_UPDATE', queue });
    } catch (_error) {
        // Side Panel may be closed.
    }
}
```

- [ ] **Step 5: Sửa `applyProgressMessage` để auto-advance**

Sửa function `applyProgressMessage` (dòng ~976-995). Thay block xử lý `status === 'stopped'`:

```typescript
// Trước (dòng 987-991):
if (updatedSession.status === 'stopped') {
    await clearSession();
    await closeOffscreenWhenIdle();
    return;
}

// Sau:
if (updatedSession.status === 'stopped') {
    const completedNaturally = (message.progress as Record<string, unknown>)?.completedNaturally === true;
    await clearSession();

    if (completedNaturally) {
        // Tìm item đang playing trong queue (theo normalizedUrl của session)
        const playingItem = playlistQueue.items.find(
            (i) => i.status === 'playing',
        );
        if (playingItem) {
            playlistQueue = markDone(playlistQueue, playingItem.id);
            await saveQueue(playlistQueue);
            await broadcastQueue(playlistQueue);

            const nextItem = getNextPending(playlistQueue);
            if (nextItem) {
                playlistQueue = markPlaying(playlistQueue, nextItem.id);
                await saveQueue(playlistQueue);
                await broadcastQueue(playlistQueue);

                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab?.id) {
                    await chrome.tabs.update(activeTab.id, { url: nextItem.url });
                    // chrome.tabs.onUpdated sẽ trigger startCurrentPage khi tab load xong
                    // Cần lưu pending navigation để biết đây là queue advance
                    pendingQueueNavigation = nextItem;
                }
            }
        }
    }

    await closeOffscreenWhenIdle();
    return;
}
```

- [ ] **Step 6: Thêm biến `pendingQueueNavigation` và xử lý trong `onUpdated`**

Thêm biến module-level sau `playlistQueue`:

```typescript
let pendingQueueNavigation: import('../shared/types.ts').QueueItem | null = null;
```

Sửa handler `chrome.tabs.onUpdated` (dòng ~1222-1228). Thêm logic xử lý queue navigation:

```typescript
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== undefined || changeInfo.url !== undefined) {
        void enqueue(() => stopIfNavigatedAway(tabId));
    }
    // Auto-advance queue: khi tab load xong và có pending queue navigation
    if (changeInfo.status === 'complete' && pendingQueueNavigation) {
        const queueItem = pendingQueueNavigation;
        void enqueue(async () => {
            await ensureHydrated();
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab?.id !== tabId) return;
            pendingQueueNavigation = null;
            await startCurrentPage();
        });
    }
});
```

- [ ] **Step 7: Thêm message handlers vào switch trong `chrome.runtime.onMessage`**

Trong switch (dòng ~1018), thêm các cases trước `default:`:

```typescript
case 'GET_PLAYLIST_QUEUE':
    return respondFromQueue(async () => {
        await ensureHydrated();
        return { queue: playlistQueue };
    }, sendResponse);

case 'ADD_TAB_TO_QUEUE': {
    return respondFromQueue(async () => {
        await ensureHydrated();
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.url || !activeTab.id) {
            return { success: false, error: 'No active tab' };
        }
        const result = addToQueue(playlistQueue, {
            url: activeTab.url,
            title: activeTab.title ?? new URL(activeTab.url).hostname,
        });
        if ('error' in result) {
            return { success: false, error: result.error };
        }
        playlistQueue = result;
        await saveQueue(playlistQueue);
        await broadcastQueue(playlistQueue);
        return { success: true };
    }, sendResponse);
}

case 'ADD_URL_TO_QUEUE': {
    const urlPayload = (msg.payload as { url?: unknown } | undefined)?.url;
    if (typeof urlPayload !== 'string') {
        sendResponse({ success: false, error: 'Invalid URL' });
        return undefined;
    }
    const rawUrl = urlPayload;
    return respondFromQueue(async () => {
        await ensureHydrated();
        let url: URL;
        try {
            url = new URL(rawUrl);
        } catch {
            return { success: false, error: 'Invalid URL' };
        }
        const result = addToQueue(playlistQueue, {
            url: rawUrl,
            title: url.hostname,
        });
        if ('error' in result) {
            return { success: false, error: result.error };
        }
        playlistQueue = result;
        await saveQueue(playlistQueue);
        await broadcastQueue(playlistQueue);
        return { success: true };
    }, sendResponse);
}

case 'REMOVE_QUEUE_ITEM': {
    const removeId = (msg.payload as { id?: unknown } | undefined)?.id;
    if (typeof removeId !== 'string') {
        sendResponse({ success: false });
        return undefined;
    }
    return respondFromQueue(async () => {
        await ensureHydrated();
        playlistQueue = removeItem(playlistQueue, removeId);
        await saveQueue(playlistQueue);
        await broadcastQueue(playlistQueue);
        return { success: true };
    }, sendResponse);
}

case 'REQUEUE_ITEM': {
    const requeueId = (msg.payload as { id?: unknown } | undefined)?.id;
    if (typeof requeueId !== 'string') {
        sendResponse({ success: false });
        return undefined;
    }
    return respondFromQueue(async () => {
        await ensureHydrated();
        playlistQueue = requeueItem(playlistQueue, requeueId);
        await saveQueue(playlistQueue);
        await broadcastQueue(playlistQueue);
        return { success: true };
    }, sendResponse);
}

case 'CLEAR_QUEUE':
    return respondFromQueue(async () => {
        await ensureHydrated();
        playlistQueue = clearQueue(playlistQueue);
        await saveQueue(playlistQueue);
        await broadcastQueue(playlistQueue);
        return { success: true };
    }, sendResponse);
```

- [ ] **Step 8: Build — xác nhận không có type error**

```bash
 pnpm build 2>&1 | head -30
```

Expected: build thành công

- [ ] **Step 9: Run unit tests — không có regression**

```bash
 pnpm test:unit 2>&1 | tail -10
```

Expected: tất cả pass

- [ ] **Step 10: Commit**

```bash
 git add src/background/background.ts
 git commit -m "feat(background): integrate playlist queue with auto-advance on natural completion"
```

---

## Task 5: Side Panel UI — Queue Card

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/sidepanel.css`

**Interfaces:**
- Consumes:
  - Message `GET_PLAYLIST_QUEUE` → `{ queue: PlaylistQueue }`
  - Message `PLAYLIST_QUEUE_UPDATE` broadcast từ background
  - Commands: `ADD_TAB_TO_QUEUE`, `ADD_URL_TO_QUEUE`, `REMOVE_QUEUE_ITEM`, `REQUEUE_ITEM`, `CLEAR_QUEUE`
- Produces: Queue card section hiển thị trong Side Panel

- [ ] **Step 1: Thêm queue state và subscription vào `App.tsx`**

Trong component `App` (sau các useState hiện tại, dòng ~60), thêm:

```typescript
const [queue, setQueue] = useState<PlaylistQueue>({ items: [], activeIndex: null });
const [urlInput, setUrlInput] = useState('');
const [queueError, setQueueError] = useState('');
```

Import `PlaylistQueue` ở đầu file:

```typescript
import type { ..., PlaylistQueue } from '../shared/types.ts';
```

Trong `useEffect` hydration (dòng ~79), thêm sau `chrome.storage.local.get(...)`:

```typescript
// Load initial queue
chrome.runtime.sendMessage({ action: 'GET_PLAYLIST_QUEUE' }, (response: unknown) => {
    if (response && typeof response === 'object' && 'queue' in response) {
        setQueue((response as { queue: PlaylistQueue }).queue);
    }
});
```

Trong `useEffect` subscribe (nơi `subscribePlaybackState` được gọi), thêm listener cho queue updates:

```typescript
const handleMessage = (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    if (msg.action === 'PLAYLIST_QUEUE_UPDATE' && msg.queue) {
        setQueue(msg.queue as PlaylistQueue);
    }
};
chrome.runtime.onMessage.addListener(handleMessage);
return () => chrome.runtime.onMessage.removeListener(handleMessage);
```

- [ ] **Step 2: Thêm handler functions cho queue actions**

Trong component `App`, thêm các handlers:

```typescript
const handleAddCurrentTab = async () => {
    setQueueError('');
    const response = await chrome.runtime.sendMessage({ action: 'ADD_TAB_TO_QUEUE' }) as { success: boolean; error?: string };
    if (!response.success) {
        setQueueError(response.error === 'DUPLICATE_URL' ? 'URL này đã có trong queue.' : (response.error ?? 'Lỗi không xác định'));
    }
};

const handleAddUrl = async () => {
    setQueueError('');
    const response = await chrome.runtime.sendMessage({
        action: 'ADD_URL_TO_QUEUE',
        payload: { url: urlInput.trim() },
    }) as { success: boolean; error?: string };
    if (response.success) {
        setUrlInput('');
    } else {
        setQueueError(response.error === 'DUPLICATE_URL' ? 'URL này đã có trong queue.' : 'URL không hợp lệ.');
    }
};

const handleRemoveItem = (id: string) => {
    void chrome.runtime.sendMessage({ action: 'REMOVE_QUEUE_ITEM', payload: { id } });
};

const handleRequeueItem = (id: string) => {
    void chrome.runtime.sendMessage({ action: 'REQUEUE_ITEM', payload: { id } });
};

const handleClearQueue = () => {
    void chrome.runtime.sendMessage({ action: 'CLEAR_QUEUE' });
};
```

- [ ] **Step 3: Thêm Queue Card vào JSX**

Trong return JSX của `App`, thêm sau `</section>` của `manual-text-card` (dòng ~601) và trước `<SettingsCard`:

```tsx
<section className="queue-card" aria-labelledby="queue-title">
    <h2 id="queue-title">Queue đọc</h2>

    <div className="queue-add-controls">
        <button className="secondary-button queue-add-tab-btn" type="button" onClick={() => void handleAddCurrentTab()}>
            + Thêm tab hiện tại
        </button>
        <div className="queue-url-row">
            <input
                className="queue-url-input"
                type="url"
                placeholder="Dán URL..."
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAddUrl(); }}
                aria-label="URL để thêm vào queue"
            />
            <button
                className="secondary-button"
                type="button"
                disabled={!urlInput.trim()}
                onClick={() => void handleAddUrl()}
            >
                Thêm
            </button>
        </div>
        {queueError && <p className="queue-error" role="alert">{queueError}</p>}
    </div>

    {queue.items.length > 0 && (
        <>
            <ul className="queue-list" aria-label="Danh sách bài chờ đọc">
                {queue.items.map((item) => {
                    const icon = item.status === 'playing' ? '▶' : item.status === 'done' ? '✓' : item.status === 'error' ? '✕' : '·';
                    let hostname = '';
                    try { hostname = new URL(item.url).hostname; } catch { hostname = item.url; }
                    return (
                        <li key={item.id} className="queue-item" data-status={item.status}>
                            <span className="queue-item-icon" aria-hidden="true">{icon}</span>
                            <div className="queue-item-meta">
                                <span className="queue-item-title" title={item.title}>{item.title}</span>
                                <span className="queue-item-host">{hostname}</span>
                            </div>
                            <div className="queue-item-actions">
                                {item.status === 'done' && (
                                    <button className="queue-action-btn" type="button" onClick={() => handleRequeueItem(item.id)}>
                                        Re-add
                                    </button>
                                )}
                                {item.status === 'pending' && (
                                    <button className="queue-action-btn queue-remove-btn" type="button" aria-label="Xóa" onClick={() => handleRemoveItem(item.id)}>
                                        ✕
                                    </button>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
            <div className="queue-footer">
                <button className="secondary-button" type="button" onClick={handleClearQueue}>
                    Xóa tất cả
                </button>
                <span className="queue-stats">
                    {queue.items.filter((i) => i.status === 'done').length}/{queue.items.length} đã đọc
                </span>
            </div>
        </>
    )}
</section>
```

- [ ] **Step 4: Thêm CSS cho queue card vào `sidepanel.css`**

Append vào cuối file `src/sidepanel/sidepanel.css`:

```css
/* Queue Card */
.queue-card {
    background: var(--card-bg);
    border-radius: var(--radius-lg);
    padding: var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-sm);
}

.queue-card h2 {
    font-size: var(--font-sm);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
}

.queue-add-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
}

.queue-add-tab-btn {
    width: 100%;
}

.queue-url-row {
    display: flex;
    gap: var(--space-xs);
}

.queue-url-input {
    flex: 1;
    padding: var(--space-xs) var(--space-sm);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    color: var(--text-primary);
    font-size: var(--font-sm);
}

.queue-error {
    font-size: var(--font-xs);
    color: var(--color-error);
    margin: 0;
}

.queue-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
}

.queue-item {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-color);
    background: var(--surface-bg);
}

.queue-item[data-status='playing'] {
    border-color: var(--color-primary);
    background: var(--surface-active);
}

.queue-item[data-status='done'] {
    opacity: 0.6;
}

.queue-item-icon {
    font-size: var(--font-sm);
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
}

.queue-item-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.queue-item-title {
    font-size: var(--font-sm);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.queue-item-host {
    font-size: var(--font-xs);
    color: var(--text-secondary);
}

.queue-item-actions {
    flex-shrink: 0;
}

.queue-action-btn {
    background: none;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    padding: 2px var(--space-xs);
    font-size: var(--font-xs);
    cursor: pointer;
    color: var(--text-secondary);
}

.queue-action-btn:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
}

.queue-remove-btn:hover {
    border-color: var(--color-error);
    color: var(--color-error);
}

.queue-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: var(--space-xs);
}

.queue-stats {
    font-size: var(--font-xs);
    color: var(--text-secondary);
}
```

- [ ] **Step 5: Build — xác nhận không có lỗi**

```bash
 pnpm build 2>&1 | head -30
```

Expected: build thành công

- [ ] **Step 6: Run unit tests — không có regression**

```bash
 pnpm test:unit 2>&1 | tail -10
```

Expected: tất cả pass

- [ ] **Step 7: Commit**

```bash
 git add src/sidepanel/App.tsx src/sidepanel/sidepanel.css
 git commit -m "feat(sidepanel): add playlist queue card UI"
```

---

## Task 6: E2E Tests

**Files:**
- Create: `tests/e2e/playlist-queue.spec.ts`

**Interfaces:**
- Consumes: `fixtures.ts` (extension context, side panel helpers), background queue state

- [ ] **Step 1: Xem fixtures.ts để biết helpers có sẵn**

```bash
 grep -n "export\|openSidePanel\|getSidePanel" tests/e2e/fixtures.ts | head -30
```

- [ ] **Step 2: Viết E2E test file**

Tạo `tests/e2e/playlist-queue.spec.ts`:

```typescript
import { test, expect } from './fixtures.ts';

test.describe('Playlist Queue', () => {
    test('add current tab to queue shows item in side panel', async ({ page, sidePanel, extensionId }) => {
        // Navigate to a readable page
        await page.goto('https://en.wikipedia.org/wiki/Text_to_speech');
        await page.waitForLoadState('networkidle');

        // Open side panel
        await sidePanel.open();

        // Click "Add current tab"
        await sidePanel.locator('button:has-text("Thêm tab hiện tại")').click();

        // Item should appear in queue list
        const queueList = sidePanel.locator('.queue-list');
        await expect(queueList.locator('.queue-item')).toHaveCount(1);
        await expect(queueList.locator('.queue-item-title')).toContainText('Text to speech');
    });

    test('add duplicate URL shows error', async ({ page, sidePanel }) => {
        await page.goto('https://en.wikipedia.org/wiki/Text_to_speech');
        await page.waitForLoadState('networkidle');
        await sidePanel.open();

        // Add current tab twice
        await sidePanel.locator('button:has-text("Thêm tab hiện tại")').click();
        await sidePanel.locator('button:has-text("Thêm tab hiện tại")').click();

        // Error should appear
        await expect(sidePanel.locator('.queue-error')).toBeVisible();
        // Only 1 item in queue
        await expect(sidePanel.locator('.queue-item')).toHaveCount(1);
    });

    test('add URL manually via input', async ({ page, sidePanel }) => {
        await page.goto('about:blank');
        await sidePanel.open();

        const input = sidePanel.locator('.queue-url-input');
        await input.fill('https://en.wikipedia.org/wiki/Podcast');
        await sidePanel.locator('.queue-url-row button').click();

        await expect(sidePanel.locator('.queue-item')).toHaveCount(1);
        await expect(sidePanel.locator('.queue-item-host')).toContainText('en.wikipedia.org');
    });

    test('remove pending item from queue', async ({ page, sidePanel }) => {
        await page.goto('about:blank');
        await sidePanel.open();

        const input = sidePanel.locator('.queue-url-input');
        await input.fill('https://en.wikipedia.org/wiki/Podcast');
        await sidePanel.locator('.queue-url-row button').click();

        await expect(sidePanel.locator('.queue-item')).toHaveCount(1);

        // Remove
        await sidePanel.locator('.queue-remove-btn').click();
        await expect(sidePanel.locator('.queue-item')).toHaveCount(0);
    });

    test('clear queue removes all items', async ({ page, sidePanel }) => {
        await page.goto('about:blank');
        await sidePanel.open();

        // Add 2 URLs
        for (const url of ['https://en.wikipedia.org/wiki/Podcast', 'https://en.wikipedia.org/wiki/Radio']) {
            await sidePanel.locator('.queue-url-input').fill(url);
            await sidePanel.locator('.queue-url-row button').click();
        }
        await expect(sidePanel.locator('.queue-item')).toHaveCount(2);

        await sidePanel.locator('button:has-text("Xóa tất cả")').click();
        await expect(sidePanel.locator('.queue-item')).toHaveCount(0);
    });

    test('queue persists after extension reload', async ({ page, sidePanel, context }) => {
        await page.goto('about:blank');
        await sidePanel.open();

        await sidePanel.locator('.queue-url-input').fill('https://en.wikipedia.org/wiki/Podcast');
        await sidePanel.locator('.queue-url-row button').click();
        await expect(sidePanel.locator('.queue-item')).toHaveCount(1);

        // Reload extension by reloading service worker page
        await context.backgroundPages()[0]?.reload();
        await page.waitForTimeout(1000);

        // Re-open side panel
        await sidePanel.close();
        await sidePanel.open();

        // Queue should still be there
        await expect(sidePanel.locator('.queue-item')).toHaveCount(1);
    });
});
```

**Note:** Adjust `sidePanel.open()`, `sidePanel.close()` và helpers cho đúng với fixtures.ts thực tế sau khi đọc file ở Step 1.

- [ ] **Step 3: Build extension**

```bash
 pnpm build 2>&1 | tail -5
```

- [ ] **Step 4: Run E2E tests**

```bash
 pnpm test:e2e -- --grep "Playlist Queue" 2>&1 | tail -30
```

Expected: tests pass (hoặc xác định tests cần điều chỉnh fixtures)

- [ ] **Step 5: Commit**

```bash
 git add tests/e2e/playlist-queue.spec.ts
 git commit -m "test(e2e): add playlist queue E2E test suite"
```

---

## Task 7: Manual Verification + Cleanup

- [ ] **Step 1: Load extension vào Chrome**

```bash
 pnpm dev
```

1. Mở `chrome://extensions/`
2. Enable Developer mode
3. Load unpacked → chọn `dist/chrome/`

- [ ] **Step 2: Test manual flow**

1. Mở 2 tab với bài Wikipedia (tab A và tab B)
2. Mở Side Panel
3. Ở tab A: bấm "Thêm tab hiện tại" → confirm item xuất hiện
4. Dán URL tab B vào input → bấm Thêm → confirm item thứ hai xuất hiện
5. Bấm Read (đọc tab A)
6. Chờ đọc xong → tab tự chuyển sang URL của tab B → tự bắt đầu đọc
7. Confirm item tab A đổi sang "✓ done", item tab B đổi sang "▶ playing"

- [ ] **Step 3: Run full test suite lần cuối**

```bash
 pnpm test:unit 2>&1 | tail -5
 pnpm build 2>&1 | tail -5
```

Expected: tất cả pass, build clean

- [ ] **Step 4: Final commit**

```bash
 git add .
 git commit -m "chore: final cleanup for playlist queue feature"
```

---

## Review corrections 2026-08-02

Execute this section after updating the two related specs and before changing
production code. It is a checklist for the review findings and does not expand
the queue scope. These invariants and checklist items supersede older plan text
where the two differ.

### Documentation-first invariants

- A queue-owned tab session carries `queueItemId`; manual and selection
  sessions do not carry queue ownership.
- Pending navigation is persisted in `chrome.storage.session` as
  `{ itemId, tabId, expectedUrl }` and hydrated before `tabs.onUpdated`.
- Select the active tab before starting a queue; ordinary
  `START_CURRENT_PAGE` must not claim an item by matching its URL.
- `expectedUrl` and the actual URL must exactly match after normalization:
  remove the hash and retain the query. A redirect to a different URL is an
  `error`.
- Completion may finish only the item matching `activeSession.queueItemId`; an
  item with an error or pending navigation without an owner becomes `error`
  and offers Re-add.
- Local PDF support uses `file://*/*`, still depends on **Allow access to file
  URLs**, and fails closed for permission checks that time out or return an
  unknown result.

### Implementation checklist

- Add the storage key, type guard, and pure navigation helpers.
- Demote the previous `playing` item in `markPlaying`; attach the queue id when
  creating a tab session.
- Persist and clear pending navigation for Play, Replay, completion, tab
  close, mismatch, and service-worker hydration.
- Fix Side Panel localization, add Re-add for `error`, update the manifest
  validator, and make the E2E CacheStorage clone an independent copy.
- Remove whitespace introduced by the current change.

### Regression tests

- Add unit coverage for the manifest, file-access timeout, playback-session
  ownership, and the single-`playing` queue invariant.
- Navigation helpers must cover active-tab selection, exact URL matching,
  redirect mismatch, and tab close.
- E2E coverage must include persisted localized PDF errors, Re-add for failed
  items, and web-to-local-PDF queue auto-advance.
