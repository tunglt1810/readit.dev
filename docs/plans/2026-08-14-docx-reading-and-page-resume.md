# DOCX Reading & Page-Based Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Document Reader open local `.docx` files, and give local PDF and DOCX a resume-after-restart position expressed as a page number.

**Architecture:** `createEpubSession` already consumes a format-agnostic book interface, so PDF and DOCX are modelled as single-chapter books carrying a list of page-start character offsets. The `epub_*` session and progress modules are renamed to `book_*` (identifiers only — persisted storage keys stay put), and the reader's previous/next buttons become page jumps when the open book has pages instead of chapters.

**Tech Stack:** TypeScript, React 19, `jszip` (already a dependency), `pdfjs-dist`, `node:test` for unit tests, Playwright for e2e, Biome for lint.

**Spec:** `docs/specs/2026-08-14-docx-reading-and-page-resume-design.md`

## Global Constraints

- **No new dependencies.** DOCX parsing uses `jszip` and `DOMParser`, both already in use by `src/shared/epub_extractor.ts`.
- **No new manifest permission.**
- **Persisted keys are frozen.** `STORAGE_KEYS.EPUB_PROGRESS` keeps the value `readit_epub_progress`; the IndexedDB database stays named `readit-epub-library` with store `handles` and key `current-book`. Renaming any of them orphans readers who are partway through a book.
- **Backward-compatible records.** A `BookProgressRecord` saved by the current release has no `totalChars`; it must still load.
- **EPUB behaviour is unchanged.** Every existing test in `tests/unit/epub_session.test.ts` (renamed) and `tests/e2e/epub-reading.spec.ts` must keep passing with the same assertions.
- **Tabs, not spaces.** Biome config in `biome.json` governs; run `pnpm lint` before every commit.
- **Commands:** unit tests `node --experimental-strip-types --test tests/unit/<file>.test.ts`; whole unit suite `pnpm test:unit`; typecheck `npx tsc`; lint `pnpm lint`; e2e `npx playwright test tests/e2e/<file>.spec.ts`.
- **Docs are written in English**, chat and commit bodies may be Vietnamese-free English; follow the repo's existing English-only docs convention.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/shared/book_source.ts` | The `BookSource` interface shared by all three formats |
| `src/shared/virtual_pages.ts` | `computeVirtualPageStarts()` — pure paginator for text with no real pages |
| `src/shared/docx_extractor.ts` | `.docx` → title/lang/text, plus `DocxError` |
| `src/reader/book_source_loader.ts` | Turns a picked `File` + kind into a `BookSource` |
| `src/reader/book_session.ts` | Renamed from `epub_session.ts`, plus page mode |
| `src/shared/book_progress_store.ts` | Renamed from `epub_progress_store.ts`, plus `totalChars` |
| `tests/unit/virtual_pages.test.ts` | |
| `tests/unit/docx_extractor.test.ts` | |
| `tests/unit/book_source_loader.test.ts` | |
| `tests/e2e/docx_fixture.ts` | Builds a `.docx` archive in memory, mirroring `epub_fixture.ts` |
| `tests/e2e/reader_stubs.ts` | `stubFilePicker` / `stubPlaybackRuntime`, extracted from `epub-reading.spec.ts` |
| `tests/e2e/docx-reading.spec.ts` | |

**Modified:** `src/shared/constants.ts`, `src/shared/i18n.ts`, `src/shared/locales/{en,vi}.json`, `src/shared/epub_extractor.ts`, `src/background/pdf_extractor.ts`, `src/reader/book_loader.ts`, `src/reader/App.tsx`, `tests/unit/{epub_session,epub_progress_store,pdf_extractor,book_loader}.test.ts`, `tests/e2e/epub-reading.spec.ts`, `CHANGELOG.md`, `README.md`.

**Deleted:** `src/reader/epub_session.ts`, `src/shared/epub_progress_store.ts` (via `git mv`).

---

### Task 1: Rename `epub_*` session and progress modules to `book_*`

Pure rename, no behaviour change. Done first so every later task writes against the final names.

**Files:**
- Create (via `git mv`): `src/reader/book_session.ts`, `src/shared/book_progress_store.ts`
- Create: `src/shared/book_source.ts`
- Modify: `src/shared/epub_extractor.ts`, `src/reader/App.tsx`
- Test (via `git mv`): `tests/unit/book_session.test.ts`, `tests/unit/book_progress_store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BookSource` (in `src/shared/book_source.ts`); `createBookSession(dependencies: BookSessionDependencies): BookSession` and `BookSession` (in `src/reader/book_session.ts`); `BookProgressRecord`, `BookHandleRecord`, `saveBookProgress`, `loadBookProgress`, `clearBookProgress`, `matchesSavedFile`, `putBookHandle`, `getBookHandle`, `clearBookHandle` (in `src/shared/book_progress_store.ts`).

- [ ] **Step 1: Move the files with git so history follows**

```bash
git mv src/reader/epub_session.ts src/reader/book_session.ts
git mv src/shared/epub_progress_store.ts src/shared/book_progress_store.ts
git mv tests/unit/epub_session.test.ts tests/unit/book_session.test.ts
git mv tests/unit/epub_progress_store.test.ts tests/unit/book_progress_store.test.ts
```

- [ ] **Step 2: Create the shared book interface**

Create `src/shared/book_source.ts`:

```ts
/**
 * What the reader needs from a book, whatever format it came from. EPUB supplies many chapters;
 * PDF and DOCX supply exactly one and describe their pages with `pageStarts` instead.
 */
export interface BookSource {
	title: string;
	lang: string;
	chapterCount: number;
	getChapterText(index: number): Promise<string>;
	/** Character offsets where each page starts inside chapter 0's text. Single-chapter books only. */
	pageStarts?: readonly number[];
}
```

- [ ] **Step 3: Point `epub_extractor.ts` at it**

In `src/shared/epub_extractor.ts`, replace the `EpubBook` interface declaration (lines 19-24) with a re-export-free alias so existing EPUB call sites keep reading naturally:

```ts
import type { BookSource } from './book_source.ts';

export type EpubBook = BookSource;
```

Keep `openEpubBook`'s return type as `Promise<EpubBook>`.

- [ ] **Step 4: Rename the identifiers inside the moved files**

In `src/reader/book_session.ts`: `EpubSessionDependencies` → `BookSessionDependencies`, `EpubSession` → `BookSession`, `createEpubSession` → `createBookSession`. Change its imports to `import type { BookSource } from '../shared/book_source.ts';` (the `book` dependency is typed `BookSource`) and `import type { BookProgressRecord } from '../shared/book_progress_store.ts';`. `EpubProgressRecord` → `BookProgressRecord` throughout. The comment above `adopt` mentioning the Reader tab stays as is.

