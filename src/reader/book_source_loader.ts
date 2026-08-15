import { extractPdfArticleFromBytes, type PdfDocument } from '../background/pdf_extractor.ts';
import type { BookSource } from '../shared/book_source.ts';
import type { PdfErrorCode } from '../shared/constants.ts';
import { extractDocxText } from '../shared/docx_extractor.ts';
import { openEpubBook } from '../shared/epub_extractor.ts';
import { detectContentLanguage } from '../shared/language_detection.ts';
import { computeVirtualPageStarts } from '../shared/virtual_pages.ts';
import type { BookKind } from './book_loader.ts';

/** PDF extraction reports failure by return value; the reader needs it thrown like the others. */
export class PdfSourceError extends Error {
	readonly code: PdfErrorCode;

	constructor(code: PdfErrorCode) {
		super(code);
		this.name = 'PdfSourceError';
		this.code = code;
	}
}

export interface BookSourceInput {
	bytes: ArrayBuffer;
	fileName: string;
	kind: BookKind;
}

/**
 * pdf.js is passed in rather than imported here: `pdfjs_loader.ts` touches `DOMMatrix` at module
 * load, which only a browser has, and that would make this module unloadable under `node --test`.
 */
export interface BookSourceDependencies {
	loadPdfDocument(data: Uint8Array): Promise<PdfDocument>;
}

/** One chapter of already-extracted text, described by where its pages start. */
function documentSource(title: string, content: string, pageStarts: readonly number[]): BookSource {
	return {
		title,
		lang: detectContentLanguage(content, 'na'),
		chapterCount: 1,
		getChapterText: async () => content,
		pageStarts,
	};
}

export async function openBookSource(input: BookSourceInput, dependencies: BookSourceDependencies): Promise<BookSource> {
	if (input.kind === 'epub') {
		return openEpubBook(input.bytes);
	}

	if (input.kind === 'docx') {
		const document = await extractDocxText(input.bytes, input.fileName);
		return documentSource(document.title, document.content, computeVirtualPageStarts(document.content));
	}

	const extraction = await extractPdfArticleFromBytes(new Uint8Array(input.bytes), input.fileName, {
		loadDocument: dependencies.loadPdfDocument,
	});
	if (!extraction.success) {
		throw new PdfSourceError(extraction.error);
	}
	return documentSource(extraction.article.title, extraction.article.content, extraction.pageStarts);
}
