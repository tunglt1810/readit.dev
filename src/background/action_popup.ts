export interface ActionPopupApi {
	openPopup(options: { windowId: number }): Promise<void>;
}

export async function requestActionPopup(windowId: number, action: ActionPopupApi): Promise<void> {
	try {
		await action.openPopup({ windowId });
	} catch (_error) {
		// Popup availability must not prevent a valid selected-text start.
	}
}
