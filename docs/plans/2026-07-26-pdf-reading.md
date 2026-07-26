# PDF Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a text-layer PDF in the active HTTPS or `file://` Chrome tab through the existing readit.dev playback pipeline.

**Architecture:** Keep Chrome's PDF Viewer unchanged. After the existing content-script extraction cannot reach a PDF Viewer, the background invokes a narrowly scoped PDF adapter that fetches the active-tab source once, parses it locally with bundled PDF.js, and returns the existing `Article` contract to `startPlayback()`. Stable PDF errors flow through the existing Popup and Side Panel localization seam.

**Tech Stack:** TypeScript 6, Chrome Manifest V3 service worker, `pdfjs-dist@6.1.200`, Rsbuild 2, Node test runner, Playwright.

## Global Constraints

- Support only active-tab `https:` and `file:` PDF URLs with a text layer.
- Keep `minimum_chrome_version` at `127`; do not use Chrome 151's MIME handler API or replace Chrome's PDF Viewer.
- Use the existing `activeTab` permission only; do not add `host_permissions`, OAuth, a backend, telemetry, or storage for PDF bytes/text.
- Before a `file://` fetch, require `chrome.extension.isAllowedFileSchemeAccess()` and return a localized error when it is false.
- Do not support password prompts, reuse Chrome PDF Viewer unlock state, OCR, scanned PDFs, PDF word highlighting, PDF selection reading, annotations, downloads, or a PDF UI.
- Send a source-origin fetch only after the user presses **Read current page**. Do not log response bodies, PDF bytes, metadata, extracted text, or document URLs.
- Use a 30-second abortable fetch. Return `pdfExtractionFailed` for timeout, HTTP, malformed-PDF, and other parser/fetch failures.
- Keep manual playback untouched until PDF extraction succeeds; a PDF failure must not call `preemptManualForWeb()` or replace its manual session.
- Preserve standard Readability and Google Docs behavior by attempting the existing content-script request first.
- Use `CI=true` for pnpm commands, run verification sequentially, and keep all runtime scratch data under this worktree's `.tmp/` directory.
- After implementation, run `rtk graphify update .` from this worktree.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/constants.ts` | Defines stable PDF error-code values and both EN/VI messages. |
| `src/shared/i18n.ts` | Maps shared PDF and Google Docs error codes to translation keys without changing Popup or Side Panel call sites. |
| `tests/unit/pdf_playback_error.test.ts` | Locks the code-to-translation-key contract and both localized strings. |
| `package.json`, `pnpm-lock.yaml` | Pin PDF.js as a production dependency. |
| `rsbuild.config.ts` | Copies PDF.js's worker to a stable extension-owned asset path. |
| `src/background/pdf_extractor.ts` | Owns fetch validation, PDF.js parsing, text normalization, metadata title fallback, and PDF-specific failures. |
| `tests/unit/pdf_extractor.test.ts` | Tests the adapter through injected fetch, permission, and PDF-loader dependencies without network or Chrome. |
| `src/background/article_request.ts` | Exposes the existing missing-content-script classification to the background coordinator. |
| `src/background/background.ts` | Calls the PDF adapter only for the unavailable-receiver fallback, then uses the existing `startPlayback()` path. |
| `tests/e2e/pdf-reading.spec.ts` | Exercises a routed real PDF through the coordinator and verifies Popup/Side Panel error rendering. |

## Task 1: Define the PDF Error Contract and Localize It

**Files:**
- Create: `tests/unit/pdf_playback_error.test.ts`
- Modify: `src/shared/constants.ts:1-4, 43-171`
- Modify: `src/shared/i18n.ts:1-9`

**Interfaces:**
- Produces: `PDF_ERROR_CODES` with the literal values `pdfFileAccessRequired`, `pdfPasswordProtected`, `pdfTextUnavailable`, and `pdfExtractionFailed`.
- Produces: `PdfErrorCode`, the union of `PDF_ERROR_CODES` values.
- Produces: `getPlaybackErrorTranslationKey(error: string | undefined): keyof typeof THEME_TRANSLATIONS.en | undefined`.
- Consumes later: `getLocalizedPlaybackError(error)` remains the sole UI-facing mapper used by Popup and Side Panel.

- [ ] **Step 1: Write the failing error-contract test**

Create `tests/unit/pdf_playback_error.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { PDF_ERROR_CODES, THEME_TRANSLATIONS } from '../../src/shared/constants.ts';

