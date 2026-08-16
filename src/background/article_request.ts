/** What the caller of `requestCurrentTabArticle` sees: the docx variant has already been resolved. */
export type ResolvedArticleResponse = { success: true; article: unknown; readableSurface: unknown } | { success: false; error?: string };

/** What the content script may put on the wire, including raw Word Online bytes awaiting parsing. */
export type ArticleResponse =
	| ResolvedArticleResponse
	| {
			success: true;
			docxBase64: string;
			source: { url: string; title: string; lang: string };
			readableSurface: unknown;
	  };

export interface ArticleRequestDependencies {
	sendMessage: (tabId: number, message: { action: 'EXTRACT_ARTICLE' }) => Promise<ArticleResponse>;
	executeScript: (options: { target: { tabId: number }; files: string[] }) => Promise<unknown>;
}

export function isMissingReceiverError(error: unknown): boolean {
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
