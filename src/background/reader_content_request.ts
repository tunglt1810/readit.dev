export interface ReaderContentRequest {
	tabId: number;
	title: string;
	content: string;
	lang: string;
}

/**
 * The Reader page is both the loader and the display surface for local books, so the
 * owning tab is the sender itself rather than a separate content tab.
 */
export function parseReaderContentRequest(payload: unknown, senderTabId: number | undefined): ReaderContentRequest | null {
	if (!payload || typeof payload !== 'object' || typeof senderTabId !== 'number') {
		return null;
	}
	const request = payload as Record<string, unknown>;
	if (typeof request.title !== 'string' || typeof request.content !== 'string' || !request.content.trim()) {
		return null;
	}
	return {
		tabId: senderTabId,
		title: request.title,
		content: request.content,
		lang: typeof request.lang === 'string' && request.lang ? request.lang : 'na',
	};
}
