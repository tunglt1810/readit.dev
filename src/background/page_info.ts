import type { PageInfoResponse } from '../shared/types.ts';

export interface PageInfoDependencies {
	sendMessage(tabId: number, message: { action: 'GET_PAGE_INFO' }): Promise<PageInfoResponse>;
	executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
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