Object.defineProperty(globalThis, 'chrome', {
	configurable: true,
	value: { i18n: { getUILanguage: () => 'en-US' } },
});

const { getPlaybackErrorTranslationKey } = await import('../../src/shared/i18n.ts');

const expected = [
	[PDF_ERROR_CODES.fileAccessRequired, 'pdfFileAccessRequired', 'Để đọc file PDF trên máy, hãy bật “Cho phép truy cập URL tệp” trong trang chi tiết tiện ích của Chrome.', 'To read local PDF files, enable “Allow access to file URLs” in the extension details page in Chrome.'],
	[PDF_ERROR_CODES.passwordProtected, 'pdfPasswordProtected', 'PDF này được bảo vệ bằng mật khẩu và chưa được hỗ trợ.', 'This password-protected PDF is not currently supported.'],
	[PDF_ERROR_CODES.textUnavailable, 'pdfTextUnavailable', 'Không tìm thấy văn bản có thể đọc trong PDF này. PDF scan chưa được hỗ trợ.', 'No readable text was found in this PDF. Scanned PDFs are not supported.'],
	[PDF_ERROR_CODES.extractionFailed, 'pdfExtractionFailed', 'Không thể đọc PDF này. Hãy thử lại hoặc dán văn bản để đọc.', 'Unable to read this PDF. Try again or paste its text to read.'],
] as const;

