export interface WarmCacheDeps {
	urls: string[];
	isCached: (url: string) => Promise<boolean>;
	fetchAndCache: (url: string, progressCallback?: (loaded: number, total: number) => void) => Promise<void>;
	onProgress: (url: string, loaded: number, total: number) => void;
	onComplete: () => void;
}

export async function warmCache(deps: WarmCacheDeps): Promise<void> {
	for (const url of deps.urls) {
		if (await deps.isCached(url)) {
			continue;
		}
		await deps.fetchAndCache(url, (loaded, total) => {
			deps.onProgress(url, loaded, total);
		});
	}
	deps.onComplete();
}
