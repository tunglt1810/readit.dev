import type { PageInfoResponse } from '../shared/types.ts';

export interface PageInfoDependencies {
	sendMessage(tabId: number, message: { action: 'GET_PAGE_INFO' }): Promise<PageInfoResponse>;
	executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
}

export type ActiveTabQuery = { active: true; windowId: number } | { active: true; currentWindow: true };

/**
 * Side panels live per window, so they pass their own window id: a service worker has no
 * "current window" of its own and would otherwise resolve the last focused one.
 */
export function buildActiveTabQuery(payload: unknown): ActiveTabQuery {
	const windowId = (payload as { windowId?: unknown } | undefined)?.windowId;
	if (typeof windowId === 'number' && Number.isInteger(windowId) && windowId > 0) {
		return { active: true, windowId };
	}
	return { active: true, currentWindow: true };
}

/**
 * A tab that predates the extension's install or reload carries no content script, and the
 * extension cannot inject one without host permissions. The `tabs` permission still exposes the
 * tab's own address and title, which is enough to name the page even when nothing answers on it.
 */
export function pageInfoFromTab(tab: { url?: string; title?: string }): PageInfoResponse {
	if (!tab.url) {
		return { available: false };
	}
	return { available: true, title: tab.title ?? '', url: tab.url, lang: 'na' };
}

function isMissingReceiverError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('Could not establish connection') || message.includes('Receiving end does not exist');
}

export async function requestPageInfoFromTab(tabId: number, dependencies: PageInfoDependencies): Promise<PageInfoResponse> {
	try {
		return await dependencies.sendMessage(tabId, { action: 'GET_PAGE_INFO' });
	} catch (error) {
		if (!isMissingReceiverError(error)) {
			throw error;
		}

		try {
			await dependencies.executeScript({ target: { tabId }, files: ['content_script.js'] });
		} catch (_injectionError) {
			throw error;
		}

		return dependencies.sendMessage(tabId, { action: 'GET_PAGE_INFO' });
	}
}
