/**
 * The Side Panel is bound to a window, not a tab, so it outlives every tab switch inside that
 * window and has to re-read the current page itself. Both guards stay silent until the panel
 * window is known, otherwise the background would fall back to the last focused window.
 */

export function shouldRefreshForActivated(panelWindowId: number | null, activeInfo: { windowId: number }): boolean {
	return panelWindowId !== null && activeInfo.windowId === panelWindowId;
}

export function shouldRefreshForUpdated(
	panelWindowId: number | null,
	changeInfo: { status?: string },
	tab: { active?: boolean; windowId?: number },
): boolean {
	return panelWindowId !== null && changeInfo.status === 'complete' && tab.active === true && tab.windowId === panelWindowId;
}