test('maps every PDF extraction error to an existing EN and VI translation', () => {
	for (const [code, key, vi, en] of expected) {
		assert.equal(getPlaybackErrorTranslationKey(code), key);
		assert.equal(THEME_TRANSLATIONS.vi[key], vi);
		assert.equal(THEME_TRANSLATIONS.en[key], en);
	}
	assert.equal(getPlaybackErrorTranslationKey('unknownPdfError'), undefined);
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
rtk env CI=true node --experimental-strip-types --test tests/unit/pdf_playback_error.test.ts
```

Expected: FAIL because `PDF_ERROR_CODES` and `getPlaybackErrorTranslationKey` do not exist.

- [ ] **Step 3: Add the stable codes, translations, and mapper**

At the top of `src/shared/constants.ts`, add the exact code contract:

```ts
export const PDF_ERROR_CODES = {
	fileAccessRequired: 'pdfFileAccessRequired',
	passwordProtected: 'pdfPasswordProtected',
	textUnavailable: 'pdfTextUnavailable',
	extractionFailed: 'pdfExtractionFailed',
} as const;

export type PdfErrorCode = (typeof PDF_ERROR_CODES)[keyof typeof PDF_ERROR_CODES];
```

Add these keys beside `googleDocsExportUnavailable` in **both** translation objects:

```ts
pdfFileAccessRequired: 'Để đọc file PDF trên máy, hãy bật “Cho phép truy cập URL tệp” trong trang chi tiết tiện ích của Chrome.',
pdfPasswordProtected: 'PDF này được bảo vệ bằng mật khẩu và chưa được hỗ trợ.',
pdfTextUnavailable: 'Không tìm thấy văn bản có thể đọc trong PDF này. PDF scan chưa được hỗ trợ.',
pdfExtractionFailed: 'Không thể đọc PDF này. Hãy thử lại hoặc dán văn bản để đọc.',
```

```ts
pdfFileAccessRequired: 'To read local PDF files, enable “Allow access to file URLs” in the extension details page in Chrome.',
pdfPasswordProtected: 'This password-protected PDF is not currently supported.',
pdfTextUnavailable: 'No readable text was found in this PDF. Scanned PDFs are not supported.',
pdfExtractionFailed: 'Unable to read this PDF. Try again or paste its text to read.',
```

Replace `src/shared/i18n.ts` with this mapping shape, retaining the existing `uiLang` and `t` exports:

```ts
import { GOOGLE_DOCS_EXPORT_UNAVAILABLE, PDF_ERROR_CODES, THEME_TRANSLATIONS } from './constants.ts';

export type UiLanguage = keyof typeof THEME_TRANSLATIONS;
export const uiLang: UiLanguage = chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en';
export const t = (key: keyof typeof THEME_TRANSLATIONS.en): string => THEME_TRANSLATIONS[uiLang][key];

const playbackErrorTranslationKeys = {
	[GOOGLE_DOCS_EXPORT_UNAVAILABLE]: 'googleDocsExportUnavailable',
	[PDF_ERROR_CODES.fileAccessRequired]: 'pdfFileAccessRequired',
	[PDF_ERROR_CODES.passwordProtected]: 'pdfPasswordProtected',
	[PDF_ERROR_CODES.textUnavailable]: 'pdfTextUnavailable',
	[PDF_ERROR_CODES.extractionFailed]: 'pdfExtractionFailed',
} as const;

export function getPlaybackErrorTranslationKey(error: string | undefined): keyof typeof THEME_TRANSLATIONS.en | undefined {
	return error === undefined ? undefined : playbackErrorTranslationKeys[error as keyof typeof playbackErrorTranslationKeys];
}

export function getLocalizedPlaybackError(error: string | undefined): string | undefined {
	const key = getPlaybackErrorTranslationKey(error);
	return key ? t(key) : error;
}
```

- [ ] **Step 4: Run the targeted test and TypeScript build**

Run:

```bash
rtk env CI=true node --experimental-strip-types --test tests/unit/pdf_playback_error.test.ts
rtk env CI=true pnpm build
```

Expected: the new unit test passes and the build proves every EN/VI object has the same key set.

- [ ] **Step 5: Commit the shared failure contract**

```bash
rtk git add src/shared/constants.ts src/shared/i18n.ts tests/unit/pdf_playback_error.test.ts
rtk git commit -m "feat: localize PDF reading errors"
```

## Task 2: Build the Local, Testable PDF Extraction Adapter

**Files:**
- Create: `src/background/pdf_extractor.ts`
- Create: `tests/unit/pdf_extractor.test.ts`
- Modify: `package.json:22-28`
- Modify: `pnpm-lock.yaml`
- Modify: `rsbuild.config.ts:68-95`

**Interfaces:**
- Consumes: `Article` from `src/shared/types.ts` and `PdfErrorCode`/`PDF_ERROR_CODES` from Task 1.
- Produces: `extractPdfArticle(input, dependencies): Promise<PdfArticleResponse | null>`.
- Produces: `isSupportedPdfSource(url): boolean` for `https:` and `file:` only.
- `null` means the fallback response was not a PDF; `{ success: false, error: PdfErrorCode }` means a PDF-specific failure; `{ success: true, article: Article }` is ready for `startPlayback()`.

- [ ] **Step 1: Write the failing adapter tests**

Create `tests/unit/pdf_extractor.test.ts`. Use a fake loader so these tests never parse a real file or touch Chrome:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { PDF_ERROR_CODES } from '../../src/shared/constants.ts';
import { extractPdfArticle, isSupportedPdfSource, type PdfExtractorDependencies } from '../../src/background/pdf_extractor.ts';

const source = { url: 'https://example.com/reports/q2.pdf', title: 'Q2 report' };
const pdfBytes = new TextEncoder().encode('%PDF-1.7\nfixture').buffer as ArrayBuffer;

function dependencies(overrides: Partial<PdfExtractorDependencies> = {}): PdfExtractorDependencies {
	return {
		fetchPdf: async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/pdf' }), arrayBuffer: async () => pdfBytes }),
		isFileSchemeAccessAllowed: async () => true,
		loadDocument: async () => ({
			numPages: 2,
			getMetadata: async () => ({ info: { Title: 'Quarterly report' } }),
			getPage: async (pageNumber) => ({
				getTextContent: async () => ({ items: [{ str: pageNumber === 1 ? 'First page.' : 'Second page.', hasEOL: true }] }),
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
		article: {
			title: 'Quarterly report',
			content: 'First page.\n\nSecond page.',
			url: source.url,
			lang: 'na',
		},
	});
});

test('uses tab title and filename fallbacks, recognizes PDF signatures, and ignores non-PDF fallbacks', async () => {
	const noMetadata = dependencies({
		fetchPdf: async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/octet-stream' }), arrayBuffer: async () => pdfBytes }),
		loadDocument: async () => ({ numPages: 1, getMetadata: async () => ({ info: {} }), getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Body' }] }) }), destroy: async () => undefined }),
	});
	assert.deepEqual(await extractPdfArticle({ ...source, title: 'Tab title' }, noMetadata), {
		success: true,
		article: { title: 'Tab title', content: 'Body', url: source.url, lang: 'na' },
	});
	assert.equal(
		await extractPdfArticle(source, dependencies({ fetchPdf: async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => new TextEncoder().encode('<main/>').buffer }) })),
		null,
	);
});

test('returns the local-file permission error before fetching', async () => {
	let fetches = 0;
	const result = await extractPdfArticle(
		{ url: 'file:///Users/me/report.pdf', title: 'report.pdf' },
		dependencies({ isFileSchemeAccessAllowed: async () => false, fetchPdf: async () => { fetches++; throw new Error('must not fetch'); } }),
	);
	assert.deepEqual(result, { success: false, error: PDF_ERROR_CODES.fileAccessRequired });
	assert.equal(fetches, 0);
});

test('maps password, textless, HTTP, and parser failures without exposing PDF content', async () => {
	const password = await extractPdfArticle(source, dependencies({ loadDocument: async () => Promise.reject(Object.assign(new Error('secret'), { name: 'PasswordException' })) }));
	assert.deepEqual(password, { success: false, error: PDF_ERROR_CODES.passwordProtected });
	const textless = await extractPdfArticle(source, dependencies({ loadDocument: async () => ({ numPages: 1, getMetadata: async () => ({ info: {} }), getPage: async () => ({ getTextContent: async () => ({ items: [] }) }), destroy: async () => undefined }) }));
	assert.deepEqual(textless, { success: false, error: PDF_ERROR_CODES.textUnavailable });
	const http = await extractPdfArticle(source, dependencies({ fetchPdf: async () => ({ ok: false, headers: new Headers(), arrayBuffer: async () => pdfBytes }) }));
	assert.deepEqual(http, { success: false, error: PDF_ERROR_CODES.extractionFailed });
	const malformed = await extractPdfArticle(source, dependencies({ loadDocument: async () => Promise.reject(new Error('broken parser state')) }));
	assert.deepEqual(malformed, { success: false, error: PDF_ERROR_CODES.extractionFailed });
});
```

- [ ] **Step 2: Run the new unit test to verify it fails**

Run:

```bash
rtk env CI=true node --experimental-strip-types --test tests/unit/pdf_extractor.test.ts
```

Expected: FAIL because `src/background/pdf_extractor.ts` does not exist.

- [ ] **Step 3: Add PDF.js and package its worker locally**

Run:

```bash
rtk pnpm add pdfjs-dist@6.1.200
```

Add this object after the two existing ONNX Runtime copies in `rsbuild.config.ts`'s `output.copy` array:

```ts
{
	from: 'node_modules/pdfjs-dist/build/pdf.worker.mjs',
	to: 'assets/pdf.worker.mjs',
},
```

Do not add the worker to `web_accessible_resources`: only the extension background worker loads it.

- [ ] **Step 4: Implement `pdf_extractor.ts` with injected boundaries**

Create `src/background/pdf_extractor.ts` using these interfaces and helpers:

```ts
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';

import { PDF_ERROR_CODES, type PdfErrorCode } from '../shared/constants.ts';
import type { Article } from '../shared/types.ts';

const PDF_FETCH_TIMEOUT_MS = 30_000;

type PdfTextItem = { str?: unknown; hasEOL?: unknown };
type PdfDocument = {
	numPages: number;
	getMetadata(): Promise<{ info?: { Title?: unknown } }>;
	getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
	destroy(): Promise<void>;
};

export type PdfArticleResponse = { success: true; article: Article } | { success: false; error: PdfErrorCode };
export type PdfExtractorDependencies = {
	fetchPdf: (url: string, init: { credentials: 'include'; signal: AbortSignal }) => Promise<Pick<Response, 'ok' | 'headers' | 'arrayBuffer'>>;
	isFileSchemeAccessAllowed: () => Promise<boolean>;
	loadDocument: (data: Uint8Array) => Promise<PdfDocument>;
};

export function isSupportedPdfSource(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === 'https:' || protocol === 'file:';
	} catch {
		return false;
	}
}

async function fetchWithTimeout(
	fetchPdf: PdfExtractorDependencies['fetchPdf'],
	url: string,
	timeoutMs: number,
): Promise<Pick<Response, 'ok' | 'headers' | 'arrayBuffer'>> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchPdf(url, { credentials: 'include', signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
	}
}

function isPdfResponse(headers: Headers, bytes: Uint8Array): boolean {
	return headers.get('content-type')?.toLowerCase().includes('application/pdf') === true || new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
}

function normalizePageText(items: PdfTextItem[]): string {
	let text = '';
	for (const item of items) {
		if (typeof item.str === 'string') text += item.str;
		if (item.hasEOL === true) text += '\n';
	}
	return text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function resolveTitle(metadataTitle: unknown, tabTitle: string, url: string): string {
	if (typeof metadataTitle === 'string' && metadataTitle.trim()) return metadataTitle.trim();
	if (tabTitle.trim()) return tabTitle.trim();
	try {
		return decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
	} catch {
		return url;
	}
}

function isPasswordError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'name' in error && error.name === 'PasswordException';
}
```

Implement `extractPdfArticle(input, dependencies)` with this exact control flow:

```ts
export async function extractPdfArticle(
	input: Pick<Article, 'url' | 'title'>,
	dependencies: PdfExtractorDependencies,
): Promise<PdfArticleResponse | null> {
	if (!isSupportedPdfSource(input.url)) return null;
	if (new URL(input.url).protocol === 'file:' && !(await dependencies.isFileSchemeAccessAllowed())) {
		return { success: false, error: PDF_ERROR_CODES.fileAccessRequired };
	}
	try {
		const response = await fetchWithTimeout(dependencies.fetchPdf, input.url, PDF_FETCH_TIMEOUT_MS);
		if (!response.ok) return { success: false, error: PDF_ERROR_CODES.extractionFailed };
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!isPdfResponse(response.headers, bytes)) return null;
		const document = await dependencies.loadDocument(bytes);
		try {
			const metadata = await document.getMetadata();
			const pages: string[] = [];
			for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
				const textContent = await (await document.getPage(pageNumber)).getTextContent();
				const text = normalizePageText(textContent.items);
				if (text) pages.push(text);
			}
			const content = pages.join('\n\n').trim();
			if (!content) return { success: false, error: PDF_ERROR_CODES.textUnavailable };
			return { success: true, article: { title: resolveTitle(metadata.info?.Title, input.title, input.url), content, url: input.url, lang: 'na' } };
		} finally {
			await document.destroy();
		}
	} catch (error) {
		return { success: false, error: isPasswordError(error) ? PDF_ERROR_CODES.passwordProtected : PDF_ERROR_CODES.extractionFailed };
	}
}
```

Add a production dependency loader beside these helpers:

```ts
export async function loadPdfJsDocument(data: Uint8Array): Promise<PdfDocument> {
	GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('assets/pdf.worker.mjs');
	return getDocument({ data }).promise as Promise<PdfDocument>;
}
```

The background will pass `globalThis.fetch.bind(globalThis)`, `chrome.extension.isAllowedFileSchemeAccess`, and `loadPdfJsDocument`; unit tests pass fakes. Do not log caught errors or response data.

- [ ] **Step 5: Run focused adapter and package checks**

Run sequentially:

```bash
rtk env CI=true node --experimental-strip-types --test tests/unit/pdf_extractor.test.ts
rtk env CI=true pnpm build
rtk test -f dist/assets/pdf.worker.mjs
```

Expected: adapter tests pass, the extension builds, and the locally bundled worker exists at the stable runtime URL.

- [ ] **Step 6: Commit the adapter and bundled dependency**

```bash
rtk git add package.json pnpm-lock.yaml rsbuild.config.ts src/background/pdf_extractor.ts tests/unit/pdf_extractor.test.ts
rtk git commit -m "feat: extract text from local PDFs"
```

## Task 3: Route PDF Viewer Tabs Through the Existing Coordinator

**Files:**
- Modify: `src/background/article_request.ts:9-16`
- Modify: `src/background/background.ts:1-55, 503-550`
- Create: `tests/e2e/pdf-reading.spec.ts`

**Interfaces:**
- Consumes: `isMissingReceiverError()` from `article_request.ts`, `extractPdfArticle()` and `loadPdfJsDocument()` from Task 2, and the current `ArticleResponse` shape.
- Produces: successful PDF starts use `startPlayback({ contentScope: 'article', source: { kind: 'tab', ... }, content: article })` unchanged.
- Produces: PDF-specific failures pass unchanged through `getExtractionError()` and `publishExtractionFailure()`.

- [ ] **Step 1: Write the failing coordinator E2E test**

Create `tests/e2e/pdf-reading.spec.ts`. Define a tiny valid PDF generator inside the spec so the test has no external file or network dependency:

```ts
import { expect, test, installExtensionUiRuntimeMock } from './fixtures';

function createTextLayerPdf(text: string): Buffer {
	const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, '\\$&')}) Tj\nET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let pdf = '%PDF-1.4\n';
	const offsets = objects.map((object, index) => {
		const offset = Buffer.byteLength(pdf);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xrefOffset = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(pdf);
}

async function getBackgroundState(page: import('@playwright/test').Page) {
	return page.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)));
}

test('reads a routed text-layer PDF through the normal tab playback session', async ({ context, extensionId }) => {
	await context.route('https://example.com/text-layer.pdf', (route) =>
		route.fulfill({ contentType: 'application/pdf', body: createTextLayerPdf('PDF fixture text for readit.') }),
	);
	const pdfPage = await context.newPage();
	await pdfPage.goto('https://example.com/text-layer.pdf', { waitUntil: 'commit' });
	const controlPage = await context.newPage();
	await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await pdfPage.bringToFront();

	await controlPage.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
	await expect.poll(() => getBackgroundState(controlPage)).toMatchObject({
		session: { contentScope: 'article', source: { kind: 'tab', title: 'text-layer.pdf', url: 'https://example.com/text-layer.pdf' } },
	});
});
```

Append these exact UI mapping tests. They use the existing Vietnamese Playwright locale and do not add PDF-specific React state or controls:

```ts
const pageInfo = { available: true as const, title: 'PDF fixture', url: 'https://example.com/text-layer.pdf', lang: 'en' };
const vietnameseErrors = [
	['pdfFileAccessRequired', 'Để đọc file PDF trên máy, hãy bật “Cho phép truy cập URL tệp” trong trang chi tiết tiện ích của Chrome.'],
	['pdfPasswordProtected', 'PDF này được bảo vệ bằng mật khẩu và chưa được hỗ trợ.'],
	['pdfTextUnavailable', 'Không tìm thấy văn bản có thể đọc trong PDF này. PDF scan chưa được hỗ trợ.'],
	['pdfExtractionFailed', 'Không thể đọc PDF này. Hãy thử lại hoặc dán văn bản để đọc.'],
] as const;

for (const [code, copy] of vietnameseErrors) {
	test(`Popup renders ${code}`, async ({ page, openPopup }) => {
		await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
		await page.addInitScript((nextCode) => {
			(window as any).commandResponses = { START_CURRENT_PAGE: { success: false, error: nextCode } };
		}, code);
		await openPopup(page);
		await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
		await expect(page.locator('.alert.alert-danger')).toHaveText(copy);
	});

	test(`Side Panel renders ${code}`, async ({ page, openSidePanel }) => {
		await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
		await page.addInitScript((nextCode) => {
			(window as any).commandResponses = { START_CURRENT_PAGE: { success: false, error: nextCode } };
		}, code);
		await openSidePanel(page);
		await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
		await expect(page.getByRole('alert')).toHaveText(copy);
	});
}
```

- [ ] **Step 2: Run the E2E spec to verify it fails**

Run:

```bash
rtk env CI=true pnpm build
rtk env CI=true pnpm exec playwright test tests/e2e/pdf-reading.spec.ts
```

Expected: FAIL before the background imports and invokes the PDF adapter.

- [ ] **Step 3: Expose the missing-receiver classification and invoke the fallback**

Change `src/background/article_request.ts` so `isMissingReceiverError` is exported without changing its message match:

```ts
export function isMissingReceiverError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('Could not establish connection') || message.includes('Receiving end does not exist');
}
```

In `src/background/background.ts`, import `isMissingReceiverError`, `extractPdfArticle`, and `loadPdfJsDocument`. Add this helper above `startCurrentPage()`:

```ts
async function requestCurrentTabArticle(tabId: number, title: string | undefined, url: string): Promise<import('./article_request').ArticleResponse> {
	try {
		return await requestArticleFromTab(tabId, {
			sendMessage: (targetTabId, message) => chrome.tabs.sendMessage(targetTabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
	} catch (error) {
		if (!isMissingReceiverError(error)) throw error;
		const pdfResponse = await extractPdfArticle(
			{ url, title: title || url },
			{
				fetchPdf: (sourceUrl, init) => globalThis.fetch(sourceUrl, init),
				isFileSchemeAccessAllowed: () => chrome.extension.isAllowedFileSchemeAccess(),
				loadDocument: loadPdfJsDocument,
			},
		);
		if (pdfResponse !== null) return pdfResponse;
		throw error;
	}
}
```

Replace the direct `requestArticleFromTab(...)` call in `startCurrentPage()` with:

```ts
articleResponse = await requestCurrentTabArticle(activeTab.id, activeTab.title, url);
```

Extend `getExtractionError()` so it preserves every `PDF_ERROR_CODES` value in addition to `GOOGLE_DOCS_EXPORT_UNAVAILABLE`; otherwise return the current generic extraction error. Keep the current catch block and success block intact. This guarantees that failure occurs before `startPlayback()` and manual playback remains active.

- [ ] **Step 4: Run focused coordinator and UI regression tests**

Run sequentially:

```bash
rtk env CI=true pnpm build
rtk env CI=true pnpm exec playwright test tests/e2e/pdf-reading.spec.ts
rtk env CI=true pnpm exec playwright test tests/e2e/reader.spec.ts tests/e2e/side-panel.spec.ts
```

Expected: the PDF route creates the ordinary `article` session, all four messages render through shared UI logic, and standard reader/Side Panel flows remain green.

- [ ] **Step 5: Commit coordinator integration**

```bash
rtk git add src/background/article_request.ts src/background/background.ts tests/e2e/pdf-reading.spec.ts
rtk git commit -m "feat: read active-tab PDFs"
```

## Task 4: Run the Release-Quality Verification Chain

**Files:**
- Modify only if a verification command identifies a PDF-specific defect in the Task 1-3 scope.

**Interfaces:**
- Consumes: completed PDF adapter, coordinator, translations, and E2E fixture from Tasks 1-3.
- Produces: evidence that the complete extension still builds, tests, packages its PDF worker, and has no whitespace errors.

- [ ] **Step 1: Run all unit tests**

```bash
rtk env CI=true pnpm test:unit
```

Expected: all existing and PDF unit tests pass.

- [ ] **Step 2: Build and validate the production manifest/worker**

```bash
rtk env CI=true pnpm build
rtk env CI=true pnpm validate:manifest
rtk test -f dist/assets/pdf.worker.mjs
```

Expected: production build succeeds, the manifest keeps its existing permission boundary, and PDF.js worker is bundled locally.

- [ ] **Step 3: Run the complete Playwright suite**

```bash
rtk env CI=true pnpm test:e2e
```

Expected: all E2E tests, including `pdf-reading.spec.ts`, pass. If an unrelated existing flake occurs, reproduce the targeted PDF regression before attributing it to this feature.

- [ ] **Step 4: Check the final patch and update the code graph**

```bash
rtk git diff --check
rtk graphify update .
rtk git status --short
```

Expected: no whitespace errors; graph is refreshed; status contains only the intended PDF feature files before the final commit/review.

## Spec Coverage Review

| Approved design requirement | Plan task |
| --- | --- |
| HTTPS and local text-layer PDFs | Tasks 2 and 3 |
| Existing playback pipeline, Popup, Side Panel, and manual-reader safety | Tasks 1 and 3 |
| No Viewer replacement, OCR, password entry, or word highlighting | Global Constraints and Task 3 |
| Local-only parser/worker, source-only user-triggered fetch, no new broad permissions | Global Constraints and Task 2 |
| Local-file permission, locked, textless, and generic errors in EN/VI | Task 1 and Task 3 |
| Unit, E2E, build, manifest, full suite, diff, and graph checks | Tasks 2-4 |
