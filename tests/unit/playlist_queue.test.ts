import assert from 'node:assert/strict';
import test from 'node:test';
import {
	addToQueue,
	clearQueue,
	createPlaylistQueue,
	deriveQueueHost,
	deriveQueueTitle,
	getNextPending,
	getPlayingItem,
	markDone,
	markError,
	markPlaying,
	normalizeQueueUrl,
	removeItem,
	requeueAllItems,
	requeueItem,
} from '../../src/background/playlist_queue.ts';

// --- deriveQueueTitle & deriveQueueHost ---

test('deriveQueueTitle derives filename from local file URL when title is empty', () => {
	const fileUrl = 'file:///Users/bez/Downloads/Claude%20Opus%20System%20Card.pdf';
	assert.equal(deriveQueueTitle(fileUrl, ''), 'Claude Opus System Card.pdf');
	assert.equal(deriveQueueTitle(fileUrl, '  '), 'Claude Opus System Card.pdf');
});

test('deriveQueueTitle keeps valid title when provided', () => {
	const fileUrl = 'file:///Users/bez/Downloads/Claude%20Opus%20System%20Card.pdf';
	assert.equal(deriveQueueTitle(fileUrl, 'Custom Title'), 'Custom Title');
});

test('deriveQueueHost returns Local File for file scheme', () => {
	assert.equal(deriveQueueHost('file:///Users/bez/Downloads/test.pdf'), 'Local File');
	assert.equal(deriveQueueHost('https://example.com/test.pdf'), 'example.com');
});

test('addToQueue derives filename title for local file URL when title is empty', () => {
	const queue = createPlaylistQueue();
	const fileUrl = 'file:///Users/bez/Downloads/Claude%20Opus%20System%20Card.pdf';
	const result = addToQueue(queue, { url: fileUrl, title: '' });
	assert.ok(!('error' in result));
	const q = result as import('../../src/shared/types.ts').PlaylistQueue;
	assert.equal(q.items[0].title, 'Claude Opus System Card.pdf');
});

// --- normalizeQueueUrl ---

test('normalizeQueueUrl strips fragment', () => {
	assert.equal(normalizeQueueUrl('https://example.com/article#section-1'), 'https://example.com/article');
});

test('normalizeQueueUrl keeps query params', () => {
	assert.equal(normalizeQueueUrl('https://example.com/page?p=2'), 'https://example.com/page?p=2');
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

test('markPlaying demotes the previous playing item to pending', () => {
	const queue = createPlaylistQueue();
	const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q2 = addToQueue(q1, { url: 'https://example.com/b', title: 'B' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q3 = markPlaying(q2, q2.items[0].id);
	const q4 = markPlaying(q3, q3.items[1].id);

	assert.equal(q4.items[0].status, 'pending');
	assert.equal(q4.items[1].status, 'playing');
	assert.equal(q4.items.filter((item) => item.status === 'playing').length, 1);
});

test('getPlayingItem returns only the explicitly owned playing item', () => {
	const queue = createPlaylistQueue();
	const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q2 = addToQueue(q1, { url: 'https://example.com/b', title: 'B' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q3 = markPlaying(q2, q2.items[1].id);

	assert.equal(getPlayingItem(q3, q3.items[0].id), null);
	assert.equal(getPlayingItem(q3, q3.items[1].id)?.id, q3.items[1].id);
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

test('requeueAllItems resets all items to pending status and clears activeIndex', () => {
	const queue = createPlaylistQueue();
	const q1 = addToQueue(queue, { url: 'https://example.com/a', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q2 = addToQueue(q1, { url: 'https://example.com/b', title: 'B' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q3 = markDone(q2, q2.items[0].id);
	const q4 = markError(q3, q3.items[1].id);
	const q5 = requeueAllItems(q4);
	assert.equal(q5.items[0].status, 'pending');
	assert.equal(q5.items[1].status, 'pending');
	assert.equal(q5.activeIndex, null);
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

// --- removeItem activeIndex adjustment ---

test('removeItem adjusts activeIndex when removing item before active', () => {
	const queue = createPlaylistQueue();
	const q1 = addToQueue(queue, { url: 'https://a.com', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q2 = addToQueue(q1, { url: 'https://b.com', title: 'B' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q3 = markPlaying(q2, q2.items[1].id); // activeIndex = 1
	assert.equal(q3.activeIndex, 1);
	const q4 = removeItem(q3, q3.items[0].id); // remove item at index 0
	assert.equal(q4.activeIndex, 0); // should shift down
	assert.equal(q4.items.length, 1);
});

test('removeItem sets activeIndex null when removing active item', () => {
	const queue = createPlaylistQueue();
	const q1 = addToQueue(queue, { url: 'https://a.com', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q2 = markPlaying(q1, q1.items[0].id); // activeIndex = 0
	const q3 = removeItem(q2, q2.items[0].id);
	assert.equal(q3.activeIndex, null);
	assert.equal(q3.items.length, 0);
});

// --- getNextPending skips error items ---

test('getNextPending skips error items', () => {
	const queue = createPlaylistQueue();
	const q1 = addToQueue(queue, { url: 'https://a.com', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q2 = addToQueue(q1, { url: 'https://b.com', title: 'B' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const q3 = markError(q2, q2.items[0].id);
	const next = getNextPending(q3);
	assert.ok(next !== null);
	assert.equal(next.title, 'B'); // skips error, finds first pending
});

// --- markError playing → error ---

test('markError transitions playing item to error', () => {
	const queue = createPlaylistQueue();
	const q1 = addToQueue(queue, { url: 'https://a.com', title: 'A' }) as import('../../src/shared/types.ts').PlaylistQueue;
	const id = q1.items[0].id;
	const q2 = markPlaying(q1, id);
	assert.equal(q2.items[0].status, 'playing');
	const q3 = markError(q2, id);
	assert.equal(q3.items[0].status, 'error');
});
