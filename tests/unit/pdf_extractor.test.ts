import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPdfArticle, isSupportedPdfSource, type PdfExtractorDependencies } from '../../src/background/pdf_extractor.ts';
import { PDF_ERROR_CODES } from '../../src/shared/constants.ts';

const source = { url: 'https://example.com/reports/q2.pdf', title: 'Q2 report' };
const pdfBytes = new TextEncoder().encode('%PDF-1.7\nfixture').buffer as ArrayBuffer;

function dependencies(overrides: Partial<PdfExtractorDependencies> = {}): PdfExtractorDependencies {
	return {
		fetchPdf: async () => ({
			ok: true,
			headers: new Headers({ 'content-type': 'application/pdf' }),
			arrayBuffer: async () => pdfBytes,
		}),
		isFileSchemeAccessAllowed: async () => true,
		loadDocument: async () => ({
			numPages: 2,
			getMetadata: async () => ({ info: { Title: 'Quarterly report' } }),
			getPage: async (pageNumber) => ({
				getTextContent: async () => ({
					items: [{ str: pageNumber === 1 ? 'First page.' : 'Second page.', hasEOL: true }],
				}),
			}),
			destroy: async () => undefined,
		}),
		...overrides,
	};
}

test('accepts only HTTPS and file PDF sources', () => {
	assert.equal(isSupportedPdfSource('https://example.com/report.pdf'), true);
	assert.equal(isSupportedPdfSource('file:///Users/me/report.pdf'), true);
	assert.equal(isSupportedPdfSource('http://example.com/report.pdf'), false);
	assert.equal(isSupportedPdfSource('chrome-extension://viewer/index.html'), false);
});

test('creates an Article from page-ordered PDF text and metadata title', async () => {
	assert.deepEqual(await extractPdfArticle(source, dependencies()), {
		success: true,
		readableSurface: 'document-reader',
		article: {
			title: 'Quarterly report',
			content: 'First page.\n\nSecond page.',
			url: source.url,
			lang: 'na',
		},
	});
});

test('keeps a display heading separate while joining its body line-wraps', async () => {
	const layoutDocument = dependencies({
		loadDocument: async () => ({
			numPages: 1,
			getMetadata: async () => ({ info: { Title: 'System Card' } }),
			getPage: async () => ({
				getTextContent: async () => ({
					items: [
						{ str: 'Executive Summary', transform: [1, 0, 0, 16, 50, 701.6], width: 150, height: 16 },
						{ str: 'This system card describes Claude Opus 5.', transform: [1, 0, 0, 11, 50, 675.33], width: 250, height: 11 },
						{
							str: 'It is an upgrade with gains in agentic coding,',
							transform: [1, 0, 0, 11, 50, 659.14],
							width: 250,
							height: 11,
						},
						{
							str: 'computer use, and long-horizon knowledge work.',
							transform: [1, 0, 0, 11, 50, 642.95],
							width: 250,
							height: 11,
						},
					],
				}),
			}),
			destroy: async () => undefined,
		}),
	});

	const result = await extractPdfArticle(source, layoutDocument);
	assert.equal(
		result.success && result.article.content,
		'Executive Summary\n\nThis system card describes Claude Opus 5. It is an upgrade with gains in agentic coding, computer use, and long-horizon knowledge work.',
	);
});

test('tags Vietnamese PDF text as vi, since a PDF declares no language of its own', async () => {
	const vietnamese = dependencies({
		loadDocument: async () => ({
			numPages: 1,
			getMetadata: async () => ({ info: { Title: 'Báo cáo' } }),
			getPage: async () => ({
				getTextContent: async () => ({
					items: [{ str: 'Chia tay không chỉ là buồn trong lòng, mà còn là một cú sốc mạnh với não bộ và cơ thể.' }],
				}),
			}),
			destroy: async () => undefined,
		}),
	});

	const result = await extractPdfArticle(source, vietnamese);
	assert.equal(result.success && result.article.lang, 'vi');
});

test('uses tab title and filename fallbacks, recognizes PDF signatures, and ignores non-PDF fallbacks', async () => {
	const noMetadata = dependencies({
		fetchPdf: async () => ({
			ok: true,
			headers: new Headers({ 'content-type': 'application/octet-stream' }),
			arrayBuffer: async () => pdfBytes,
		}),
		loadDocument: async () => ({
			numPages: 1,
			getMetadata: async () => ({ info: {} }),
			getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Body' }] }) }),
			destroy: async () => undefined,
		}),
	});
	assert.deepEqual(await extractPdfArticle({ ...source, title: 'Tab title' }, noMetadata), {
		success: true,
		readableSurface: 'document-reader',
		article: { title: 'Tab title', content: 'Body', url: source.url, lang: 'na' },
	});
	assert.equal(
		await extractPdfArticle(
			source,
			dependencies({
				fetchPdf: async () => ({
					ok: true,
					headers: new Headers({ 'content-type': 'text/html' }),
					arrayBuffer: async () => new TextEncoder().encode('<main/>').buffer,
				}),
			}),
		),
		null,
	);
});

test('returns the local-file permission error before fetching', async () => {
	let fetches = 0;
	const result = await extractPdfArticle(
		{ url: 'file:///Users/me/report.pdf', title: 'report.pdf' },
		dependencies({
			isFileSchemeAccessAllowed: async () => false,
			fetchPdf: async () => {
				fetches++;
				throw new Error('must not fetch');
			},
		}),
	);
	assert.deepEqual(result, { success: false, error: PDF_ERROR_CODES.fileAccessRequired });
	assert.equal(fetches, 0);
});

test('maps password, textless, HTTP, and parser failures without exposing PDF content', async () => {
	const password = await extractPdfArticle(
		source,
		dependencies({
			loadDocument: async () => Promise.reject(Object.assign(new Error('secret'), { name: 'PasswordException' })),
		}),
	);
	assert.deepEqual(password, { success: false, error: PDF_ERROR_CODES.passwordProtected });
	const textless = await extractPdfArticle(
		source,
		dependencies({
			loadDocument: async () => ({
				numPages: 1,
				getMetadata: async () => ({ info: {} }),
				getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
				destroy: async () => undefined,
			}),
		}),
	);
	assert.deepEqual(textless, { success: false, error: PDF_ERROR_CODES.textUnavailable });
	const http = await extractPdfArticle(
		source,
		dependencies({ fetchPdf: async () => ({ ok: false, headers: new Headers(), arrayBuffer: async () => pdfBytes }) }),
	);
	assert.deepEqual(http, { success: false, error: PDF_ERROR_CODES.extractionFailed });
	const malformed = await extractPdfArticle(
		source,
		dependencies({ loadDocument: async () => Promise.reject(new Error('broken parser state')) }),
	);
	assert.deepEqual(malformed, { success: false, error: PDF_ERROR_CODES.extractionFailed });
});
