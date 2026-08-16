# Word Online Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the extension read Microsoft Word documents opened from OneDrive and SharePoint by downloading the raw `.docx` from a same-origin endpoint and reusing the existing DOCX pipeline.

**Architecture:** A content script adapter recognizes the document URL, fetches `<sitePath>/_layouts/15/download.aspx?UniqueId=<guid>` with the tab's own session cookies, validates the response, and returns base64 bytes. The background worker decodes them, parses with the existing `extractDocxText()`, and feeds the resulting `Article` into the unchanged playback pipeline. No OAuth, no Microsoft Graph, no new manifest permissions.

**Tech Stack:** TypeScript, Chrome MV3, JSZip (already a dependency, via `extractDocxText`), `node:test` + `node:assert/strict` for unit tests, Playwright for end-to-end tests, Biome for linting.

**Spec:** `docs/specs/2026-08-16-word-online-reading-design.md`

## Global Constraints

- No new entries in `public/manifest.json` — no permissions, no host permissions.
- No Microsoft Graph, no OAuth, no Azure app registration, no backend calls.
- `dist/chrome/content_script.js` must stay under 80 KB (baseline 66 KB). JSZip must not reach it.
- Single error code for every failure mode: `wordOnlineDownloadUnavailable`.
- Document bytes are never written to storage; response bodies, document GUIDs, and document text are never logged.
- Maximum accepted document size: 25 MB.
- Download fetch timeout: 15000 ms.
- Source files under `src/` import siblings with an explicit `.ts` extension (follow `src/content/google_docs_extractor.ts`).
- Unit tests use `node:test` and `node:assert/strict`, never a third-party assertion library.
- Run unit tests with `pnpm test:unit`; a single file with `node --experimental-strip-types --test tests/unit/<file>.test.ts`.
- Playwright loads `dist/chrome`. **Always run `pnpm build:chrome` before `pnpm test:e2e`** — a stale build reports a false pass.
- Lint with Biome, but scope it: `pnpm lint` on the whole repo already reports **118 pre-existing errors** on a clean tree (`src/background/background.ts` alone accounts for 15, all formatting complaints unrelated to this work). The bar for every task is therefore "no new errors in the files this task touched", checked with `npx biome check <files>`. Do not attempt to fix the pre-existing errors — that is unrelated work.
- The repo uses tabs for indentation and single quotes.

---

### Task 1: Base64 helpers

**Files:**
- Create: `src/shared/base64.ts`
- Create: `tests/unit/base64.test.ts`
- Modify: `src/background/background.ts:229-245` (replace the inlined decode loop)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `bytesToBase64(bytes: Uint8Array): string`
  - `base64ToBytes(base64: string): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/base64.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ToBytes, bytesToBase64 } from '../../src/shared/base64.ts';

test('round-trips arbitrary bytes', () => {
	const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x7f, 0x80]);
	assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test('encodes a ZIP signature to the expected prefix', () => {
	assert.equal(bytesToBase64(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'UEsDBA==');
});

test('encodes a buffer far larger than the call-stack argument limit', () => {
	const bytes = new Uint8Array(300_000);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = index % 256;
	}
	const encoded = bytesToBase64(bytes);
	assert.deepEqual(base64ToBytes(encoded), bytes);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/base64.test.ts`
Expected: FAIL — cannot find module `src/shared/base64.ts`

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/base64.ts`:

```ts
/**
 * Spreading a whole document into `String.fromCharCode` overflows the call stack once the buffer
 * reaches a few hundred kilobytes, and the failure only shows up with real files rather than with
 * small test fixtures. Walking the buffer in chunks keeps the encoder synchronous, which is what
 * lets it run under `node --test` where `FileReader` is not a global.
 */
const CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/base64.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Replace the inlined decode loop in background**

In `src/background/background.ts`, add to the import block:

```ts
import { base64ToBytes } from '../shared/base64.ts';
```

Then inside `requestCurrentTabArticle`, replace the body of `fetchFileBytesViaOffscreen` so the manual loop is gone:

