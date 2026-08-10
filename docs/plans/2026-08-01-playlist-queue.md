# Playlist Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consecutive queue reading functionality to readit.dev — users add URLs/tabs to the queue, and the extension automatically switches tabs and reads the next article when the current article completes.

**Architecture:** An independent `playlist_queue.ts` module manages queue state using pure functions. `background.ts` integrates the queue via module-level variables, listening for `completedNaturally` from offscreen to auto-advance. The Side Panel displays a vertical queue card and sends message commands to background.

**Tech Stack:** TypeScript strict, Node test runner (unit), Playwright (e2e), chrome.storage.local (persist), chrome.runtime.onMessage (IPC).

## Global Constraints

- TypeScript strict mode — do not use `any`, do not bypass type guards
- Biome formatter: tabs, 4-space tab width, 140-char line width
- File names: lowercase/snake_case for modules, PascalCase for React components
- All action strings must be string literal constants (no magic strings)
- `chrome.storage.local` for persistence (not `session`)
- Unit tests use built-in Node `test` + `assert/strict` — no external test framework
- E2E tests: Playwright, reuse `tests/e2e/fixtures.ts`, file names `*.spec.ts`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/background/playlist_queue.ts` | CREATE | Pure functions + storage for queue |
| `src/shared/types.ts` | MODIFY | Add `QueueItem`, `PlaylistQueue`, `completedNaturally` to `PlaybackProgress` |
| `src/shared/constants.ts` | MODIFY | Add `STORAGE_KEYS.PLAYLIST_QUEUE` |
| `src/background/background.ts` | MODIFY | Integrate queue, hydrate, auto-advance, message handlers |
| `src/sidepanel/App.tsx` | MODIFY | Add QueueCard section |
| `src/sidepanel/sidepanel.css` | MODIFY | Styles for queue card and items |
| `src/offscreen/` | MODIFY | Set `completedNaturally: true` when TTS completes naturally |
| `tests/unit/playlist_queue.test.ts` | CREATE | Unit tests for playlist_queue module |
| `tests/e2e/playlist-queue.spec.ts` | CREATE | E2E tests for queue flow |

---

## Task 1: Types + Constants

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`

**Interfaces:**
- Produces: `QueueItem`, `PlaylistQueue`, updated `PlaybackProgress` — used in all subsequent tasks

- [ ] **Step 1: Add types to `src/shared/types.ts`**

Open the file, add after the `PlaybackProgress` block (line 58):

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

Modify interface `PlaybackProgress` (lines 50-58) — add `completedNaturally` field:

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

- [ ] **Step 2: Add storage key to `src/shared/constants.ts`**

Inside `STORAGE_KEYS` object (lines 38-47), add entry at the end:

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

- [ ] **Step 3: Build to verify types**

```bash
 pnpm build 2>&1 | head -30
```

Expected: build succeeds with no type errors

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
- Consumes: `QueueItem`, `PlaylistQueue` from `src/shared/types.ts`; `STORAGE_KEYS` from `src/shared/constants.ts`
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

- [ ] **Step 1: Write failing unit tests**

Create file `tests/unit/playlist_queue.test.ts`:

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

- [ ] **Step 2: Run tests — confirm failure**

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

- [ ] **Step 4: Run tests — confirm pass**

```bash
 pnpm test:unit -- --test-name-pattern "playlist_queue" 2>&1 | tail -20
```

Expected: all tests PASS

- [ ] **Step 5: Run all unit tests — no regression**

```bash
 pnpm test:unit 2>&1 | tail -10
```

Expected: all pass

- [ ] **Step 6: Commit**

```bash
 git add src/background/playlist_queue.ts tests/unit/playlist_queue.test.ts
 git commit -m "feat(queue): add playlist_queue module with pure state functions"
```

---

## Task 3: Offscreen — emit `completedNaturally`

**Files:**
- Modify: offscreen TTS completion handler (find where `status: 'stopped'` is emitted)

**Interfaces:**
- Consumes: `PlaybackProgress` from `src/shared/types.ts` (which now has `completedNaturally?`)
- Produces: progress message with `completedNaturally: true` when TTS finishes all segments

- [ ] **Step 1: Find where offscreen emits stopped**

```bash
 grep -rn "status.*stopped\|stopped.*status" src/offscreen/ 2>&1
```

Note down the file and line.

- [ ] **Step 2: Find PlaybackProgress emit function in offscreen**