In `src/shared/book_progress_store.ts`: `EpubProgressRecord` → `BookProgressRecord`, `EpubBookHandleRecord` → `BookHandleRecord`, `isEpubProgressRecord` → `isBookProgressRecord`, `saveEpubProgress` → `saveBookProgress`, `loadEpubProgress` → `loadBookProgress`, `clearEpubProgress` → `clearBookProgress`, `putEpubBookHandle` → `putBookHandle`, `getEpubBookHandle` → `getBookHandle`, `clearEpubBookHandle` → `clearBookHandle`. `matchesSavedFile` keeps its name.

**Do not touch** these three lines — they are the persisted contract:

```ts
const DATABASE_NAME = 'readit-epub-library';
const STORE_NAME = 'handles';
const CURRENT_BOOK_KEY = 'current-book';
```

…nor `STORAGE_KEYS.EPUB_PROGRESS` in `src/shared/constants.ts`. Update the two error strings inside `openDatabase`/`withStore` from "EPUB library" to "book library" wording only if they are not asserted on by tests (they are not).

- [ ] **Step 5: Update the two test files to the new names**

In `tests/unit/book_session.test.ts`: import `createBookSession` from `'../../src/reader/book_session.ts'`, `BookSource` from `'../../src/shared/book_source.ts'`, `BookProgressRecord` from `'../../src/shared/book_progress_store.ts'`; rename `fakeBook`'s return type to `BookSource`. Assertions stay identical.

In `tests/unit/book_progress_store.test.ts`: import the renamed functions and `BookProgressRecord`. The literal `storage.values.readit_epub_progress` in the malformed-record test **stays** — it is asserting the frozen storage key.

- [ ] **Step 6: Update `App.tsx` imports and call sites**

In `src/reader/App.tsx`, update the import blocks at lines 26-34 and rename every use: `EpubProgressRecord` → `BookProgressRecord`, `getEpubBookHandle` → `getBookHandle`, `loadEpubProgress` → `loadBookProgress`, `putEpubBookHandle` → `putBookHandle`, `saveEpubProgress` → `saveBookProgress`, `createEpubSession` → `createBookSession`, `EpubSession` → `BookSession`. Local variable names (`epubSession`, `epubSessionRef`, `openEpubSession`, `startEpubBook`) are renamed in Task 8 when their behaviour changes; leaving them for now keeps this diff mechanical.

- [ ] **Step 7: Verify nothing broke**

Run: `npx tsc && pnpm test:unit && pnpm lint`
Expected: typecheck clean, all unit tests PASS, lint clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: rename epub session and progress modules to book_*"
```

---

### Task 2: Virtual pagination helper

**Files:**
- Create: `src/shared/virtual_pages.ts`
- Test: `tests/unit/virtual_pages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeVirtualPageStarts(text: string, targetChars?: number): number[]` — offsets into `text`, always starting with `0`, strictly increasing, each offset landing on the first character after a `\n\n` separator.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/virtual_pages.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeVirtualPageStarts } from '../../src/shared/virtual_pages.ts';

/** Paragraphs of a known length, so expected offsets can be computed by hand. */
function paragraphs(count: number, length: number): string {
	return Array.from({ length: count }, (_, index) => `${index}`.padEnd(length, 'x')).join('\n\n');
}

test('text shorter than one page is a single page', () => {
	assert.deepEqual(computeVirtualPageStarts('One short paragraph.', 1800), [0]);
});

test('empty text is still one page', () => {
	assert.deepEqual(computeVirtualPageStarts('', 1800), [0]);
});

test('pages break at paragraph boundaries once the target is reached', () => {
	// Four 100-character paragraphs joined by "\n\n": each block costs 102 characters. With a
	// 150-character target, two paragraphs fill a page — one is short of the target, three overshoot it.
	const text = paragraphs(4, 100);
	assert.deepEqual(computeVirtualPageStarts(text, 150), [0, 204]);
});

test('every start lands on the first character of a paragraph', () => {
	const text = paragraphs(20, 90);
	for (const start of computeVirtualPageStarts(text, 200)) {
		assert.equal(start === 0 || text.slice(start - 2, start) === '\n\n', true, `bad start ${start}`);
	}
});

test('starts are strictly increasing', () => {
	const starts = computeVirtualPageStarts(paragraphs(30, 70), 300);
	for (let index = 1; index < starts.length; index++) {
		assert.equal(starts[index] > starts[index - 1], true);
	}
});

test('a paragraph longer than the target is not split', () => {
	const text = `${'a'.repeat(5000)}\n\nshort tail`;
	assert.deepEqual(computeVirtualPageStarts(text, 1800), [0, 5002]);
});

test('pagination is deterministic', () => {
	const text = paragraphs(25, 80);
	assert.deepEqual(computeVirtualPageStarts(text, 500), computeVirtualPageStarts(text, 500));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/virtual_pages.test.ts`
Expected: FAIL — cannot find module `virtual_pages.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/virtual_pages.ts`:

```ts
const DEFAULT_TARGET_CHARS = 1800;

/**
 * DOCX carries no pagination — Word computes it at layout time — so a document that needs a page
 * number gets evenly sized ones instead. Breaking only at paragraph boundaries keeps a page from
 * starting mid-sentence, and makes the numbering reproducible for the same text.
 */
export function computeVirtualPageStarts(text: string, targetChars = DEFAULT_TARGET_CHARS): number[] {
	const starts = [0];
	let pageStart = 0;
	let cursor = 0;
	while (cursor < text.length) {
		const separator = text.indexOf('\n\n', cursor);
		if (separator === -1) {
			break;
		}
		const nextParagraph = separator + 2;
		// A paragraph longer than the target still ends its page: the break comes after it, not inside.
		if (nextParagraph - pageStart >= targetChars) {
			starts.push(nextParagraph);
			pageStart = nextParagraph;
		}
		cursor = nextParagraph;
	}
	return starts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/virtual_pages.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/virtual_pages.ts tests/unit/virtual_pages.test.ts
git commit -m "feat: add virtual pagination for text without real pages"
```

---

### Task 3: DOCX extractor and its error codes

**Files:**
- Create: `src/shared/docx_extractor.ts`
- Modify: `src/shared/constants.ts`, `src/shared/i18n.ts`, `src/shared/locales/en.json`, `src/shared/locales/vi.json`
- Test: `tests/unit/docx_extractor.test.ts`

**Interfaces:**
- Consumes: `normalizeChapterText(blocks: readonly string[]): string` from `src/shared/epub_extractor.ts` (already exported).
- Produces: `DOCX_ERROR_CODES` and `DocxErrorCode` (in `constants.ts`); `DocxError` with a `code` field, and `extractDocxText(bytes: ArrayBuffer, fallbackTitle: string): Promise<{ title: string; content: string }>` (in `docx_extractor.ts`). Language is not decided here — the caller derives it from the text, as the PDF path does.

