import type { Article } from '../shared/types.ts';
import { createSelectedTextArticle } from './selected_text.ts';

export interface SelectedTextMessageInput {
	selectionText: unknown;
	pageLanguage: unknown;
}

export interface SelectedTextSenderInput {
	frameId: unknown;
	tabId: unknown;
	windowId: unknown;
	title: unknown;
	url: unknown;
}

export interface PreparedSelectedTextRequest {
	tabId: number;
	windowId: number;
	title: string;
	url: string;
	article: Article;
}

export function prepareSelectedTextRequest(
	message: SelectedTextMessageInput,
	sender: SelectedTextSenderInput,
): PreparedSelectedTextRequest | null {
	if (sender.frameId !== 0 || !Number.isInteger(sender.tabId) || !Number.isInteger(sender.windowId)) {
		return null;
	}
	if (typeof sender.url !== 'string') {
		return null;
	}
	let protocol: string;
	try {
		protocol = new URL(sender.url).protocol;
	} catch (_error) {
		return null;
	}
	if (protocol !== 'http:' && protocol !== 'https:') {
		return null;
	}
	const title = typeof sender.title === 'string' ? sender.title : sender.url;
	const article = createSelectedTextArticle({
		selectionText: message.selectionText,
		pageLanguage: message.pageLanguage,
		title,
		url: sender.url,
	});
	if (!article) {
		return null;
	}
	return {
		tabId: sender.tabId as number,
		windowId: sender.windowId as number,
		title,
		url: sender.url,
		article,
	};
}