```bash
 grep -rn "PLAYBACK_PROGRESS_UPDATE\|progressPercentage\|currentParagraphIndex" src/offscreen/ 2>&1 | head -20
```

- [ ] **Step 3: Add `completedNaturally: true` to final progress emit**

In the natural TTS completion handler (when reading all segments, not upon a STOP command), add the field:

```typescript
// Example — adjust according to actual code:
chrome.runtime.sendMessage({
    action: 'PLAYBACK_PROGRESS_UPDATE',
    sessionId: currentSessionId,
    progress: {
        status: 'stopped',
        currentParagraphIndex: totalParagraphs - 1,
        totalParagraphs,
        progressPercentage: 100,
        completedNaturally: true,  // <-- add this line
    },
});
```

Upon a STOP command (user stop or session replaced) — **do not** set `completedNaturally`.

- [ ] **Step 4: Build and confirm no type errors**

```bash
 pnpm build 2>&1 | head -20
```

Expected: build succeeds

- [ ] **Step 5: Commit**

```bash
 git add src/offscreen/
 git commit -m "feat(offscreen): emit completedNaturally flag when TTS finishes all segments"
```

---

## Task 4: Background — integrate queue + auto-advance

**Files:**
- Modify: `src/background/background.ts`

**Interfaces:**
- Consumes:
  - `createPlaylistQueue`, `addToQueue`, `markPlaying`, `markDone`, `markError`, `removeItem`, `requeueItem`, `clearQueue`, `getNextPending`, `saveQueue`, `loadQueue` from `./playlist_queue.ts`
  - `QueueItem`, `PlaylistQueue` from `../shared/types.ts`
- Produces: handlers for messages `ADD_TAB_TO_QUEUE`, `ADD_URL_TO_QUEUE`, `REMOVE_QUEUE_ITEM`, `REQUEUE_ITEM`, `CLEAR_QUEUE`, `GET_PLAYLIST_QUEUE`; broadcast `PLAYLIST_QUEUE_UPDATE`

- [ ] **Step 1: Import playlist_queue into background.ts**

Add imports at top of file (after existing imports):

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

- [ ] **Step 2: Add module-level `playlistQueue` variable**

After line `let hydrated = false;` (line ~90), add:

```typescript
let playlistQueue: PlaylistQueue = createPlaylistQueue();
```

- [ ] **Step 3: Hydrate queue in `ensureHydrated()`**

In function `ensureHydrated()` (line ~198), after line `hydrated = true;`, add:

```typescript
playlistQueue = await loadQueue();
```

- [ ] **Step 4: Add `broadcastQueue()` helper**

After function `broadcastSession` (line ~234), add:

```typescript
async function broadcastQueue(queue: PlaylistQueue): Promise<void> {
    try {
        await chrome.runtime.sendMessage({ action: 'PLAYLIST_QUEUE_UPDATE', queue });
    } catch (_error) {
        // Side Panel may be closed.
    }
}
```

- [ ] **Step 5: Modify `applyProgressMessage` for auto-advance**

Modify function `applyProgressMessage` (lines ~976-995). Replace the `status === 'stopped'` handling block:

```typescript
// Before (lines 987-991):
if (updatedSession.status === 'stopped') {
    await clearSession();
    await closeOffscreenWhenIdle();
    return;
}

// After:
if (updatedSession.status === 'stopped') {
    const completedNaturally = (message.progress as Record<string, unknown>)?.completedNaturally === true;
    await clearSession();

    if (completedNaturally) {
        // Find playing item in queue (matching session normalizedUrl)
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
                    // chrome.tabs.onUpdated will trigger startCurrentPage when tab finishes loading
                    // Need to store pending navigation to identify queue advance
                    pendingQueueNavigation = nextItem;
                }
            }
        }
    }

    await closeOffscreenWhenIdle();
    return;
}
```

- [ ] **Step 6: Add `pendingQueueNavigation` variable and handle in `onUpdated`**

Add module-level variable after `playlistQueue`:

```typescript
let pendingQueueNavigation: import('../shared/types.ts').QueueItem | null = null;
```

Modify `chrome.tabs.onUpdated` handler (lines ~1222-1228). Add queue navigation handling logic:

```typescript
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== undefined || changeInfo.url !== undefined) {
        void enqueue(() => stopIfNavigatedAway(tabId));
    }
    // Auto-advance queue: when tab status complete and pending queue navigation exists
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

- [ ] **Step 7: Add message handlers to switch in `chrome.runtime.onMessage`**

In switch statement (line ~1018), add cases before `default:`:

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

- [ ] **Step 8: Build — confirm no type errors**

```bash
 pnpm build 2>&1 | head -30
```

Expected: build succeeds

- [ ] **Step 9: Run unit tests — no regression**

```bash
 pnpm test:unit 2>&1 | tail -10
```

Expected: all pass

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
  - Message `PLAYLIST_QUEUE_UPDATE` broadcast from background
  - Commands: `ADD_TAB_TO_QUEUE`, `ADD_URL_TO_QUEUE`, `REMOVE_QUEUE_ITEM`, `REQUEUE_ITEM`, `CLEAR_QUEUE`
- Produces: Queue card section displayed in Side Panel

- [ ] **Step 1: Add queue state and subscription to `App.tsx`**

In component `App` (after existing useState hooks, line ~60), add:

```typescript
const [queue, setQueue] = useState<PlaylistQueue>({ items: [], activeIndex: null });
const [urlInput, setUrlInput] = useState('');
const [queueError, setQueueError] = useState('');
```

Import `PlaylistQueue` at top of file:

```typescript
import type { ..., PlaylistQueue } from '../shared/types.ts';
```

In `useEffect` hydration (line ~79), add after `chrome.storage.local.get(...)`:

```typescript
// Load initial queue
chrome.runtime.sendMessage({ action: 'GET_PLAYLIST_QUEUE' }, (response: unknown) => {
    if (response && typeof response === 'object' && 'queue' in response) {
        setQueue((response as { queue: PlaylistQueue }).queue);
    }
});
```

In `useEffect` subscribe (where `subscribePlaybackState` is called), add listener for queue updates:

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

- [ ] **Step 2: Add handler functions for queue actions**

In component `App`, add handlers:

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

- [ ] **Step 3: Add Queue Card to JSX**

In JSX return of `App`, add after `</section>` of `manual-text-card` (line ~601) and before `<SettingsCard`:

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

- [ ] **Step 4: Add CSS for queue card to `sidepanel.css`**

Append to end of file `src/sidepanel/sidepanel.css`:

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

- [ ] **Step 5: Build — confirm no errors**

```bash
 pnpm build 2>&1 | head -30
```

Expected: build succeeds

- [ ] **Step 6: Run unit tests — no regression**

```bash
 pnpm test:unit 2>&1 | tail -10
```

Expected: all pass

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

- [ ] **Step 1: Inspect fixtures.ts for available helpers**

```bash
 grep -n "export\|openSidePanel\|getSidePanel" tests/e2e/fixtures.ts | head -30
```

- [ ] **Step 2: Write E2E test file**

Create `tests/e2e/playlist-queue.spec.ts`:

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

**Note:** Adjust `sidePanel.open()`, `sidePanel.close()` and helpers to match actual `fixtures.ts` after reading the file in Step 1.

- [ ] **Step 3: Build extension**

```bash
 pnpm build 2>&1 | tail -5
```

- [ ] **Step 4: Run E2E tests**

```bash
 pnpm test:e2e -- --grep "Playlist Queue" 2>&1 | tail -30
```

Expected: tests pass (or identify tests needing fixture adjustments)

- [ ] **Step 5: Commit**

```bash
 git add tests/e2e/playlist-queue.spec.ts
 git commit -m "test(e2e): add playlist queue E2E test suite"
```

---

## Task 7: Manual Verification + Cleanup

- [ ] **Step 1: Load extension into Chrome**

```bash
 pnpm dev
```

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Load unpacked → select `dist/chrome/`

- [ ] **Step 2: Test manual flow**

1. Open 2 tabs with Wikipedia articles (tab A and tab B)
2. Open Side Panel
3. On tab A: click "Thêm tab hiện tại" → confirm item appears
4. Paste tab B URL into input → click Add → confirm second item appears
5. Click Read (read tab A)
6. Wait for reading to complete → tab automatically switches to tab B URL → automatically starts reading
7. Confirm tab A item status changes to "✓ done", tab B item changes to "▶ playing"

- [ ] **Step 3: Run full test suite one last time**

```bash
 pnpm test:unit 2>&1 | tail -5
 pnpm build 2>&1 | tail -5
```

Expected: all pass, clean build

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