- [ ] **Step 1: Add the error codes**

In `src/shared/constants.ts`, after the `EPUB_ERROR_CODES` block (line 20):

```ts
export const DOCX_ERROR_CODES = {
	parseFailed: 'docxParseFailed',
	textUnavailable: 'docxTextUnavailable',
	legacyFormat: 'docLegacyFormat',
} as const;

export type DocxErrorCode = (typeof DOCX_ERROR_CODES)[keyof typeof DOCX_ERROR_CODES];
```

- [ ] **Step 2: Add the translations**

In `src/shared/locales/en.json`, beside the other book strings (after `"epubFileAccessDenied"`):

```json
	"docxParseFailed": "This DOCX could not be read. It may be corrupted or in an unsupported format.",
	"docxTextUnavailable": "No readable text was found in this document.",
	"docLegacyFormat": "Word 97-2003 .doc files are not supported. Save the file as .docx and try again.",
```

In `src/shared/locales/vi.json`, at the same position:

```json
	"docxParseFailed": "Không thể đọc tệp DOCX này. Tệp có thể bị hỏng hoặc không được hỗ trợ.",
	"docxTextUnavailable": "Không tìm thấy văn bản có thể đọc trong tài liệu này.",
	"docLegacyFormat": "Tệp .doc của Word 97-2003 chưa được hỗ trợ. Hãy lưu lại thành .docx rồi thử lại.",
```

- [ ] **Step 3: Wire the codes into `i18n.ts`**

In `src/shared/i18n.ts`, add `DOCX_ERROR_CODES` to the import from `./constants.ts` and three cases to `getPlaybackErrorTranslationKey`, after the EPUB cases:

```ts
		case DOCX_ERROR_CODES.parseFailed:
			return 'docxParseFailed';
		case DOCX_ERROR_CODES.textUnavailable:
			return 'docxTextUnavailable';
		case DOCX_ERROR_CODES.legacyFormat:
			return 'docLegacyFormat';
```

- [ ] **Step 4: Write the failing test**

Create `tests/unit/docx_extractor.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { DOCX_ERROR_CODES } from '../../src/shared/constants.ts';
import { DocxError, extractDocxText } from '../../src/shared/docx_extractor.ts';

const NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx is a ZIP; only word/document.xml is ever read, plus docProps/core.xml for the title. */
async function buildDocx(bodyXml: string, coreXml?: string): Promise<ArrayBuffer> {
	const archive = new JSZip();
	archive.file('word/document.xml', `<?xml version="1.0"?><w:document ${NAMESPACE}><w:body>${bodyXml}</w:body></w:document>`);
	if (coreXml) {
		archive.file('docProps/core.xml', coreXml);
	}
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function paragraph(...runs: string[]): string {
	return `<w:p>${runs.map((run) => `<w:r><w:t>${run}</w:t></w:r>`).join('')}</w:p>`;
}

test('paragraphs are joined into blocks in document order', async () => {
	const bytes = await buildDocx(`${paragraph('First paragraph.')}${paragraph('Second paragraph.')}`);
	const result = await extractDocxText(bytes, 'Report.docx');
	assert.equal(result.content, 'First paragraph.\n\nSecond paragraph.');
});

test('runs inside one paragraph stay on one line', async () => {
	const bytes = await buildDocx(paragraph('Split ', 'across ', 'runs.'));
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Split across runs.');
});

test('tabs and line breaks become spaces', async () => {
	const bytes = await buildDocx(`<w:p><w:r><w:t>Left</w:t><w:tab/><w:t>Right</w:t><w:br/><w:t>Below</w:t></w:r></w:p>`);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Left Right Below');
});

test('text inside a table is read in place', async () => {
	const cell = (value: string) => `<w:tc>${paragraph(value)}</w:tc>`;
	const bytes = await buildDocx(`${paragraph('Before the table.')}<w:tbl><w:tr>${cell('Cell A')}${cell('Cell B')}</w:tr></w:tbl>`);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Before the table.\n\nCell A\n\nCell B');
});

test('empty paragraphs are dropped', async () => {
	const bytes = await buildDocx(`${paragraph('Text.')}<w:p/>${paragraph('   ')}${paragraph('More.')}`);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).content, 'Text.\n\nMore.');
});

test('the core properties title wins over the file name', async () => {
	const core = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly Report</dc:title></cp:coreProperties>`;
	const bytes = await buildDocx(paragraph('Body text.'), core);
	assert.equal((await extractDocxText(bytes, 'Report.docx')).title, 'Quarterly Report');
});

test('a document with no title falls back to the file name', async () => {
	const bytes = await buildDocx(paragraph('Body text.'));
	assert.equal((await extractDocxText(bytes, 'Report.docx')).title, 'Report.docx');
});

test('a corrupt archive reports a parse failure', async () => {
	await assert.rejects(
		() => extractDocxText(new Uint8Array([1, 2, 3, 4]).buffer, 'Broken.docx'),
		(error: unknown) => error instanceof DocxError && error.code === DOCX_ERROR_CODES.parseFailed,
	);
});

test('an archive without word/document.xml reports a parse failure', async () => {
	const archive = new JSZip();
	archive.file('docProps/core.xml', '<x/>');
	const buffer = await archive.generateAsync({ type: 'nodebuffer' });
	await assert.rejects(
		() => extractDocxText(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, 'Odd.docx'),
		(error: unknown) => error instanceof DocxError && error.code === DOCX_ERROR_CODES.parseFailed,
	);
});

