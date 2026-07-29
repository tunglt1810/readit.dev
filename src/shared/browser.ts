import browser from 'webextension-polyfill';

export default browser;

export async function openSidebarOrPanel(tabId?: number): Promise<void> {
	const anyBrowser = browser as unknown as {
		sidebarAction?: { open: () => Promise<void> };
		sidePanel?: { open: (options: { tabId?: number }) => Promise<void> };
	};

	if (anyBrowser.sidebarAction?.open) {
		await anyBrowser.sidebarAction.open();
	} else if (anyBrowser.sidePanel?.open) {
		await anyBrowser.sidePanel.open({ tabId });
	}
}
