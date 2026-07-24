import assert from 'node:assert/strict';
import test from 'node:test';
import { warmCache } from '../../src/shared/warm_cache.ts';

test('does not report completion when a missing model fetch fails', async () => {
	let completed = false;

	await assert.rejects(
		warmCache({
			urls: ['https://example.com/model.onnx'],
			isCached: async () => false,
			fetchAndCache: async () => {
				throw new Error('offline');
			},
			onProgress: () => {},
			onComplete: () => {
				completed = true;
			},
		}),
		/offline/,
	);

	assert.equal(completed, false);
});

test('skips fetch when all URLs are already cached', async () => {
	const fetched: string[] = [];
	await warmCache({
		urls: ['https://example.com/a.onnx', 'https://example.com/b.onnx'],
		isCached: async () => true,
		fetchAndCache: async (url) => {
			fetched.push(url);
		},
		onProgress: () => {},
		onComplete: () => {},
	});
	assert.deepEqual(fetched, []);
});

test('fetches only missing URLs', async () => {
	const cachedUrls = new Set(['https://example.com/a.onnx']);
	const fetched: string[] = [];
	await warmCache({
		urls: ['https://example.com/a.onnx', 'https://example.com/b.onnx'],
		isCached: async (url) => cachedUrls.has(url),
		fetchAndCache: async (url) => {
			fetched.push(url);
		},
		onProgress: () => {},
		onComplete: () => {},
	});
	assert.deepEqual(fetched, ['https://example.com/b.onnx']);
});

test('calls onComplete after all fetches', async () => {
	let completed = false;
	await warmCache({
		urls: ['https://example.com/a.onnx'],
		isCached: async () => false,
		fetchAndCache: async () => {},
		onProgress: () => {},
		onComplete: () => {
			completed = true;
		},
	});
	assert.equal(completed, true);
});

test('calls onComplete when all URLs are cached', async () => {
	let completed = false;
	await warmCache({
		urls: ['https://example.com/a.onnx'],
		isCached: async () => true,
		fetchAndCache: async () => {},
		onProgress: () => {},
		onComplete: () => {
			completed = true;
		},
	});
	assert.equal(completed, true);
});

test('forwards progress from a missing URL fetch', async () => {
	const progressCalls: Array<{ url: string; loaded: number; total: number }> = [];
	await warmCache({
		urls: ['https://example.com/model.onnx'],
		isCached: async () => false,
		fetchAndCache: async (_url, progressCallback) => {
			progressCallback?.(50, 100);
			progressCallback?.(100, 100);
		},
		onProgress: (url, loaded, total) => {
			progressCalls.push({ url, loaded, total });
		},
		onComplete: () => {},
	});
	assert.deepEqual(progressCalls, [
		{ url: 'https://example.com/model.onnx', loaded: 50, total: 100 },
		{ url: 'https://example.com/model.onnx', loaded: 100, total: 100 },
	]);
});
