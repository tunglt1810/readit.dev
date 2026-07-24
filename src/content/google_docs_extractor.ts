import { GOOGLE_DOCS_EXPORT_UNAVAILABLE } from '../shared/constants.ts';
import type { Article } from '../shared/types.ts';

export type GoogleDocsFetch = (
	url: string,
	init?: { credentials?: 'same-origin'; signal?: AbortSignal },
) => Promise<Pick<Response, 'ok' | 'headers' | 'text'>>;

export type GoogleDocsExtractionResponse =
	| { success: true; article: Article }
	| { success: false; error: typeof GOOGLE_DOCS_EXPORT_UNAVAILABLE };

const EXPORT_FETCH_TIMEOUT_MS = 15000;

export async function fetchWithTimeout(
	fetcher: GoogleDocsFetch,
	url: string,
	timeoutMs: number,
): Promise<Pick<Response, 'ok' | 'headers' | 'text'>> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetcher(url, { credentials: 'same-origin', signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}

export function parseGoogleDocsDocumentId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') {
			return null;
		}
		return parsed.pathname.match(/^\/document\/d\/([^/]+)(?:\/|$)/)?.[1] ?? null;
	} catch {
		return null;
	}
}

export async function extractGoogleDocsArticle(
	input: Pick<Article, 'url' | 'title' | 'lang'>,
	fetcher: GoogleDocsFetch,
): Promise<GoogleDocsExtractionResponse | null> {
	const documentId = parseGoogleDocsDocumentId(input.url);
	if (!documentId) {
		return null;
	}

	try {
		const exportUrl = new URL('/document/d/' + encodeURIComponent(documentId) + '/export?format=txt', new URL(input.url).origin).href;
		const response = await fetchWithTimeout(fetcher, exportUrl, EXPORT_FETCH_TIMEOUT_MS);
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
		const content = (await response.text()).replace(/\r\n?/g, '\n').trim();

		if (!response.ok || !contentType.startsWith('text/plain') || !content) {
			return { success: false, error: GOOGLE_DOCS_EXPORT_UNAVAILABLE };
		}

		return { success: true, article: { ...input, content } };
	} catch {
		return { success: false, error: GOOGLE_DOCS_EXPORT_UNAVAILABLE };
	}
}
