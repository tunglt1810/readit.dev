import JSZip from 'jszip';

import { DOCX_ERROR_CODES, type DocxErrorCode } from './constants.ts';
import { normalizeChapterText } from './epub_extractor.ts';

const DOCUMENT_PATH = 'word/document.xml';
const CORE_PROPERTIES_PATH = 'docProps/core.xml';

export class DocxError extends Error {
	readonly code: DocxErrorCode;

	constructor(code: DocxErrorCode) {
		super(code);
		this.name = 'DocxError';
		this.code = code;
	}
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(value: string): string {
	return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu, (match, entity: string) => {
		if (entity.startsWith('#x')) {
			return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
		}
		if (entity.startsWith('#')) {
			return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
		}
		return XML_ENTITIES[entity] ?? match;
	});
}

/**
 * A paragraph's spoken text is the concatenation of its `w:t` runs, with tabs and soft breaks
 * standing in for a space. Everything else in the run properties — fonts, colours, bookmarks —
 * carries no text and is skipped.
 */
function paragraphText(paragraphXml: string): string {
	let text = '';
	const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/gu;
	for (const match of paragraphXml.matchAll(token)) {
		text += match[1] === undefined ? ' ' : decodeXmlText(match[1]);
	}
	return text;
}

/**
 * Only `w:body` is read. Headers, footers, footnotes and comments live in their own parts of the
 * archive, so leaving those files unopened is what keeps them out of the spoken text.
 */
function readBodyParagraphs(documentXml: string): string[] {
	const body = /<w:body(?:\s[^>]*)?>([\s\S]*)<\/w:body>/u.exec(documentXml)?.[1] ?? '';
	// Table cells hold `w:p` elements too, so table text is picked up here in document order.
	return Array.from(body.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/gu), (match) =>
		match[1] === undefined ? '' : paragraphText(match[1]),
	);
}

function coreTitle(coreXml: string | undefined): string | undefined {
	const title = coreXml ? /<dc:title(?:\s[^>]*)?>([\s\S]*?)<\/dc:title>/u.exec(coreXml)?.[1] : undefined;
	const decoded = title ? decodeXmlText(title).trim() : '';
	return decoded ? decoded : undefined;
}

/**
 * The language is deliberately not reported: a `.docx` declares `w:lang` per run, and those
 * declarations describe the spell-checker's opinion rather than the document's. The caller detects
 * it from the extracted text instead, as the PDF path does.
 */
export async function extractDocxText(bytes: ArrayBuffer, fallbackTitle: string): Promise<{ title: string; content: string }> {
	let archive: JSZip;
	try {
		archive = await JSZip.loadAsync(bytes);
	} catch {
		throw new DocxError(DOCX_ERROR_CODES.parseFailed);
	}

	const documentXml = await archive.file(DOCUMENT_PATH)?.async('string');
	if (!documentXml) {
		throw new DocxError(DOCX_ERROR_CODES.parseFailed);
	}

	const content = normalizeChapterText(readBodyParagraphs(documentXml));
	if (!content) {
		throw new DocxError(DOCX_ERROR_CODES.textUnavailable);
	}

	return {
		title: coreTitle(await archive.file(CORE_PROPERTIES_PATH)?.async('string')) ?? fallbackTitle,
		content,
	};
}
