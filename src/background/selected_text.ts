import type { Article } from '../shared/types';

export interface SelectedTextInput {
	selectionText: unknown;
	title: string;
	url: string;
	pageLanguage: unknown;
}

export function normalizePageLanguage(value: unknown): string {
	if (typeof value !== 'string') {
		return 'na';
	}

	const normalized = value.trim().toLowerCase().replace('_', '-').split('-')[0];
	return normalized || 'na';
}

export function createSelectedTextArticle(input: SelectedTextInput): Article | null {
	if (typeof input.selectionText !== 'string') {
		return null;
	}

	const content = input.selectionText.replace(/\s+/g, ' ').trim();
	if (!content) {
		return null;
	}

	return {
		title: input.title || input.url,
		content,
		url: input.url,
		lang: normalizePageLanguage(input.pageLanguage),
	};
}
