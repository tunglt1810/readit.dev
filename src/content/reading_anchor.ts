let pendingSelectionRange: Range | null = null;
let activeSelectionScope: { sessionId: string; range: Range | null } | null = null;

function normalizeSelectionText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

export function capturePendingSelectionRange(range: Range | null): void {
	pendingSelectionRange = range;
}

export function activatePendingSelectionScope(sessionId: string, selectionText: string): Range | null {
	const range = pendingSelectionRange;
	pendingSelectionRange = null;
	const validRange =
		range?.commonAncestorContainer.isConnected === true &&
		normalizeSelectionText(range.toString()) === normalizeSelectionText(selectionText)
			? range
			: null;
	activeSelectionScope = { sessionId, range: validRange };
	return validRange;
}

export function getActiveSelectionRange(sessionId: string): Range | null | undefined {
	return activeSelectionScope?.sessionId === sessionId ? activeSelectionScope.range : undefined;
}

export function clearActiveSelectionScope(sessionId: string): void {
	if (activeSelectionScope?.sessionId === sessionId) {
		activeSelectionScope = null;
	}
}