```ts
					fetchFileBytesViaOffscreen: async (fileUrl) => {
						await setupOffscreen();
						const response = (await dispatchOffscreenCommand({
							action: 'FETCH_FILE_BYTES',
							payload: { url: fileUrl },
						})) as { success: boolean; base64?: string; error?: string };
						if (response?.success && typeof response.base64 === 'string' && response.base64.length > 0) {
							return base64ToBytes(response.base64);
						}
						return null;
					},
```

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm test:unit`
Expected: PASS, including the existing PDF tests

Run: `npx biome check <the files this task touched>`
Expected: no new errors. `pnpm lint` across the repo already fails with 118 pre-existing errors (see Global Constraints), so a whole-repo run proves nothing here.

- [ ] **Step 7: Commit**

```bash
git add src/shared/base64.ts tests/unit/base64.test.ts src/background/background.ts
git commit -m "refactor: share chunk-safe base64 helpers between background and content"
```

---

### Task 2: Error code and localized messages

**Files:**
- Modify: `src/shared/constants.ts:3`
- Modify: `src/shared/i18n.ts` (the `getPlaybackErrorTranslationKey` switch)
- Modify: `src/shared/locales/en.json:64`
- Modify: `src/shared/locales/vi.json:64`
- Create: `tests/unit/word_online_error_code.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `WORD_ONLINE_DOWNLOAD_UNAVAILABLE` — the string literal type `'wordOnlineDownloadUnavailable'`, exported from `src/shared/constants.ts`
  - a `'wordOnlineDownloadUnavailable'` key in both locale files, which makes it a valid `TranslationKey`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/word_online_error_code.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../../src/shared/constants.ts';
import { getPlaybackErrorTranslationKey } from '../../src/shared/i18n.ts';
import en from '../../src/shared/locales/en.json' with { type: 'json' };
import vi from '../../src/shared/locales/vi.json' with { type: 'json' };

test('maps the Word Online code to a translation key', () => {
	assert.equal(getPlaybackErrorTranslationKey(WORD_ONLINE_DOWNLOAD_UNAVAILABLE), 'wordOnlineDownloadUnavailable');
});

test('both locales carry a non-empty message for the code', () => {
	for (const locale of [en, vi]) {
		const message = (locale as Record<string, unknown>).wordOnlineDownloadUnavailable;
		assert.equal(typeof message, 'string');
		assert.ok((message as string).length > 0);
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/word_online_error_code.test.ts`
Expected: FAIL — `WORD_ONLINE_DOWNLOAD_UNAVAILABLE` is not exported

- [ ] **Step 3: Add the constant**

In `src/shared/constants.ts`, directly below the existing Google Docs code on line 3:

```ts
export const GOOGLE_DOCS_EXPORT_UNAVAILABLE = 'googleDocsExportUnavailable';
export const WORD_ONLINE_DOWNLOAD_UNAVAILABLE = 'wordOnlineDownloadUnavailable';
```

- [ ] **Step 4: Add the locale strings**

In `src/shared/locales/en.json`, immediately after the `"googleDocsExportUnavailable"` entry:

```json
	"wordOnlineDownloadUnavailable": "Unable to read this Word document. Check view or download permission, or read selected/pasted text instead.",
```

In `src/shared/locales/vi.json`, in the same position:

```json
	"wordOnlineDownloadUnavailable": "Không thể đọc tài liệu Word này. Hãy kiểm tra quyền xem hoặc tải xuống, hoặc đọc văn bản đã chọn/dán.",
```

- [ ] **Step 5: Map the code in i18n**

In `src/shared/i18n.ts`, extend the import on line 1 and add a case to `getPlaybackErrorTranslationKey`, directly after the `GOOGLE_DOCS_EXPORT_UNAVAILABLE` case:

```ts
import {
	DOCX_ERROR_CODES,
	EPUB_ERROR_CODES,
	GOOGLE_DOCS_EXPORT_UNAVAILABLE,
	PDF_ERROR_CODES,
	WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
} from './constants.ts';
```

```ts
		case WORD_ONLINE_DOWNLOAD_UNAVAILABLE:
			return 'wordOnlineDownloadUnavailable';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/word_online_error_code.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/shared/i18n.ts src/shared/locales/en.json src/shared/locales/vi.json tests/unit/word_online_error_code.test.ts
git commit -m "feat: add the Word Online download failure code and messages"
```

---

### Task 3: URL recognition

**Files:**
- Create: `src/content/word_online_extractor.ts`
- Create: `tests/unit/word_online_extractor.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseWordOnlineDocument(url: string): { sitePath: string; documentId: string } | null`

The `sitePath` is everything in the pathname before `/_layouts/15/`, e.g. `/personal/ac20f9f43d21e582` or `/sites/marketing`. The `documentId` is the `sourcedoc` GUID with braces stripped.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/word_online_extractor.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWordOnlineDocument } from '../../src/content/word_online_extractor.ts';

const GUID = '2c444ed6-0def-4010-82d2-79c12f3ec8c5';

test('accepts OneDrive and SharePoint document pages', () => {
	assert.deepEqual(
		parseWordOnlineDocument(`https://onedrive.live.com/personal/ac20f9f43d21e582/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D&action=edit`),
		{ sitePath: '/personal/ac20f9f43d21e582', documentId: GUID },
	);
	assert.deepEqual(
		parseWordOnlineDocument(`https://onedrive.live.com/personal/cid/_layouts/15/Doc.aspx?sourcedoc={${GUID}}`),
		{ sitePath: '/personal/cid', documentId: GUID },
	);
	assert.deepEqual(
		parseWordOnlineDocument(`https://onedrive.live.com/personal/cid/_layouts/15/doc2.aspx?sourcedoc=${GUID}`),
		{ sitePath: '/personal/cid', documentId: GUID },
	);
	assert.deepEqual(
		parseWordOnlineDocument(`https://contoso.sharepoint.com/sites/marketing/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`),
		{ sitePath: '/sites/marketing', documentId: GUID },
	);
	assert.deepEqual(
		parseWordOnlineDocument(`https://contoso-my.sharepoint.com/personal/bez_contoso_com/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`),
		{ sitePath: '/personal/bez_contoso_com', documentId: GUID },
	);
});

