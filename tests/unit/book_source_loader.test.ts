import JSZip from 'jszip';

import assert from 'node:assert/strict';
import test from 'node:test';
import { openBookSource, PdfSourceError } from '../../src/reader/book_source_loader.ts';
import { PDF_ERROR_CODES } from '../../src/shared/constants.ts';

const NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function docxBytes(paragraphs: string[]): Promise<ArrayBuffer> {
	const archive = new JSZip();
	const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
	archive.file('word/document.xml', `<?xml version="1.0"?><w:document ${NAMESPACE}><w:body>${body}</w:body></w:document>`);
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/** pdf.js is never reached by the DOCX cases, but the dependency is required. */
const deps = {
	loadPdfDocument: async () => {
		throw new Error('pdf.js must not be loaded for this format');
	},
};

/** A stand-in for pdf.js: one text item per page, no layout information. */
function fakePdf(pages: string[]) {
	return async () => ({
		numPages: pages.length,
		getMetadata: async () => ({}),
		getPage: async (pageNumber: number) => ({
			getTextContent: async () => ({ items: [{ str: pages[pageNumber - 1] }] }),
		}),
		destroy: async () => undefined,
	});
}

test('a DOCX becomes a one-chapter source with virtual pages', async () => {
	const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${'x'.repeat(200)}`);
	const source = await openBookSource({ bytes: await docxBytes(paragraphs), fileName: 'Report.docx', kind: 'docx' }, deps);

	assert.equal(source.chapterCount, 1);
	assert.equal(source.title, 'Report.docx');
	assert.equal((source.pageStarts?.length ?? 0) > 1, true);
	assert.equal(source.pageStarts?.[0], 0);
	assert.equal((await source.getChapterText(0)).startsWith('Paragraph 0'), true);
});

test('a DOCX gets a language detected from its text', async () => {
	const source = await openBookSource(
		{
			bytes: await docxBytes(['Đây là một tài liệu tiếng Việt dùng để kiểm tra nhận diện ngôn ngữ.']),
			fileName: 'Tài liệu.docx',
			kind: 'docx',
		},
		deps,
	);
	assert.equal(source.lang, 'vi');
});

test('a PDF becomes a one-chapter source whose pages come from the document', async () => {
	const source = await openBookSource(
		{ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, fileName: 'Report.pdf', kind: 'pdf' },
		{ loadPdfDocument: fakePdf(['First page text.', 'Second page text.']) },
	);

	assert.equal(source.chapterCount, 1);
	assert.deepEqual(source.pageStarts, [0, 18]);
	assert.equal(await source.getChapterText(0), 'First page text.\n\nSecond page text.');
});

test('a PDF with no extractable text raises the PDF error the reader shows', async () => {
	await assert.rejects(
		() =>
			openBookSource(
				{ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, fileName: 'Scan.pdf', kind: 'pdf' },
				{ loadPdfDocument: fakePdf(['']) },
			),
		(error: unknown) => error instanceof PdfSourceError && error.code === PDF_ERROR_CODES.textUnavailable,
	);
});
