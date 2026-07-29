export interface SidePanelDependencies {
	windowId: number | undefined;
	open(options: { windowId: number }): Promise<void>;
}

export function openSidePanelForCurrentWindow(dependencies: SidePanelDependencies): Promise<void> {
	if (!Number.isInteger(dependencies.windowId)) {
		return Promise.reject(new Error('Could not resolve the current window.'));
	}
	return dependencies.open({ windowId: dependencies.windowId as number });
}

export function handleOpenSidePanelCommand(
	command: string,
	tab?: { windowId?: number },
	openSidePanel: (options: { windowId: number }) => void = (options) => void chrome.sidePanel.open(options),
): boolean {
	if (command === 'open_side_panel') {
		if (typeof tab?.windowId === 'number') {
			openSidePanel({ windowId: tab.windowId });
			return true;
		}
	}
	return false;
}

export function buildSidePanelRegisterMessage(windowId: number) {
	return { action: 'REGISTER_SIDEPANEL', payload: { windowId } };
}

export function computeOpenSidePanelWindowIds(rawIds: Iterable<number>): number[] {
	const valid = new Set<number>();
	for (const id of rawIds) {
		if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
			valid.add(id);
		}
	}
	return Array.from(valid);
}

export function shouldFallbackToOpen(response: unknown): boolean {
	if (response && typeof response === 'object' && 'success' in response) {
		return (response as { success: boolean }).success === false;
	}
	return false;
}