test('rejects look-alike hosts, wrong schemes, and malformed identifiers', () => {
	const rejected = [
		`http://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`,
		`https://evilsharepoint.com/sites/x/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`,
		`https://contoso.sharepoint.com.evil.com/sites/x/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D`,
		`https://docs.google.com/document/d/abc/edit`,
		'https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx',
		'https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7Bnot-a-guid%7D',
		`https://onedrive.live.com/personal/cid/_layouts/15/download.aspx?sourcedoc=%7B${GUID}%7D`,
		`https://onedrive.live.com/personal/cid/Documents/File.docx?sourcedoc=%7B${GUID}%7D`,
		'not a url at all',
	];
	for (const url of rejected) {
		assert.equal(parseWordOnlineDocument(url), null, url);
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/word_online_extractor.test.ts`
Expected: FAIL — cannot find module `src/content/word_online_extractor.ts`

- [ ] **Step 3: Write minimal implementation**

Create `src/content/word_online_extractor.ts`:

```ts
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
		const documentId = parsed.searchParams.get('sourcedoc')?.replace(/[{}]/g, '') ?? '';
		return DOCUMENT_ID.test(documentId) ? { sitePath, documentId } : null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/word_online_extractor.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/content/word_online_extractor.ts tests/unit/word_online_extractor.test.ts
git commit -m "feat: recognize OneDrive and SharePoint Word document URLs"
```

---

### Task 4: Download, validate, encode

**Files:**
- Modify: `src/content/word_online_extractor.ts`
- Modify: `tests/unit/word_online_extractor.test.ts`

**Interfaces:**
- Consumes: `parseWordOnlineDocument` (Task 3), `bytesToBase64` (Task 1), `WORD_ONLINE_DOWNLOAD_UNAVAILABLE` (Task 2)
- Produces:
  - `type WordOnlineFetch = (url: string, init?: { credentials?: 'same-origin'; signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'headers' | 'arrayBuffer'>>`
  - `type WordOnlineExtractionResponse = { success: true; docxBase64: string; source: Pick<Article, 'url' | 'title' | 'lang'>; readableSurface: 'document-reader' } | { success: false; error: typeof WORD_ONLINE_DOWNLOAD_UNAVAILABLE }`
  - `extractWordOnlineDocx(input: Pick<Article, 'url' | 'title' | 'lang'>, fetcher: WordOnlineFetch): Promise<WordOnlineExtractionResponse | null>` — `null` means "not a Word Online page, keep trying other extractors"
  - `fetchWithTimeout(fetcher: WordOnlineFetch, url: string, timeoutMs: number)`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/word_online_extractor.test.ts`, and extend the import on line 3 to
`import { extractWordOnlineDocx, fetchWithTimeout, parseWordOnlineDocument, type WordOnlineFetch } from '../../src/content/word_online_extractor.ts';`
plus `import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../../src/shared/constants.ts';`:

```ts
const PAGE = {
	url: `https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7B${GUID}%7D&action=edit`,
	title: 'Tài liệu',
	lang: 'vi',
};
const DOWNLOAD_URL = `https://onedrive.live.com/personal/cid/_layouts/15/download.aspx?UniqueId=${GUID}`;

function docxBytes(extra = 0): Uint8Array {
	const bytes = new Uint8Array(4 + extra);
	bytes.set([0x50, 0x4b, 0x03, 0x04]);
	return bytes;
}

function respond(options: { ok?: boolean; body?: Uint8Array; contentLength?: string }): WordOnlineFetch {
	return async () => ({
		ok: options.ok ?? true,
		headers: new Headers(options.contentLength ? { 'content-length': options.contentLength } : {}),
		arrayBuffer: async () => (options.body ?? docxBytes()).buffer as ArrayBuffer,
	});
}

test('returns null for pages that are not Word Online documents', async () => {
	const untouched: WordOnlineFetch = async () => {
		throw new Error('fetch must not run');
	};
	assert.equal(await extractWordOnlineDocx({ url: 'https://example.com/article', title: 'A', lang: 'en' }, untouched), null);
});

test('downloads from the same-origin endpoint built from the parsed identifier', async () => {
	const calls: Array<{ url: string; credentials: string | undefined }> = [];
	const fetcher: WordOnlineFetch = async (url, init) => {
		calls.push({ url, credentials: init?.credentials });
		return { ok: true, headers: new Headers(), arrayBuffer: async () => docxBytes(8).buffer as ArrayBuffer };
	};

	const result = await extractWordOnlineDocx(PAGE, fetcher);

	assert.deepEqual(calls, [{ url: DOWNLOAD_URL, credentials: 'same-origin' }]);
	assert.equal(result?.success, true);
	assert.equal(result?.success === true && result.readableSurface, 'document-reader');
	assert.deepEqual(result?.success === true && result.source, PAGE);
	assert.ok(result?.success === true && result.docxBase64.startsWith('UEsDBA'));
});

test('reports the shared code for every download failure', async () => {
	const oversized = String(26 * 1024 * 1024);
	const rejected: WordOnlineFetch = async () => Promise.reject(new Error('network unavailable'));
	const aborted: WordOnlineFetch = async () => Promise.reject(new DOMException('The operation was aborted', 'AbortError'));

	for (const fetcher of [
		respond({ ok: false }),
		respond({ body: new Uint8Array(0) }),
		respond({ body: new TextEncoder().encode('<html>Authenticate</html>') }),
		respond({ contentLength: oversized }),
		rejected,
		aborted,
	]) {
		assert.deepEqual(await extractWordOnlineDocx(PAGE, fetcher), {
			success: false,
			error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
		});
	}
});

test('fetchWithTimeout aborts a hung download once the timeout elapses', async () => {
	let observedSignal: AbortSignal | undefined;
	const hanging: WordOnlineFetch = (_url, init) =>
		new Promise((_resolve, reject) => {
			observedSignal = init?.signal;
			init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
		});

	await assert.rejects(
		fetchWithTimeout(hanging, DOWNLOAD_URL, 20),
		(error: unknown) => error instanceof DOMException && error.name === 'AbortError',
	);
	assert.equal(observedSignal?.aborted, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/word_online_extractor.test.ts`
Expected: FAIL — `extractWordOnlineDocx` is not exported

- [ ] **Step 3: Write minimal implementation**

Add to the top of `src/content/word_online_extractor.ts`:

```ts
import { bytesToBase64 } from '../shared/base64.ts';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../shared/constants.ts';
import type { Article } from '../shared/types.ts';
```

Add below the existing `parseWordOnlineDocument`:

```ts
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
```

A missing `content-length` yields `Number('') === 0`, which fails the ceiling test and falls through to the `byteLength` check, so an absent header cannot bypass the limit.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/word_online_extractor.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/content/word_online_extractor.ts tests/unit/word_online_extractor.test.ts
git commit -m "feat: download and validate Word Online documents same-origin"
```

---

### Task 5: Background article construction

**Files:**
- Create: `src/background/word_online_article.ts`
- Create: `tests/unit/word_online_article.test.ts`

**Interfaces:**
- Consumes: `base64ToBytes` (Task 1), `WORD_ONLINE_DOWNLOAD_UNAVAILABLE` (Task 2), the existing `extractDocxText` and `detectContentLanguage`
- Produces:
  - `type WordOnlineArticleResult = { success: true; article: Article; readableSurface: 'document-reader' } | { success: false; error: typeof WORD_ONLINE_DOWNLOAD_UNAVAILABLE }`
  - `buildWordOnlineArticle(docxBase64: string, source: Pick<Article, 'url' | 'title' | 'lang'>): Promise<WordOnlineArticleResult>`

This lives in its own module rather than inside `background.ts` so it can be unit-tested without booting the whole worker.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/word_online_article.test.ts`:

```ts
import JSZip from 'jszip';

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWordOnlineArticle } from '../../src/background/word_online_article.ts';
import { bytesToBase64 } from '../../src/shared/base64.ts';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../../src/shared/constants.ts';

const NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const SOURCE = {
	url: 'https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7B2c444ed6-0def-4010-82d2-79c12f3ec8c5%7D',
	title: 'Tài liệu.docx',
	lang: 'en',
};

async function docxBase64(paragraphs: string[], title?: string): Promise<string> {
	const archive = new JSZip();
	const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
	archive.file('word/document.xml', `<?xml version="1.0"?><w:document ${NAMESPACE}><w:body>${body}</w:body></w:document>`);
	if (title) {
		archive.file(
			'docProps/core.xml',
			`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`,
		);
	}
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });
	return bytesToBase64(new Uint8Array(buffer));
}

test('builds an Article using the title stored inside the document', async () => {
	const result = await buildWordOnlineArticle(await docxBase64(['First paragraph.', 'Second paragraph.'], 'Quarterly Report'), SOURCE);

	assert.deepEqual(result, {
		success: true,
		readableSurface: 'document-reader',
		article: {
			title: 'Quarterly Report',
			content: 'First paragraph.\n\nSecond paragraph.',
			url: SOURCE.url,
			lang: 'en',
		},
	});
});

test('falls back to the page title when the document declares none', async () => {
	const result = await buildWordOnlineArticle(await docxBase64(['Only paragraph.']), SOURCE);
	assert.equal(result.success === true && result.article.title, 'Tài liệu.docx');
});

test('detects the language from the extracted text rather than the page', async () => {
	const result = await buildWordOnlineArticle(
		await docxBase64(['Chia tay không chỉ là buồn trong lòng, mà còn là một cú sốc mạnh với não bộ và cơ thể.']),
		SOURCE,
	);
	assert.equal(result.success === true && result.article.lang, 'vi');
});

test('reports the shared code when the archive is not a Word document', async () => {
	const archive = new JSZip();
	archive.file('xl/workbook.xml', '<workbook/>');
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });

	assert.deepEqual(await buildWordOnlineArticle(bytesToBase64(new Uint8Array(buffer)), SOURCE), {
		success: false,
		error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
	});
});

test('reports the shared code when the document has no text', async () => {
	assert.deepEqual(await buildWordOnlineArticle(await docxBase64([]), SOURCE), {
		success: false,
		error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/word_online_article.test.ts`
Expected: FAIL — cannot find module `src/background/word_online_article.ts`

- [ ] **Step 3: Write minimal implementation**

Create `src/background/word_online_article.ts`:

```ts
import { base64ToBytes } from '../shared/base64.ts';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../shared/constants.ts';
import { extractDocxText } from '../shared/docx_extractor.ts';
import { detectContentLanguage } from '../shared/language_detection.ts';
import type { Article } from '../shared/types.ts';

export type WordOnlineArticleResult =
	| { success: true; article: Article; readableSurface: 'document-reader' }
	| { success: false; error: typeof WORD_ONLINE_DOWNLOAD_UNAVAILABLE };

/**
 * Parsing happens here rather than in the content script so JSZip stays out of the bundle injected
 * into every page. Every `DocxError` collapses into the one download code: an Excel workbook opened
 * through `Doc.aspx` and a denied download need the same advice from the user's point of view.
 */
export async function buildWordOnlineArticle(
	docxBase64: string,
	source: Pick<Article, 'url' | 'title' | 'lang'>,
): Promise<WordOnlineArticleResult> {
	try {
		const bytes = base64ToBytes(docxBase64);
		const { title, content } = await extractDocxText(bytes.buffer as ArrayBuffer, source.title);
		return {
			success: true,
			article: { title, content, url: source.url, lang: detectContentLanguage(content, source.lang) },
			readableSurface: 'document-reader',
		};
	} catch {
		return { success: false, error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE };
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/word_online_article.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/background/word_online_article.ts tests/unit/word_online_article.test.ts
git commit -m "feat: build a Word Online Article from downloaded docx bytes"
```

---

### Task 6: Wire the content script

**Files:**
- Modify: `src/content/content_script.ts:1-33`

**Interfaces:**
- Consumes: `extractWordOnlineDocx` (Task 4)
- Produces: an `EXTRACT_ARTICLE` response that may now carry `{ success: true, docxBase64, source, readableSurface: 'document-reader' }`

- [ ] **Step 1: Add the import**

In `src/content/content_script.ts`, after the `google_docs_extractor` import:

```ts
import { extractWordOnlineDocx } from './word_online_extractor';
```

- [ ] **Step 2: Extend the response union**

Replace the `ArticleExtractionResponse` type:

```ts
type ArticleExtractionResponse =
	| { success: true; article: Article; readableSurface: 'website-dom' | 'document-reader' | 'none' }
	| {
			success: true;
			docxBase64: string;
			source: { url: string; title: string; lang: string };
			readableSurface: 'document-reader';
	  }
	| { success: false; error: string };
```

- [ ] **Step 3: Call the adapter between Google Docs and Readability**

Replace the body of `extractArticle`:

```ts
async function extractArticle(): Promise<ArticleExtractionResponse> {
	const page = {
		title: document.title || 'Untitled Article',
		url: document.location.href,
		lang: getDocumentLanguage(),
	};

	const googleDocsResult = await extractGoogleDocsArticle(page, globalThis.fetch.bind(globalThis));
	if (googleDocsResult) {
		return googleDocsResult;
	}

	const wordOnlineResult = await extractWordOnlineDocx(page, globalThis.fetch.bind(globalThis));
	if (wordOnlineResult) {
		return wordOnlineResult;
	}

	const article = extractArticleFromDocument(document);
	return article
		? { success: true, article, readableSurface: 'website-dom' }
		: { success: false, error: 'Could not find a readable article on this page.' };
}
```

- [ ] **Step 4: Verify types and lint**

Run: `pnpm build:chrome`
Expected: `tsc` reports no errors and the build completes

Run: `npx biome check <the files this task touched>`
Expected: no new errors. `pnpm lint` across the repo already fails with 118 pre-existing errors (see Global Constraints), so a whole-repo run proves nothing here.

- [ ] **Step 5: Commit**

```bash
git add src/content/content_script.ts
git commit -m "feat: route Word Online pages through the new adapter"
```

---

### Task 7: Wire the background worker

**Files:**
- Modify: `src/background/article_request.ts:1`
- Modify: `src/background/background.ts` (imports, `getExtractionError` at line 103, `requestCurrentTabArticle` at line 249)

**Interfaces:**
- Consumes: `buildWordOnlineArticle` (Task 5), `WORD_ONLINE_DOWNLOAD_UNAVAILABLE` (Task 2)
- Produces: nothing new; `requestCurrentTabArticle` keeps returning `ArticleResponse`

- [ ] **Step 1: Widen the transport type**

Replace line 1 of `src/background/article_request.ts`:

```ts
/** What the caller of `requestCurrentTabArticle` sees: the docx variant has already been resolved. */
export type ResolvedArticleResponse =
	| { success: true; article: unknown; readableSurface: unknown }
	| { success: false; error?: string };

/** What the content script may put on the wire, including raw Word Online bytes awaiting parsing. */
export type ArticleResponse =
	| ResolvedArticleResponse
	| {
			success: true;
			docxBase64: string;
			source: { url: string; title: string; lang: string };
			readableSurface: unknown;
	  };
```

Two types, not one. `requestCurrentTabArticle` converts the docx variant into an `Article` before it returns, so its caller further down `background.ts` never sees that variant and still reads `articleResponse.article` directly. Widening the single `ArticleResponse` would break that caller with `TS2339`.

- [ ] **Step 2: Import into background**

In `src/background/background.ts`, add `WORD_ONLINE_DOWNLOAD_UNAVAILABLE` to the existing `../shared/constants` import (which already brings in `GOOGLE_DOCS_EXPORT_UNAVAILABLE`), and add:

```ts
import { buildWordOnlineArticle } from './word_online_article.ts';
```

Change the `./article_request` import to bring in `ResolvedArticleResponse` instead of `ArticleResponse`, and narrow the signature:

```ts
async function requestCurrentTabArticle(tabId: number, title: string | undefined, url: string): Promise<ResolvedArticleResponse> {
```

- [ ] **Step 3: Preserve the code through the error mapper**

Replace `getExtractionError` at line 103:

```ts
function getExtractionError(error: string | undefined): string {
	if (error === GOOGLE_DOCS_EXPORT_UNAVAILABLE) return error;
	if (error === WORD_ONLINE_DOWNLOAD_UNAVAILABLE) return error;
	if (error && Object.values(PDF_ERROR_CODES).includes(error as PdfErrorCode)) return error;
	return ERROR_MESSAGES.extraction;
}
```

Skipping this line is a silent failure: the code would be replaced by the generic extraction message and the localized string would never be reached.

- [ ] **Step 4: Handle the docx variant before the PDF fallback**

In `requestCurrentTabArticle`, replace the `try` block body that begins at line 249:

```ts
	try {
		const articleResponse = await requestArticleFromTab(tabId, {
			sendMessage: (targetTabId, message) => chrome.tabs.sendMessage(targetTabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
		// A recognized Word Online page is a final answer either way. Falling through would send the
		// OneDrive page URL into the PDF fallback, which cannot succeed and only costs a request.
		if ('docxBase64' in articleResponse) {
			return await buildWordOnlineArticle(articleResponse.docxBase64, articleResponse.source);
		}
		if (
			articleResponse.success &&
			isArticle(articleResponse.article) &&
			isArticleReadableSurface(articleResponse.readableSurface)
		) {
			return articleResponse;
		}
		return (await requestPdfFallback()) ?? articleResponse;
	} catch (error) {
		if (!isMissingReceiverError(error)) throw error;
		const pdfResponse = await requestPdfFallback();
		if (pdfResponse !== null) return pdfResponse;
		throw error;
	}
```

- [ ] **Step 5: Verify types, tests, and lint**

Run: `pnpm build:chrome`
Expected: `tsc` reports no errors

Run: `pnpm test:unit`
Expected: PASS, all files

Run: `npx biome check <the files this task touched>`
Expected: no new errors. `pnpm lint` across the repo already fails with 118 pre-existing errors (see Global Constraints), so a whole-repo run proves nothing here.

- [ ] **Step 6: Commit**

```bash
git add src/background/article_request.ts src/background/background.ts
git commit -m "feat: parse Word Online docx bytes in the background worker"
```

---

### Task 8: End-to-end coverage

**Files:**
- Modify: `tests/e2e/reader.spec.ts` (add two tests inside the existing `test.describe`, after the Google Docs tests)

**Interfaces:**
- Consumes: the shipped extension in `dist/chrome`, the existing `requestArticle` helper, `buildDocxFixture` from `tests/e2e/docx_fixture.ts`
- Produces: nothing

`requestArticle` sends `EXTRACT_ARTICLE` straight to the content script, so these tests assert the content script contract. The background half is covered by Task 5.

- [ ] **Step 1: Write the failing tests**

Add to the top of `tests/e2e/reader.spec.ts`:

```ts
import { buildDocxFixture } from './docx_fixture';
```

Add inside the `test.describe`, after the Google Docs denial test:

```ts
	const WORD_GUID = '2c444ed6-0def-4010-82d2-79c12f3ec8c5';
	const WORD_PAGE_BODY =
		'<html lang="vi"><head><title>Tài liệu</title></head><body><div id="WACViewPanel"><iframe></iframe></div></body></html>';

	test('reads a Word Online document from the same-origin download endpoint', async ({ context, extensionId }) => {
		const docx = await buildDocxFixture(['Đoạn Word thứ nhất.', 'Đoạn Word thứ hai.']);
		await context.route('https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx**', (route) =>
			route.fulfill({ contentType: 'text/html; charset=utf-8', body: WORD_PAGE_BODY }),
		);
		await context.route(`https://onedrive.live.com/personal/cid/_layouts/15/download.aspx?UniqueId=${WORD_GUID}`, (route) =>
			route.fulfill({
				contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				body: docx,
			}),
		);

		const documentPage = await context.newPage();
		await documentPage.goto(`https://onedrive.live.com/personal/cid/_layouts/15/doc.aspx?sourcedoc=%7B${WORD_GUID}%7D&action=edit`);
		const extPage = await context.newPage();
		await extPage.goto('chrome-extension://' + extensionId + '/src/popup/popup.html');
		await documentPage.bringToFront();

		const result = (await requestArticle(extPage)) as {
			success: boolean;
			readableSurface?: string;
			docxBase64?: string;
			source?: { title: string };
		};

		expect(result.success).toBe(true);
		expect(result.readableSurface).toBe('document-reader');
		// "UEsDBA" is the base64 prefix of the ZIP signature, so this asserts real archive bytes crossed.
		expect(result.docxBase64?.startsWith('UEsDBA')).toBe(true);
		expect(result.source?.title).toBe('Tài liệu');
	});

	test('returns the shared code when the Word Online download is denied', async ({ context, extensionId }) => {
		await context.route('https://onedrive.live.com/personal/denied/_layouts/15/doc.aspx**', (route) =>
			route.fulfill({ contentType: 'text/html; charset=utf-8', body: WORD_PAGE_BODY }),
		);
		await context.route(`https://onedrive.live.com/personal/denied/_layouts/15/download.aspx?UniqueId=${WORD_GUID}`, (route) =>
			route.fulfill({ status: 403, contentType: 'text/plain; charset=utf-8', body: '' }),
		);

		const documentPage = await context.newPage();
		await documentPage.goto(`https://onedrive.live.com/personal/denied/_layouts/15/doc.aspx?sourcedoc=%7B${WORD_GUID}%7D`);
		const extPage = await context.newPage();
		await extPage.goto('chrome-extension://' + extensionId + '/src/popup/popup.html');
		await documentPage.bringToFront();

		await expect(requestArticle(extPage)).resolves.toEqual({
			success: false,
			error: 'wordOnlineDownloadUnavailable',
		});
	});
```

- [ ] **Step 2: Build, then run the tests**

Run: `pnpm build:chrome && npx playwright test tests/e2e/reader.spec.ts`
Expected: PASS, including the pre-existing tests in the file

The build is not optional. Playwright loads the extension from `dist/chrome`, so running against a stale build tests the previous code and can report a false pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/reader.spec.ts
git commit -m "test: cover Word Online extraction end-to-end"
```

---

### Task 9: Full verification

**Files:**
- No production changes. This task proves the feature and its central architectural claim.

**Interfaces:**
- Consumes: everything from Tasks 1-8
- Produces: nothing

- [ ] **Step 1: Run the whole unit suite**

Run: `pnpm test:unit`
Expected: PASS, no failures

- [ ] **Step 2: Build both targets**

Run: `pnpm build`
Expected: chrome and firefox builds complete with no `tsc` errors

- [ ] **Step 3: Confirm JSZip did not reach the content script**

Run:

```bash
ls -l dist/chrome/content_script.js dist/chrome/background.js
```

Expected: `content_script.js` is under 80 KB, against a 66 KB baseline. If it grew past that, JSZip was pulled into the page bundle and the whole reason for parsing in the background is defeated — trace the import chain from `word_online_extractor.ts` before continuing.

Record the `background.js` size in the commit message. `docx_extractor.ts` imports `normalizeChapterText` from `epub_extractor.ts`, which imports JSZip at module scope, so whether the archive code is included once or twice is measured here rather than assumed.

- [ ] **Step 4: Confirm the manifest did not change**

Run:

```bash
pnpm validate:manifest && git diff --stat main -- public/manifest.json
```

Expected: the validator passes and `git diff --stat` prints nothing. This feature adds no permission and no host permission; any diff here means something was added that the design forbids.

- [ ] **Step 5: Run the full end-to-end suite**

Run: `pnpm test:e2e`
Expected: PASS. The build from Step 2 satisfies the rebuild requirement.

- [ ] **Step 6: Lint and check whitespace**

Run: `npx biome check <the files this task touched>`
Expected: no new errors. `pnpm lint` across the repo already fails with 118 pre-existing errors (see Global Constraints), so a whole-repo run proves nothing here.

Run: `git diff --check main`
Expected: no output

- [ ] **Step 7: Commit the verification record**

```bash
git commit --allow-empty -m "chore: verify Word Online reading

content_script.js <size>, background.js <size>.
Unit, e2e, and lint all pass."
```

---

## Manual Check Before Merge

Automated tests use route mocks and never touch a Microsoft account. One manual pass is still worth doing, because the probe only measured personal OneDrive:

1. Open a Word document on `onedrive.live.com` while signed in. Click **Read current page**. The document text should be spoken, without menus or toolbars.
2. Open a Word document on a real `*.sharepoint.com` tenant, if one is available. This branch is unverified by design — the spec records it under "Known Gaps".
3. Open an Excel document through the same `Doc.aspx` route. Expect the localized failure message, not spoken garbage.
4. Open a normal article and a Google Doc. Both must behave exactly as before.
