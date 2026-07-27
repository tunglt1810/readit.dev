import { PDF_ERROR_CODES, type PdfErrorCode } from '../shared/constants.ts';
import { detectContentLanguage } from '../shared/language_detection.ts';
import type { Article } from '../shared/types.ts';

const PDF_FETCH_TIMEOUT_MS = 30_000;

interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
	transform?: number[];
	width?: number;
	height?: number;
}

export interface PdfDocument {
	numPages: number;
	getMetadata(): Promise<{ info?: { Title?: unknown } }>;
	getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
	destroy(): Promise<void>;
}

export interface PdfExtractorDependencies {
	fetchPdf(url: string, init: RequestInit): Promise<Pick<Response, 'ok' | 'headers' | 'arrayBuffer'>>;
	isFileSchemeAccessAllowed(): Promise<boolean>;
	loadDocument(data: Uint8Array): Promise<PdfDocument>;
}

export type PdfArticleResponse =
	| { success: true; article: Article }
	| { success: false; error: PdfErrorCode };

export interface PdfSource {
	url: string;
	title: string;
}

export function isSupportedPdfSource(url: string): boolean {
	try {
		const source = new URL(url);
		return source.protocol === 'https:' || source.protocol === 'file:';
	} catch {
		return false;
	}
}

function isPdfResponse(headers: Headers, bytes: Uint8Array): boolean {
	return headers.get('content-type')?.toLowerCase().includes('application/pdf') === true ||
		(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d);
}

function normalizeText(text: string): string {
	return text
		.replace(/[\t ]+\n/g, '\n')
		.replace(/\n[\t ]+/g, '\n')
		.replace(/[\t ]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function hasLayout(item: PdfTextItem): item is PdfTextItem & { transform: number[]; height: number } {
	return Array.isArray(item.transform) && item.transform.length >= 6 && item.transform.every((value) => typeof value === 'number') && typeof item.height === 'number';
}

function joinLine(items: (PdfTextItem & { transform: number[]; height: number })[]): string {
	let text = '';
	let previous: (PdfTextItem & { transform: number[]; height: number }) | undefined;
	for (const item of items) {
		const horizontalGap = previous ? item.transform[4] - (previous.transform[4] + (previous.width ?? 0)) : 0;
		const needsSpace = previous && !/\s$/u.test(text) && !/^\s/u.test(item.str ?? '') && horizontalGap > 0.5;
		text += `${needsSpace ? ' ' : ''}${item.str}`;
		previous = item;
	}
	return text;
}

function normalizeLayoutText(items: (PdfTextItem & { transform: number[]; height: number })[]): string {
	const lines: { y: number; height: number; items: (PdfTextItem & { transform: number[]; height: number })[] }[] = [];
	for (const item of items) {
		const y = item.transform[5];
		const line = lines.at(-1);
		if (!line || Math.abs(line.y - y) > 0.5) {
			lines.push({ y, height: item.height, items: [item] });
		} else {
			line.height = Math.max(line.height, item.height);
			line.items.push(item);
		}
	}

	let text = '';
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const nextLine = lines[index + 1];
		text += joinLine(line.items);
		if (!nextLine) continue;
		const verticalGap = Math.abs(line.y - nextLine.y);
		const headingBoundary = line.height >= nextLine.height * 1.25 && verticalGap >= nextLine.height * 1.25;
		const paragraphGap = verticalGap >= Math.max(line.height, nextLine.height) * 1.75;
		text += headingBoundary || paragraphGap ? '\n\n' : ' ';
	}
	return normalizeText(text);
}

function normalizePageText(items: PdfTextItem[]): string {
	const textItems = items.filter((item): item is PdfTextItem & { str: string } => Boolean(item.str));
	const layoutItems = textItems.filter(
		(item): item is PdfTextItem & { str: string; transform: number[]; height: number } => hasLayout(item),
	);
	if (textItems.length > 0 && layoutItems.length === textItems.length) {
		return normalizeLayoutText(layoutItems);
	}

	let text = '';
	for (const item of textItems) {
		text += item.str;
		if (item.hasEOL) text += '\n';
	}
	return normalizeText(text);
}

function fallbackTitle(source: PdfSource): string {
	if (source.title.trim()) return source.title.trim();
	try {
		const filename = new URL(source.url).pathname.split('/').filter(Boolean).pop();
		if (filename) return decodeURIComponent(filename);
	} catch {
		// The source URL was validated before extraction.
	}
	return source.url;
}

function documentTitle(metadata: { info?: { Title?: unknown } }, source: PdfSource): string {
	const title = metadata.info?.Title;
	return typeof title === 'string' && title.trim() ? title.trim() : fallbackTitle(source);
}

function extractionFailure(error: PdfErrorCode): PdfArticleResponse {
	return { success: false, error };
}

export async function extractPdfArticle(
	source: PdfSource,
	dependencies: PdfExtractorDependencies,
): Promise<PdfArticleResponse | null> {
	if (!isSupportedPdfSource(source.url)) return null;
	if (new URL(source.url).protocol === 'file:' && !(await dependencies.isFileSchemeAccessAllowed())) {
		return extractionFailure(PDF_ERROR_CODES.fileAccessRequired);
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);
	let response: Pick<Response, 'ok' | 'headers' | 'arrayBuffer'>;
	try {
		response = await dependencies.fetchPdf(source.url, { credentials: 'include', signal: controller.signal });
	} catch {
		return extractionFailure(PDF_ERROR_CODES.extractionFailed);
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) return extractionFailure(PDF_ERROR_CODES.extractionFailed);

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await response.arrayBuffer());
	} catch {
		return extractionFailure(PDF_ERROR_CODES.extractionFailed);
	}
	if (!isPdfResponse(response.headers, bytes)) return null;

	let document: PdfDocument | undefined;
	try {
		document = await dependencies.loadDocument(bytes);
		const metadata = await document.getMetadata();
		const pages: string[] = [];
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			const page = await document.getPage(pageNumber);
			const text = normalizePageText((await page.getTextContent()).items);
			if (text) pages.push(text);
		}
		const content = pages.join('\n\n');
		if (!content) return extractionFailure(PDF_ERROR_CODES.textUnavailable);
		return {
			success: true,
			article: {
				title: documentTitle(metadata, source),
				content,
				url: source.url,
				lang: detectContentLanguage(content, 'na'),
			},
		};
	} catch (error) {
		return extractionFailure(error instanceof Error && error.name === 'PasswordException' ? PDF_ERROR_CODES.passwordProtected : PDF_ERROR_CODES.extractionFailed);
	} finally {
		if (document) await document.destroy();
	}
}
