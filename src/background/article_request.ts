export interface ArticleResponse {
	success: boolean;
	error?: string;
	article?: unknown;
}

export interface ArticleRequestDependencies {
	sendMessage: (tabId: number, message: { action: 'EXTRACT_ARTICLE' }) => Promise<ArticleResponse>;
	executeScript: (options: { target: { tabId: number }; files: string[] }) => Promise<unknown>;
}

function isMissingReceiverError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('Could not establish connection') || message.includes('Receiving end does not exist');
}

export async function requestArticleFromTab(tabId: number, dependencies: ArticleRequestDependencies): Promise<ArticleResponse> {
	try {
		return await dependencies.sendMessage(tabId, { action: 'EXTRACT_ARTICLE' });
	} catch (error) {
		if (!isMissingReceiverError(error)) {
			throw error;
		}

		try {
			await dependencies.executeScript({ target: { tabId }, files: ['content_script.js'] });
		} catch (_injectionError) {
			throw error;
		}

		return dependencies.sendMessage(tabId, { action: 'EXTRACT_ARTICLE' });
	}
}
