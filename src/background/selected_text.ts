import { detectContentLanguage } from '../shared/language_detection.ts';
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

	// Collapse horizontal whitespace per line but keep the line breaks: they are the only paragraph
	// signal the offscreen normalizer has, and flattening them merges neighbouring paragraphs into
	// one run-on sentence that then loses its sentence-terminal pauses.
	const content = input.selectionText
		.replace(/\r\n?/gu, '\n')
		.split('\n')
		.map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
		.join('\n')
		.trim();
	if (!content) {
		return null;
	}

	return {
		title: input.title || input.url,
		content,
		url: input.url,
		// A page's declared language is weak evidence about the passage the reader selected, and on the
		// context-menu path it is often missing entirely: that language comes from a
		// `chrome.scripting.executeScript` that fails silently on any page the extension cannot inject
		// into. Falling through to `na` there costs Vietnamese text its whole normalization pass, since
		// `preparePlaybackUnits` selects the Vietnamese path from this field alone.
		lang: detectContentLanguage(content, normalizePageLanguage(input.pageLanguage)),
	};
}
