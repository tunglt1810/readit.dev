import { bytesToBase64 } from '../shared/base64.ts';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../shared/constants.ts';
import type { Article } from '../shared/types.ts';

const DOCUMENT_PATH = /^(.*)\/_layouts\/15\/doc2?\.aspx$/i;
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Personal OneDrive now runs on the SharePoint Online stack while keeping its own origin, so one
 * shape covers both hosts. The site path is read from the URL rather than hardcoded, which is what
 * lets `/personal/<cid>`, `/sites/<name>` and `/personal/<user>_tenant_com` share this adapter.
 */
export function parseWordOnlineDocument(url: string): { sitePath: string; documentId: string } | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') {
			return null;
		}
		if (parsed.hostname !== 'onedrive.live.com' && !parsed.hostname.endsWith('.sharepoint.com')) {
			return null;
		}
		const sitePath = DOCUMENT_PATH.exec(parsed.pathname)?.[1];
		if (sitePath === undefined) {
			return null;
		}
		// The same page is reached under two parameter names: `sourcedoc` when opened from a share
		// link, `resid` when opened from the OneDrive file list. Both carry the same GUID.
		const documentId = (parsed.searchParams.get('sourcedoc') ?? parsed.searchParams.get('resid') ?? '').replace(/[{}]/g, '');
		return DOCUMENT_ID.test(documentId) ? { sitePath, documentId } : null;
	} catch {
		return null;
	}
}

export type WordOnlineFetch = (
	url: string,
	init?: { credentials?: 'same-origin'; signal?: AbortSignal },
) => Promise<Pick<Response, 'ok' | 'headers' | 'arrayBuffer'>>;

export type WordOnlineExtractionResponse =
	| {
			success: true;
			docxBase64: string;
			source: Pick<Article, 'url' | 'title' | 'lang'>;
			readableSurface: 'document-reader';
	  }
	| { success: false; error: typeof WORD_ONLINE_DOWNLOAD_UNAVAILABLE };

const DOWNLOAD_FETCH_TIMEOUT_MS = 15000;
const MAX_DOCX_BYTES = 25 * 1024 * 1024;
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

export async function fetchWithTimeout(
	fetcher: WordOnlineFetch,
	url: string,
	timeoutMs: number,
): Promise<Pick<Response, 'ok' | 'headers' | 'arrayBuffer'>> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetcher(url, { credentials: 'same-origin', signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Content type is not trusted: `download.aspx` returns the Word MIME type, the REST fallback returns
 * `application/octet-stream`, and an expired session returns an HTML sign-in page. The ZIP signature
 * is the check that actually separates a document from an error page.
 */
function hasZipSignature(bytes: Uint8Array): boolean {
	return ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export async function extractWordOnlineDocx(
	input: Pick<Article, 'url' | 'title' | 'lang'>,
	fetcher: WordOnlineFetch,
): Promise<WordOnlineExtractionResponse | null> {
	const target = parseWordOnlineDocument(input.url);
	if (!target) {
		return null;
	}

	try {
		const downloadUrl = new URL(
			`${target.sitePath}/_layouts/15/download.aspx?UniqueId=${encodeURIComponent(target.documentId)}`,
			new URL(input.url).origin,
		).href;
		const response = await fetchWithTimeout(fetcher, downloadUrl, DOWNLOAD_FETCH_TIMEOUT_MS);
		// A missing content-length yields Number('') === 0, which falls through to the byteLength
		// check below, so an absent header cannot bypass the ceiling.
		const declaredLength = Number(response.headers.get('content-length') ?? '');
		if (!response.ok || declaredLength > MAX_DOCX_BYTES) {
			return { success: false, error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE };
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length === 0 || bytes.length > MAX_DOCX_BYTES || !hasZipSignature(bytes)) {
			return { success: false, error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE };
		}

		return {
			success: true,
			docxBase64: bytesToBase64(bytes),
			source: input,
			readableSurface: 'document-reader',
		};
	} catch {
		return { success: false, error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE };
	}
}
