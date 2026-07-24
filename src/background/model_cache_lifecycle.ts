export interface ExtensionEventLike {
	addListener(listener: () => void): void;
}

export interface LifecycleEventsLike {
	onInstalled: ExtensionEventLike;
	onStartup: ExtensionEventLike;
}

export function registerModelCacheWarmLifecycle(events: LifecycleEventsLike, warm: () => void): void {
	events.onInstalled.addListener(() => {
		warm();
	});
	events.onStartup.addListener(() => {
		warm();
	});
}
