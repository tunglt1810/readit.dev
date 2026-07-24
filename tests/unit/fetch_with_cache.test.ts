import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithCache } from '../../src/shared/model_cache.ts';

const url = 'https://example.com/model.onnx';

function installGlobals(fetchImpl: typeof fetch) {
	const originalCaches = globalThis.caches;
	const originalFetch = globalThis.fetch;
	const cache = {
		match: async () => undefined,
		put: async () => {},
	};

	Object.defineProperty(globalThis, 'caches', {
		configurable: true,
		writable: true,
		value: { open: async () => cache },
	});
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		writable: true,
		value: fetchImpl,
	});

	return () => {
		Object.defineProperty(globalThis, 'caches', {
			configurable: true,
			writable: true,
			value: originalCaches,
		});
		Object.defineProperty(globalThis, 'fetch', {
			configurable: true,
			writable: true,
			value: originalFetch,
		});
	};
}

test('shares one uncached URL fetch between concurrent callers', async () => {
	let resolveResponse!: (response: Response) => void;
	let signalFetchStarted!: () => void;
	let fetchCount = 0;
	const fetchStarted = new Promise<void>((resolve) => {
		signalFetchStarted = resolve;
	});
	const response = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});
	const restore = installGlobals(async () => {
		fetchCount++;
		signalFetchStarted();
		return await response;
	});

	try {
		const first = fetchWithCache(url);
		const second = fetchWithCache(url);
		await fetchStarted;
		assert.equal(fetchCount, 1);

		resolveResponse(new Response(new Uint8Array([1, 2, 3])));
		assert.deepEqual(Array.from(new Uint8Array(await first)), [1, 2, 3]);
		assert.deepEqual(Array.from(new Uint8Array(await second)), [1, 2, 3]);
	} finally {
		restore();
	}
});

test('retries an uncached URL after its shared request fails', async () => {
	let fetchCount = 0;
	const restore = installGlobals(async () => {
		fetchCount++;
		if (fetchCount === 1) {
			throw new Error('network unavailable');
		}
		return new Response(new Uint8Array([4, 5, 6]));
	});

	try {
		await assert.rejects(fetchWithCache(url), /network unavailable/);
		assert.deepEqual(Array.from(new Uint8Array(await fetchWithCache(url))), [4, 5, 6]);
		assert.equal(fetchCount, 2);
	} finally {
		restore();
	}
});
