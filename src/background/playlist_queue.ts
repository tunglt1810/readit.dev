import { STORAGE_KEYS } from '../shared/constants.ts';
import { t } from '../shared/i18n.ts';
import type { PlaylistQueue, QueueItem } from '../shared/types.ts';

export function normalizeQueueUrl(raw: string): string {
	const url = new URL(raw);
	url.hash = '';
	return url.href;
}

export function createPlaylistQueue(): PlaylistQueue {
	return { items: [], activeIndex: null };
}

export function deriveQueueTitle(rawUrl: string, rawTitle?: string): string {
	if (rawTitle && rawTitle.trim() && rawTitle.trim() !== rawUrl) {
		return rawTitle.trim();
	}
	try {
		const parsed = new URL(rawUrl);
		const filename = parsed.pathname.split('/').filter(Boolean).pop();
		if (filename) {
			return decodeURIComponent(filename);
		}
		if (parsed.hostname) {
			return parsed.hostname;
		}
	} catch {
		// Ignore invalid URL
	}
	return rawUrl;
}

export function deriveQueueHost(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol === 'file:') {
			return t('queueHostLocalFile');
		}
		return parsed.hostname || parsed.protocol;
	} catch {
		return rawUrl;
	}
}

export function addToQueue(queue: PlaylistQueue, item: { url: string; title: string }): PlaylistQueue | { error: 'DUPLICATE_URL' } {
	const normalizedUrl = normalizeQueueUrl(item.url);
	const isDuplicate = queue.items.some((i) => i.status !== 'done' && i.normalizedUrl === normalizedUrl);
	if (isDuplicate) {
		return { error: 'DUPLICATE_URL' };
	}
	const title = deriveQueueTitle(item.url, item.title);
	const newItem: QueueItem = {
		id: crypto.randomUUID(),
		url: item.url,
		normalizedUrl,
		title,
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
		...queue,
		items: queue.items.map((item) => {
			if (item.id === id) return { ...item, status: 'playing' as const };
			return item.status === 'playing' ? { ...item, status: 'pending' as const } : item;
		}),
		activeIndex: index >= 0 ? index : queue.activeIndex,
	};
}

export function getPlayingItem(queue: PlaylistQueue, id?: string): QueueItem | null {
	return queue.items.find((item) => item.status === 'playing' && (id === undefined || item.id === id)) ?? null;
}

export function markDone(queue: PlaylistQueue, id: string): PlaylistQueue {
	return updateItemStatus(queue, id, 'done');
}

export function markError(queue: PlaylistQueue, id: string): PlaylistQueue {
	return updateItemStatus(queue, id, 'error');
}

export function removeItem(queue: PlaylistQueue, id: string): PlaylistQueue {
	const removedIndex = queue.items.findIndex((i) => i.id === id);
	const newItems = queue.items.filter((i) => i.id !== id);
	let newActiveIndex = queue.activeIndex;
	if (removedIndex !== -1 && queue.activeIndex !== null) {
		if (queue.items[queue.activeIndex]?.id === id) {
			newActiveIndex = null;
		} else if (removedIndex < queue.activeIndex) {
			newActiveIndex = queue.activeIndex - 1;
		}
	}
	return { ...queue, items: newItems, activeIndex: newActiveIndex };
}

export function requeueItem(queue: PlaylistQueue, id: string): PlaylistQueue {
	return updateItemStatus(queue, id, 'pending');
}

export function requeueAllItems(queue: PlaylistQueue): PlaylistQueue {
	return {
		items: queue.items.map((item) => ({ ...item, status: 'pending' })),
		activeIndex: null,
	};
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

const VALID_STATUSES = new Set(['pending', 'playing', 'done', 'error']);

function isValidQueueItem(item: unknown): item is QueueItem {
	if (!item || typeof item !== 'object') return false;
	const i = item as Record<string, unknown>;
	return (
		typeof i.id === 'string' &&
		typeof i.url === 'string' &&
		typeof i.normalizedUrl === 'string' &&
		typeof i.title === 'string' &&
		typeof i.addedAt === 'number' &&
		VALID_STATUSES.has(i.status as string)
	);
}

export async function loadQueue(): Promise<PlaylistQueue> {
	const result = await chrome.storage.local.get(STORAGE_KEYS.PLAYLIST_QUEUE);
	const stored = result[STORAGE_KEYS.PLAYLIST_QUEUE];
	if (!stored || typeof stored !== 'object') {
		return createPlaylistQueue();
	}
	// Deep validation — filter out corrupt items, tolerate stale storage
	const q = stored as Record<string, unknown>;
	if (!Array.isArray(q.items)) {
		return createPlaylistQueue();
	}
	const validItems = (q.items as unknown[]).filter(isValidQueueItem);
	return { items: validItems, activeIndex: null };
}
