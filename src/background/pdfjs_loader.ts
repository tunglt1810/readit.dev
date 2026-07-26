import { getDocument } from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.mjs';
import type { PdfDocument } from './pdf_extractor.ts';

export async function loadPdfJsDocument(data: Uint8Array): Promise<PdfDocument> {
	const loadingTask = getDocument({ data });
	const document = await loadingTask.promise;
	return {
		numPages: document.numPages,
		getMetadata: document.getMetadata.bind(document),
		getPage: document.getPage.bind(document),
		destroy: () => loadingTask.destroy(),
	} as unknown as PdfDocument;
}
