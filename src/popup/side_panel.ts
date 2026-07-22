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
