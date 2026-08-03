export interface BrowserSidebarApi {
	sidebarAction?: {
		open(): Promise<void>;
	};
	sidePanel?: {
		open(options: { windowId?: number }): Promise<void>;
	};
}

function getDefaultBrowserApi(): BrowserSidebarApi {
	const extensionGlobal = globalThis as typeof globalThis & {
		browser?: BrowserSidebarApi;
		chrome?: BrowserSidebarApi;
	};
	return extensionGlobal.browser ?? extensionGlobal.chrome ?? {};
}

export function openSidebarOrPanel(windowId?: number, api: BrowserSidebarApi = getDefaultBrowserApi()): Promise<void> {
	if (api.sidebarAction?.open) {
		return api.sidebarAction.open();
	}
	if (api.sidePanel?.open) {
		return api.sidePanel.open({ windowId });
	}
	return Promise.reject(new Error('No sidebar or side panel API is available.'));
}
