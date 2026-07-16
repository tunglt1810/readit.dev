export const SELECTION_BUTTON_HOST_ID = 'readit-dev-selection-button-host';
export const SELECTION_BUTTON_SIZE = 36;
export const SELECTION_BUTTON_ICON_SIZE = 26;

export interface StartSelectedTextMessage {
	action: 'START_SELECTED_TEXT';
	selectionText: string;
	pageLanguage: string;
}

export function isSelectionButtonEnabled(value: unknown): boolean {
	return value !== false;
}
