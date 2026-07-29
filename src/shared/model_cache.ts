export const MODEL_CACHE_NAME = 'supertonic-models';

const inFlightCacheFetches = new Map<string, Promise<ArrayBuffer>>();

export function fetchWithCache(
	url: string,
	progressCallback?: (loadedBytes: number, totalBytes: number) => void,
): Promise<ArrayBuffer> {
	const inFlight = inFlightCacheFetches.get(url);
	if (inFlight) {
		return inFlight;
	}

	const operation = fetchAndCache(url, progressCallback);
	const clearInFlight = () => {
		if (inFlightCacheFetches.get(url) === operation) {
			inFlightCacheFetches.delete(url);
		}
	};
	inFlightCacheFetches.set(url, operation);
	void operation.then(clearInFlight, clearInFlight);
	return operation;
}

async function fetchAndCache(
	url: string,
	progressCallback?: (loadedBytes: number, totalBytes: number) => void,
): Promise<ArrayBuffer> {
	const cache = await caches.open(MODEL_CACHE_NAME);
	const cachedResponse = await cache.match(url);

	if (cachedResponse) {
		return await cachedResponse.arrayBuffer();
	}
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
	}

	const contentLength = response.headers.get('content-length');
	const total = contentLength ? parseInt(contentLength, 10) : 0;

	if (total === 0 || !response.body) {
		const clone = response.clone();
		await cache.put(url, response);
		return await clone.arrayBuffer();
	}

	const reader = response.body.getReader();
	let loaded = 0;
	const chunks: Uint8Array[] = [];

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value) {
			chunks.push(value);
			loaded += value.length;
			if (progressCallback) {
				progressCallback(loaded, total);
			}
		}
	}

	const allChunks = new Uint8Array(loaded);
	let position = 0;
	for (const chunk of chunks) {
		allChunks.set(chunk, position);
		position += chunk.length;
	}

	// Save to Cache API
	const cachedResponseData = new Response(allChunks, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': loaded.toString(),
		},
	});
	await cache.put(url, cachedResponseData);

	return allChunks.buffer;
}
