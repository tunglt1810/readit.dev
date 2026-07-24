export function createModelCacheWarmer(runWarm: () => Promise<void>) {
	let currentWarm: Promise<void> | null = null;

	return {
		warm(): Promise<void> {
			if (!currentWarm) {
				currentWarm = runWarm().finally(() => {
					currentWarm = null;
				});
			}
			return currentWarm;
		},
		waitForCurrentWarm(): Promise<void> {
			return currentWarm ?? Promise.resolve();
		},
	};
}