test('a document with no text reports that text is unavailable', async () => {
	const bytes = await buildDocx(`<w:p/><w:p/>`);
	await assert.rejects(
		() => extractDocxText(bytes, 'Images.docx'),
		(error: unknown) => error instanceof DocxError && error.code === DOCX_ERROR_CODES.textUnavailable,
	);
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/docx_extractor.test.ts`
Expected: FAIL — cannot find module `docx_extractor.ts`.

- [ ] **Step 6: Write the implementation**

`epub_extractor.ts` parses with `DOMParser` because EPUB chapters are real XHTML with nested inline markup. DOCX needs far less: paragraph boundaries and the text inside `w:t`. A regex walk over the XML covers that, and it keeps the extractor runnable under `node --experimental-strip-types --test`, which has no `DOMParser` — the alternative would be adding jsdom as a dependency, which the Global Constraints forbid.

Create `src/shared/docx_extractor.ts`:

```ts
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
```

The extractor deliberately reports no language: a `.docx` can declare `w:lang` per run, and those declarations describe the spell-checker's opinion rather than the document's. The caller runs `detectContentLanguage` over the extracted text instead, exactly as the PDF path does.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/docx_extractor.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 8: Verify the whole suite and lint**

Run: `npx tsc && pnpm test:unit && pnpm lint`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/shared/docx_extractor.ts src/shared/constants.ts src/shared/i18n.ts src/shared/locales tests/unit/docx_extractor.test.ts
git commit -m "feat: extract text from DOCX documents"
```

---

### Task 4: Recognise `.docx` and `.doc` in the file picker

**Files:**
- Modify: `src/reader/book_loader.ts:4-40`
- Test: `tests/unit/book_loader.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type BookKind = 'epub' | 'pdf' | 'docx'`; `detectBookKind(fileName: string): BookKind | 'doc-legacy' | null`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/book_loader.test.ts`, inside the existing `detectBookKind` test or as new tests beside it:

```ts
test('detectBookKind recognises DOCX', () => {
	assert.equal(detectBookKind('report.docx'), 'docx');
	assert.equal(detectBookKind('REPORT.DOCX'), 'docx');
});

test('detectBookKind names legacy .doc rather than rejecting it silently', () => {
	assert.equal(detectBookKind('report.doc'), 'doc-legacy');
	assert.equal(detectBookKind('REPORT.DOC'), 'doc-legacy');
});

test('detectBookKind does not mistake a .docx-like name for DOCX', () => {
	assert.equal(detectBookKind('archive.docx.zip'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/book_loader.test.ts`
Expected: FAIL — `'report.docx'` currently returns `null`.

- [ ] **Step 3: Write the implementation**

In `src/reader/book_loader.ts`, replace lines 4 and 17-23:

```ts
export type BookKind = 'epub' | 'pdf' | 'docx';

/** `.doc` is named rather than lumped in with unknown files, so the caller can explain itself. */
export function detectBookKind(fileName: string): BookKind | 'doc-legacy' | null {
	const lowered = fileName.toLowerCase();
	if (lowered.endsWith('.epub')) {
		return 'epub';
	}
	if (lowered.endsWith('.pdf')) {
		return 'pdf';
	}
	if (lowered.endsWith('.docx')) {
		return 'docx';
	}
	return lowered.endsWith('.doc') ? 'doc-legacy' : null;
}
```

And extend the picker's accepted types (line 34):

```ts
			const [handle] = await picker({
				multiple: false,
				types: [
					{
						description: 'Books',
						accept: {
							'application/epub+zip': ['.epub'],
							'application/pdf': ['.pdf'],
							'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
							// Selectable on purpose: a .doc the reader can pick and be told about beats one
							// greyed out for no visible reason.
							'application/msword': ['.doc'],
						},
					},
				],
			});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/book_loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reader/book_loader.ts tests/unit/book_loader.test.ts
git commit -m "feat: accept .docx in the book picker and name legacy .doc"
```

---

### Task 5: Report PDF page boundaries

**Files:**
- Modify: `src/background/pdf_extractor.ts:29-31,148-186`
- Test: `tests/unit/pdf_extractor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PdfArticleResponse`'s success variant gains `pageStarts: number[]` — offsets into `article.content` where each extracted page begins, always starting with `0`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/pdf_extractor.test.ts`, following the shape of the existing `extractPdfArticleFromBytes` tests in that file (they build a fake document via the `loadDocument` dependency):

```ts
test('page starts mark where each extracted page begins in the joined text', async () => {
	const pages = ['First page text.', 'Second page text.', 'Third page text.'];
	const response = await extractPdfArticleFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'Paged.pdf', {
		loadDocument: async () => ({
			numPages: pages.length,
			getMetadata: async () => ({}),
			getPage: async (pageNumber: number) => ({
				getTextContent: async () => ({ items: [{ str: pages[pageNumber - 1] }] }),
			}),
			destroy: async () => undefined,
		}),
	});

	assert.equal(response.success, true);
	if (!response.success) return;
	// "First page text." is 16 characters; the "\n\n" joining it to the next page costs two more.
	assert.deepEqual(response.pageStarts, [0, 18, 37]);
	for (const [index, start] of response.pageStarts.entries()) {
		assert.equal(response.article.content.slice(start, start + pages[index].length), pages[index]);
	}
});

test('pages with no extractable text do not get a page start', async () => {
	const pages = ['First page text.', '', 'Third page text.'];
	const response = await extractPdfArticleFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'Gappy.pdf', {
		loadDocument: async () => ({
			numPages: pages.length,
			getMetadata: async () => ({}),
			getPage: async (pageNumber: number) => ({
				getTextContent: async () => ({ items: [{ str: pages[pageNumber - 1] }] }),
			}),
			destroy: async () => undefined,
		}),
	});

	assert.equal(response.success, true);
	if (!response.success) return;
	assert.deepEqual(response.pageStarts, [0, 18]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/pdf_extractor.test.ts`
Expected: FAIL — `response.pageStarts` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/background/pdf_extractor.ts`, widen the response type (line 29):

```ts
export type PdfArticleResponse =
	| { success: true; article: Article; readableSurface: 'document-reader'; pageStarts: number[] }
	| { success: false; error: PdfErrorCode };
```

`pageStarts` lives on the response rather than on `Article` deliberately: `Article` is serialised across `chrome.runtime` messages into the background and offscreen, and page offsets have no business travelling there.

In `extractPdfArticleFromBytes`, track offsets while collecting pages (replacing lines 159-176):

```ts
		const pages: string[] = [];
		const pageStarts: number[] = [];
		let offset = 0;
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			const page = await document.getPage(pageNumber);
			const text = normalizePageText((await page.getTextContent()).items);
			if (!text) continue;
			// Pages are joined with a blank line, which every page after the first must pay for.
			pageStarts.push(offset);
			offset += text.length + 2;
			pages.push(text);
		}
		const content = pages.join('\n\n');
		if (!content) return extractionFailure(PDF_ERROR_CODES.textUnavailable);
		return {
			success: true,
			article: {
				title: documentTitle(metadata, { url, title }),
				content,
				url,
				lang: detectContentLanguage(content, 'na'),
			},
			readableSurface: 'document-reader',
			pageStarts,
		};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/pdf_extractor.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Check the background caller still typechecks**

Run: `npx tsc`
Expected: clean. `extractPdfArticle` returns the same object it built before plus one field, and `src/background/background.ts` reads only `success`, `article` and `readableSurface`. If the compiler flags a construction site of a `success: true` response that now lacks `pageStarts`, add `pageStarts: []` there.

- [ ] **Step 6: Commit**

```bash
git add src/background/pdf_extractor.ts tests/unit/pdf_extractor.test.ts
git commit -m "feat: report page boundaries from PDF extraction"
```

---

### Task 6: Page mode in the book session

**Files:**
- Modify: `src/reader/book_session.ts`, `src/shared/book_progress_store.ts`
- Test: `tests/unit/book_session.test.ts`, `tests/unit/book_progress_store.test.ts`

**Interfaces:**
- Consumes: `BookSource` (Task 1), `BookProgressRecord` (Task 1).
- Produces: `BookSession.state(): { kind: 'chapter' | 'page'; index: number; count: number }`; `BookProgressRecord.totalChars?: number`.

> **Breaking change to watch:** `state()` no longer returns `{ chapterIndex, chapterCount }`. `App.tsx` reads those two properties in four places; Task 8 updates them. Until then `npx tsc` will fail on `App.tsx` — that is expected within this task, and Step 7 below patches the call sites minimally so the tree stays green.

- [ ] **Step 1: Write the failing tests for page mode**

Append to `tests/unit/book_session.test.ts`:

```ts
/** PDF and DOCX arrive as one chapter that knows where its pages begin. */
function pagedHarness(text: string, pageStarts: number[]) {
	const started: { title: string; content: string; lang: string }[] = [];
	const saved: BookProgressRecord[] = [];
	const session = createBookSession({
		book: { title: 'Report', lang: 'en', chapterCount: 1, getChapterText: async () => text, pageStarts },
		file: { name: 'report.pdf', size: 42, lastModified: 7 },
		startChapter: async (payload) => {
			started.push(payload);
			return { success: true, sessionId: `session-${started.length}` };
		},
		saveProgress: async (record) => {
			saved.push(record);
		},
		now: () => 1_700_000_000_000,
	});
	return { session, started, saved };
}

const PAGED_TEXT = 'Page one text.\n\nPage two text.\n\nPage three text.';
const PAGED_STARTS = [0, 16, 32];

test('a paged book reports pages instead of chapters', async () => {
	const { session } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.deepEqual(session.state(), { kind: 'page', index: 0, count: 3 });
});

test('a book without page starts still reports chapters', async () => {
	const { session } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.deepEqual(session.state(), { kind: 'chapter', index: 0, count: 2 });
});

test('advancing a paged book plays from the next page start', async () => {
	const { session, started } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });

	assert.equal(await session.advance(), true);
	assert.equal(started[1].content, 'Page two text.\n\nPage three text.');
	assert.deepEqual(session.state(), { kind: 'page', index: 1, count: 3 });
});

test('going back a page plays from the previous page start', async () => {
	const { session, started } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: PAGED_STARTS[2] });
	assert.deepEqual(session.state(), { kind: 'page', index: 2, count: 3 });

	assert.equal(await session.previous(), true);
	assert.equal(started[1].content, 'Page two text.\n\nPage three text.');
	assert.deepEqual(session.state(), { kind: 'page', index: 1, count: 3 });
});

test('advancing past the last page reports the document is finished', async () => {
	const { session } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: PAGED_STARTS[2] });
	assert.equal(await session.advance(), false);
});

test('going back from the first page leaves playback alone', async () => {
	const { session, started } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.previous(), false);
	assert.equal(started.length, 1);
});

test('the reported page follows the position being read', async () => {
	const { session } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });

	// A word being read partway through page two, reported against the slice that is playing.
	session.recordPosition(PAGED_STARTS[1] + 5);
	assert.deepEqual(session.state(), { kind: 'page', index: 1, count: 3 });
});

test('a paged book persists the total length so progress can be shown as a percentage', async () => {
	const { session, saved } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	session.recordPosition(PAGED_STARTS[1]);
	await session.flush();

	assert.equal(saved.at(-1)?.totalChars, PAGED_TEXT.length);
	assert.equal(saved.at(-1)?.charOffset, PAGED_STARTS[1]);
});

test('an empty page list falls back to chapter reporting', async () => {
	const { session } = pagedHarness(PAGED_TEXT, []);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.deepEqual(session.state(), { kind: 'chapter', index: 0, count: 1 });
});
```

Update the existing tests that call `session.state().chapterIndex` (there are six) to `session.state().index`.

- [ ] **Step 2: Write the failing test for the store**

Append to `tests/unit/book_progress_store.test.ts`:

```ts
test('a record saved before totalChars existed still loads', async () => {
	const storage = installStorageStub();
	// Exactly what the previous release wrote: no totalChars field at all.
	storage.values.readit_epub_progress = {
		title: 'Moby Dick',
		chapterIndex: 3,
		charOffset: 1200,
		totalChapters: 40,
		fileSize: 900_000,
		fileLastModified: 1_700_000_000_000,
		updatedAt: 1_700_000_500_000,
	};

	const loaded = await loadBookProgress();
	assert.equal(loaded?.charOffset, 1200);
	assert.equal(loaded?.totalChars, undefined);
});

test('a record with a malformed totalChars is rejected', async () => {
	const storage = installStorageStub();
	storage.values.readit_epub_progress = { ...record, totalChars: 'lots' };
	assert.equal(await loadBookProgress(), null);
});

test('totalChars round-trips when present', async () => {
	installStorageStub();
	await saveBookProgress({ ...record, totalChars: 48_000 });
	assert.equal((await loadBookProgress())?.totalChars, 48_000);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `node --experimental-strip-types --test tests/unit/book_session.test.ts tests/unit/book_progress_store.test.ts`
Expected: FAIL — `state()` returns the old shape; `totalChars` is not a known property.

- [ ] **Step 4: Add `totalChars` to the record**

In `src/shared/book_progress_store.ts`, add the field to the interface after `totalChapters`:

```ts
	/** Length of the text the offset points into. Absent on records written before pages existed. */
	totalChars?: number;
```

And to `isBookProgressRecord`, before the closing parenthesis of the boolean expression:

```ts
		(record.totalChars === undefined || Number.isFinite(record.totalChars)) &&
```

- [ ] **Step 5: Implement page mode in the session**

In `src/reader/book_session.ts`:

Change the `state()` signature in the `BookSession` interface:

```ts
	/** Where the reader is: a chapter for EPUB, a page for single-chapter documents. */
	state(): { kind: 'chapter' | 'page'; index: number; count: number };
```

Inside `createBookSession`, after `const { book, file } = dependencies;`, add the page-mode helpers and a `chapterLength` the record needs:

```ts
	// A document with page starts is one chapter long; its navigation unit is the page.
	const pageStarts = book.chapterCount === 1 && book.pageStarts?.length ? [...book.pageStarts] : null;
	let totalChars: number | undefined;

	/** The page containing an offset: the last start at or before it. */
	const pageIndexAt = (offset: number): number => {
		if (!pageStarts) {
			return 0;
		}
		let low = 0;
		let high = pageStarts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (pageStarts[middle] <= offset) {
				low = middle;
			} else {
				high = middle - 1;
			}
		}
		return low;
	};
```

In `playChapter`, record the full text length once it is known — insert after `const text = (await chapterText(index)).trim();` and its emptiness check:

```ts
		totalChars = text.length;
```

In `buildRecord`, include it:

```ts
		totalChars,
```

Replace the returned `advance`, `previous` and `state` implementations:

```ts
		async advance() {
			if (pageStarts) {
				const next = pageIndexAt(pendingOffset) + 1;
				return next < pageStarts.length ? playChapter(0, pageStarts[next]) : false;
			}
			return seek(chapterIndex + 1, 1);
		},
		async previous() {
			if (pageStarts) {
				const previousPage = pageIndexAt(pendingOffset) - 1;
				return previousPage >= 0 ? playChapter(0, pageStarts[previousPage]) : false;
			}
			return seek(chapterIndex - 1, -1);
		},
```

```ts
		state() {
			return pageStarts
				? { kind: 'page' as const, index: pageIndexAt(pendingOffset), count: pageStarts.length }
				: { kind: 'chapter' as const, index: chapterIndex, count: book.chapterCount };
		},
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --experimental-strip-types --test tests/unit/book_session.test.ts tests/unit/book_progress_store.test.ts`
Expected: PASS.

- [ ] **Step 7: Keep `App.tsx` compiling**

`App.tsx` reads `state().chapterIndex` / `.chapterCount` in `startEpubBook`, the adopt effect, `handleChapterJump`, and the completion handler, and stores them in `chapterState`. Task 8 rewrites this properly; for now change the `chapterState` type to `{ kind: 'chapter' | 'page'; index: number; count: number } | null` and the two JSX readers to `chapterState.index + 1` / `chapterState.count`, plus the disabled conditions to `chapterState.index === 0` and `chapterState.index >= chapterState.count - 1`.

Run: `npx tsc && pnpm test:unit && pnpm lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/reader/book_session.ts src/shared/book_progress_store.ts src/reader/App.tsx tests/unit/book_session.test.ts tests/unit/book_progress_store.test.ts
git commit -m "feat: navigate single-chapter books by page"
```

---

### Task 7: Build a `BookSource` from any picked file

**Files:**
- Create: `src/reader/book_source_loader.ts`
- Test: `tests/unit/book_source_loader.test.ts`

**Interfaces:**
- Consumes: `BookSource` (Task 1), `openEpubBook` (existing), `extractDocxText` (Task 3), `computeVirtualPageStarts` (Task 2), `extractPdfArticleFromBytes` + `PdfArticleResponse` (Task 5), `detectContentLanguage` (existing, `src/shared/language_detection.ts`), `loadPdfJsDocument` (existing, `src/background/pdfjs_loader.ts`).
- Produces: `openBookSource(input: BookSourceInput, dependencies?: BookSourceDependencies): Promise<BookSource>` where `BookSourceInput = { bytes: ArrayBuffer; fileName: string; kind: BookKind }`, and `BookSourceDependencies = { loadPdfDocument: typeof loadPdfJsDocument }`. Throws `PdfSourceError` (carrying a `PdfErrorCode`), `EpubError`, or `DocxError`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/book_source_loader.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
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
	const source = await openBookSource({ bytes: await docxBytes(paragraphs), fileName: 'Report.docx', kind: 'docx' });

	assert.equal(source.chapterCount, 1);
	assert.equal(source.title, 'Report.docx');
	assert.equal((source.pageStarts?.length ?? 0) > 1, true);
	assert.equal(source.pageStarts?.[0], 0);
	assert.equal((await source.getChapterText(0)).startsWith('Paragraph 0'), true);
});

test('a DOCX gets a language detected from its text', async () => {
	const source = await openBookSource({
		bytes: await docxBytes(['Đây là một tài liệu tiếng Việt dùng để kiểm tra nhận diện ngôn ngữ.']),
		fileName: 'Tài liệu.docx',
		kind: 'docx',
	});
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

```

The EPUB branch is not unit-tested here: `openEpubBook` needs a real `DOMParser`, which `node --experimental-strip-types --test` does not provide, and shimming one is not worth it when `tests/e2e/epub-reading.spec.ts` already drives that branch through the real browser parser. `openBookSource` calls `openEpubBook(bytes)` with its default dependencies and returns the result untouched, so there is no adapter logic to cover.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/book_source_loader.test.ts`
Expected: FAIL — cannot find module `book_source_loader.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/reader/book_source_loader.ts`:

```ts
import { extractPdfArticleFromBytes } from '../background/pdf_extractor.ts';
import { loadPdfJsDocument } from '../background/pdfjs_loader.ts';
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

export interface BookSourceDependencies {
	loadPdfDocument: typeof loadPdfJsDocument;
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

export async function openBookSource(
	input: BookSourceInput,
	dependencies: BookSourceDependencies = { loadPdfDocument: loadPdfJsDocument },
): Promise<BookSource> {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/book_source_loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the tree**

Run: `npx tsc && pnpm test:unit && pnpm lint`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/reader/book_source_loader.ts tests/unit/book_source_loader.test.ts
git commit -m "feat: build a book source from any supported local file"
```

---

### Task 8: Wire the reader to one path for all three formats

**Files:**
- Modify: `src/reader/App.tsx`, `src/shared/locales/en.json`, `src/shared/locales/vi.json`

**Interfaces:**
- Consumes: everything produced by Tasks 1-7.
- Produces: no new module exports; three new translation keys `previousPage`, `nextPage`, `pageProgress`.

- [ ] **Step 1: Add the page translations**

`src/shared/locales/en.json`:

```json
	"previousPage": "Previous page",
	"nextPage": "Next page",
	"pageProgress": "Page",
```

`src/shared/locales/vi.json`:

```json
	"previousPage": "Trang trước",
	"nextPage": "Trang sau",
	"pageProgress": "Trang",
```

- [ ] **Step 2: Replace the session opener**

In `src/reader/App.tsx`, replace `openEpubSession` (lines 248-255) with a format-agnostic version, and rename the ref and locals to match:

```ts
	const openBookSession = async (file: File, kind: BookKind): Promise<BookSession> =>
		createBookSession({
			book: await openBookSource({ bytes: await file.arrayBuffer(), fileName: file.name, kind }),
			file: { name: file.name, size: file.size, lastModified: file.lastModified },
			startChapter: (payload) => sendReaderContent(payload),
			saveProgress: saveBookProgress,
			now: () => Date.now(),
		});
```

Rename `epubSessionRef` → `bookSessionRef` and every `epubSession` local → `bookSession`. Update the imports: add `openBookSource, PdfSourceError` from `./book_source_loader.ts`, `DocxError` from `../shared/docx_extractor.ts`, `DOCX_ERROR_CODES` from `../shared/constants.ts`, and `type BookKind` from `./book_loader.ts`; drop the now-unused `extractPdfArticleFromBytes` and `loadPdfJsDocument` imports.

- [ ] **Step 3: Make the resume point format-aware**

`resolveResumePoint` (lines 262-265) guards on `saved.totalChapters === chapterCount`, which is what stops a record numbered by a different chapter list from being trusted. For a paged document the chapter count is always 1, so the guard passes and the character offset is honoured — no change needed. Update only its call sites to read the renamed state:

```ts
	const startBook = async (file: File, kind: BookKind, saved: BookProgressRecord | null): Promise<boolean> => {
		const bookSession = await openBookSession(file, kind);
		bookSessionRef.current = bookSession;
		const state = bookSession.state();
		const from = (state.kind === 'chapter' ? resolveResumePoint(saved, file, state.count) : resolvePagedResumePoint(saved, file)) ?? {
			chapterIndex: 0,
			charOffset: 0,
		};
		if (!(await bookSession.start(from))) {
			bookSessionRef.current = null;
			return false;
		}
		setPositionState(bookSession.state());
		return true;
	};
```

with, beside `resolveResumePoint`:

```ts
	/** A paged document has one chapter, so only the file identity decides whether the offset holds. */
	const resolvePagedResumePoint = (saved: BookProgressRecord | null, file: File) =>
		saved && matchesSavedFile(saved, file) ? { chapterIndex: 0, charOffset: saved.charOffset } : null;
```

Rename `startEpubBook` → `startBook` at both call sites (`handleOpenBook`, `handleResumeBook`).

- [ ] **Step 4: Collapse `handleOpenBook` onto one path**

Replace the body of `handleOpenBook` (lines 318-361):

```ts
	const handleOpenBook = async () => {
		setBookError('');
		const handle = await pickBookFile();
		if (!handle) {
			return;
		}
		const kind = detectBookKind(handle.name);
		if (kind === 'doc-legacy') {
			setBookError(getLocalizedPlaybackError(DOCX_ERROR_CODES.legacyFormat) ?? t('bookOpenFailed'));
			return;
		}
		if (!kind) {
			setBookError(t('bookOpenFailed'));
			return;
		}
		setIsLoadingBook(true);
		try {
			const file = await handle.getFile();
			// Retaining the handle only enables resume; losing it must not block reading.
			await putBookHandle({ handle, fileName: file.name, fileSize: file.size, fileLastModified: file.lastModified }).catch(
				() => undefined,
			);
			if (!(await startBook(file, kind, null))) {
				setBookError(t('bookOpenFailed'));
			}
		} catch (error) {
			setBookError(resolveBookError(error));
		} finally {
			setIsLoadingBook(false);
		}
	};
```

and add, above it:

```ts
	/** Every extractor throws a coded error; anything else is a failure with nothing to say. */
	const resolveBookError = (error: unknown): string =>
		(error instanceof EpubError || error instanceof DocxError || error instanceof PdfSourceError
			? getLocalizedPlaybackError(error.code)
			: undefined) ?? t('bookOpenFailed');
```

Use `resolveBookError(error)` in `handleResumeBook`'s catch block too, replacing its `error instanceof EpubError ? … : …` expression.

- [ ] **Step 5: Make resume and adopt pick the right format**

In `handleResumeBook`, after the handle is loaded and permission is granted, derive the kind and bail if the stored file is no longer supported:

```ts
			const file = await stored.handle.getFile();
			const kind = detectBookKind(stored.fileName);
			if (kind === null || kind === 'doc-legacy') {
				setBookError(t('bookOpenFailed'));
				return;
			}
			if (!(await startBook(file, kind, progress))) {
				setBookError(t('bookOpenFailed'));
			}
```

In the post-reload adopt effect (lines 281-316), do the same before opening the session:

```ts
			const kind = detectBookKind(stored.fileName);
			if (cancelled || kind === null || kind === 'doc-legacy') {
				return;
			}
			const bookSession = await openBookSession(file, kind);
			const state = bookSession.state();
			const resumePoint =
				state.kind === 'chapter' ? resolveResumePoint(progress, file, state.count) : resolvePagedResumePoint(progress, file);
```

The rest of the effect is unchanged apart from the renames and `setPositionState(bookSession.state())`.

- [ ] **Step 6: Rename the position state and drive the buttons from it**

Replace the `chapterState` declaration (line 63):

```ts
	const [positionState, setPositionState] = useState<{ kind: 'chapter' | 'page'; index: number; count: number } | null>(null);
```

Every `setChapterState(...)` becomes `setPositionState(...)`; `setChapterState(null)` becomes `setPositionState(null)`.

Rename `handleChapterJump` → `handlePositionJump` (its body is unchanged apart from `setPositionState(bookSession.state())`).

In the toolbar JSX (lines 458-504), render the two buttons only when there is more than one unit and label them by kind:

```tsx
							{positionState && positionState.count > 1 && (
								<button
									className="btn btn-secondary btn-icon-only btn-previous-chapter"
									type="button"
									disabled={positionState.index === 0}
									aria-label={t(positionState.kind === 'page' ? 'previousPage' : 'previousChapter')}
									title={t(positionState.kind === 'page' ? 'previousPage' : 'previousChapter')}
									onClick={() => handlePositionJump('previous')}
								>
									<PlaybackIcon name="previous" />
								</button>
							)}
```

and the mirrored next button with `disabled={positionState.index >= positionState.count - 1}`, `nextPage`/`nextChapter`, and `btn-next-chapter`. **Keep both class names as they are** — `tests/e2e/epub-reading.spec.ts` selects on `.btn-previous-chapter` and `.btn-next-chapter`.

In the progress block (lines 543-547):

```tsx
							{positionState && (
								<span className="slider-value">
									{t(positionState.kind === 'page' ? 'pageProgress' : 'chapterProgress')} {positionState.index + 1}/
									{positionState.count}
								</span>
							)}
```

- [ ] **Step 7: Show the saved position on the resume button**

Replace the resume button's label (lines 579-580):

```tsx
									{t('resumeReading')}: {savedProgress.title} — {describeSavedProgress(savedProgress)}
```

with, defined beside `resolveBookError`:

```ts
	/** A saved EPUB is a chapter out of many; a saved document is a percentage through one text. */
	const describeSavedProgress = (saved: BookProgressRecord): string => {
		if (saved.totalChapters > 1) {
			return `${t('chapterProgress')} ${saved.chapterIndex + 1}/${saved.totalChapters}`;
		}
		const percentage = saved.totalChars ? Math.round((saved.charOffset / saved.totalChars) * 100) : null;
		return percentage === null ? '' : `${percentage}%`;
	};
```

The saved record has no page list — pages come from re-parsing the file — so the picker screen shows a percentage and the page number appears once the book is open. A record from before this change has no `totalChars` and shows the title alone.

- [ ] **Step 8: Verify**

Run: `npx tsc && pnpm test:unit && pnpm lint`
Expected: all clean.

- [ ] **Step 9: Check it by hand in Chrome**

Run: `pnpm build:chrome`, load `dist/chrome` as an unpacked extension, open the Reader, and confirm:
1. A `.docx` opens and starts reading.
2. Its toolbar shows "Page 1/N"; next/previous move a page and the text changes.
3. Closing and reopening the Reader shows "Continue reading: <title> — NN%", and clicking it resumes mid-document.
4. A `.doc` selected in the picker shows the save-as-.docx message.
5. An EPUB still shows "Chapter 1/N" and behaves exactly as before.

- [ ] **Step 10: Commit**

```bash
git add src/reader/App.tsx src/shared/locales
git commit -m "feat: read and resume DOCX and PDF by page in the Document Reader"
```

---

### Task 9: End-to-end coverage and docs

**Files:**
- Create: `tests/e2e/docx_fixture.ts`, `tests/e2e/reader_stubs.ts`, `tests/e2e/docx-reading.spec.ts`
- Modify: `tests/e2e/epub-reading.spec.ts`, `CHANGELOG.md`, `README.md`

**Interfaces:**
- Consumes: the shipped feature.
- Produces: `buildDocxFixture(paragraphs: string[]): Promise<Buffer>`; `stubFilePicker(page: Page, fileName: string, bytes: Buffer): Promise<void>`; `stubPlaybackRuntime(page: Page): Promise<void>`.

- [ ] **Step 1: Extract the shared stubs**

Move `stubFilePicker` (lines 15-32) and `stubPlaybackRuntime` (lines 34-124) out of `tests/e2e/epub-reading.spec.ts` into a new `tests/e2e/reader_stubs.ts`, exporting both unchanged, and import them back in `epub-reading.spec.ts`.

Run: `npx playwright test tests/e2e/epub-reading.spec.ts`
Expected: PASS, unchanged. Commit this move on its own so a regression here is unambiguous:

```bash
git add tests/e2e/reader_stubs.ts tests/e2e/epub-reading.spec.ts
git commit -m "test: share the reader e2e stubs between book formats"
```

- [ ] **Step 2: Write the DOCX fixture builder**

Create `tests/e2e/docx_fixture.ts`:

```ts
import JSZip from 'jszip';

const NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** Builds a minimal but structurally valid .docx archive in memory. */
export async function buildDocxFixture(paragraphs: string[]): Promise<Buffer> {
	const archive = new JSZip();
	const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
	archive.file('word/document.xml', `<?xml version="1.0"?><w:document ${NAMESPACE}><w:body>${body}</w:body></w:document>`);
	archive.file(
		'docProps/core.xml',
		`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Document</dc:title></cp:coreProperties>`,
	);
	return archive.generateAsync({ type: 'nodebuffer' });
}
```

- [ ] **Step 3: Write the failing e2e spec**

Create `tests/e2e/docx-reading.spec.ts`:

```ts
import type { Page } from '@playwright/test';

import { buildDocxFixture } from './docx_fixture';
import { expect, test } from './fixtures';
import { stubFilePicker, stubPlaybackRuntime } from './reader_stubs';

/** Long enough that the virtual paginator produces several pages. */
const PARAGRAPHS = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${'sample text '.repeat(30)}`);

async function openReaderWithDocument(page: Page, extensionId: string) {
	await stubFilePicker(page, 'fixture.docx', await buildDocxFixture(PARAGRAPHS));
	await stubPlaybackRuntime(page);
	await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
}

test('opens a local DOCX and reads it from the first page', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);

	await reader.locator('.btn-open-book').click();

	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');
	await expect(reader.locator('.document-reader-progress')).toContainText('1/');
});

test('jumps forward a page and back again', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');

	await reader.locator('.btn-next-chapter').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('2/');
	await expect(reader.locator('.document-reader-content')).not.toContainText('Paragraph 0');

	await reader.locator('.btn-previous-chapter').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('1/');
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');
});

test('resumes a document at the page it was left on', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');
	await reader.locator('.btn-next-chapter').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('2/');

	// Drop the playing session so the tab comes back to the picker, as a fresh tab would.
	await reader.evaluate(() => sessionStorage.removeItem('readit-e2e-stub-playback'));
	await reader.reload();

	await expect(reader.locator('.btn-resume-book')).toContainText('Fixture Document');
	await expect(reader.locator('.btn-resume-book')).toContainText('%');
	await reader.locator('.btn-resume-book').click();

	await expect(reader.locator('.document-reader-progress')).toContainText('2/');
});

test('a single-page document shows no page buttons', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(reader, 'short.docx', await buildDocxFixture(['One short paragraph.']));
	await stubPlaybackRuntime(reader);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('One short paragraph.');

	await expect(reader.locator('.btn-next-chapter')).toHaveCount(0);
	await expect(reader.locator('.btn-previous-chapter')).toHaveCount(0);
});
```

- [ ] **Step 4: Run the spec**

Run: `npx playwright test tests/e2e/docx-reading.spec.ts`
Expected: PASS. If the resume test finds no `.btn-resume-book`, the handle was not stored — check that Task 8's `handleOpenBook` calls `putBookHandle` for every format, not just EPUB.

- [ ] **Step 5: Run the whole e2e suite**

Run: `npx playwright test`
Expected: PASS. `tests/e2e/pdf-reading.spec.ts` and `document-reader.spec.ts` must be unaffected.

- [ ] **Step 6: Update the docs**

In `CHANGELOG.md`, add an entry under a new unreleased heading describing: DOCX support in the Document Reader, page-based resume for local PDF and DOCX, and the explicit rejection of legacy `.doc`.

In `README.md`, extend the Document Reader feature description from "EPUB and PDF" to include DOCX, and mention that PDF and DOCX resume by page while EPUB resumes by chapter.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/docx_fixture.ts tests/e2e/docx-reading.spec.ts CHANGELOG.md README.md
git commit -m "test: cover DOCX reading and page resume end to end"
```

- [ ] **Step 8: Refresh the knowledge graph**

Run: `graphify update .`
Expected: the graph picks up the new and renamed modules. Commit any changed files under `graphify-out/`.

---

## Verification Checklist

Before calling the feature done, all of these must hold:

- [ ] `npx tsc` clean
- [ ] `pnpm test:unit` — all files pass, including the renamed EPUB tests with their original assertions
- [ ] `pnpm lint` clean
- [ ] `npx playwright test` — the whole suite passes
- [ ] `pnpm build:chrome` succeeds and the manual checks in Task 8 Step 9 all hold
- [ ] An EPUB whose progress was saved by the previous build still resumes at the right chapter
