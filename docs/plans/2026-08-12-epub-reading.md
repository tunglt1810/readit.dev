# EPUB Reading & Local Book Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user open a local `.epub` or `.pdf` from the Document Reader page, read it aloud with word highlighting, and resume an EPUB at its saved position after a browser restart.

**Architecture:** The Reader page (`src/reader/reader.html`) becomes both loader and display surface. EPUB is parsed there (the MV3 service worker has no `DOMParser`) one chapter at a time; each chapter is dispatched as an independent `document-reader` playback session through the existing unchanged pipeline via a new `START_READER_CONTENT` background message. Chapter chaining is driven by a new `DOCUMENT_READER_COMPLETED` broadcast, because `completedNaturally` never reaches extension pages today. Resume position is persisted as a **character offset** (not a word index) because the word-index→offset mapper needs a TTS-produced word list that does not exist before playback starts.

**Tech Stack:** TypeScript, React 19, Chrome MV3, `jszip` (new), `pdfjs-dist` (existing), `node:test` + `fake-indexeddb` for unit tests, Playwright for e2e.

**Spec:** `docs/specs/2026-08-12-epub-reading-design.md`

## Global Constraints

- **Chrome only.** The entry point renders only when `typeof window.showOpenFilePicker === 'function'`. No Firefox fallback path is built. The Firefox build must remain functional with the button simply absent.
- **No new manifest permission.** Do not edit `public/manifest.json`.
- **Never persist book content.** Only the small progress record and the `FileSystemFileHandle` may be stored. No chapter text in `chrome.storage`, logs, or telemetry.
- **Local PDFs get no persistence and no resume affordance** — identical to today's URL-based PDF behavior.
- Formatting is enforced by Biome: **tabs** for indentation, line width **140**, single quotes. Run `pnpm exec biome check --write <files>` before committing.
- Relative imports include the `.ts`/`.tsx` extension (e.g. `import { t } from '../shared/i18n.ts';`) in `src/**` non-React modules, matching surrounding files.
- Unit tests run with `node --experimental-strip-types --test <file>`; the whole suite is `CI=true pnpm test:unit`.
- User-facing strings live in `src/shared/locales/en.json` and `src/shared/locales/vi.json` (NOT `public/_locales`, which only holds manifest `__MSG_` strings). Every new key must exist in both files.

---

### Task 1: Error codes, storage key, and localized strings

Establishes the vocabulary every later task consumes.

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/i18n.ts:23-37` (`getPlaybackErrorTranslationKey`)
- Modify: `src/shared/locales/en.json`
- Modify: `src/shared/locales/vi.json`
- Test: `tests/unit/epub_i18n.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `EPUB_ERROR_CODES: { parseFailed: 'epubParseFailed'; drmProtected: 'epubDrmProtected'; fileAccessDenied: 'epubFileAccessDenied' }`
  - `type EpubErrorCode = (typeof EPUB_ERROR_CODES)[keyof typeof EPUB_ERROR_CODES]`
  - `STORAGE_KEYS.EPUB_PROGRESS = 'readit_epub_progress'`
  - Translation keys: `epubParseFailed`, `epubDrmProtected`, `epubFileAccessDenied`, `openBook`, `resumeReading`, `chapterProgress`, `bookOpenFailed`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/epub_i18n.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { EPUB_ERROR_CODES, STORAGE_KEYS } from '../../src/shared/constants.ts';
import { getPlaybackErrorTranslationKey } from '../../src/shared/i18n.ts';
import en from '../../src/shared/locales/en.json' with { type: 'json' };
import vi from '../../src/shared/locales/vi.json' with { type: 'json' };

test('every EPUB error code maps to a translation key present in both locales', () => {
	for (const code of Object.values(EPUB_ERROR_CODES)) {
		const key = getPlaybackErrorTranslationKey(code);
		assert.ok(key, `no translation key for ${code}`);
		assert.ok((en as Record<string, unknown>)[key], `missing en string for ${key}`);
		assert.ok((vi as Record<string, unknown>)[key], `missing vi string for ${key}`);
	}
});

test('reader UI labels exist in both locales', () => {
	for (const key of ['openBook', 'resumeReading', 'chapterProgress', 'bookOpenFailed']) {
		assert.ok((en as Record<string, unknown>)[key], `missing en string for ${key}`);
		assert.ok((vi as Record<string, unknown>)[key], `missing vi string for ${key}`);
	}
});

test('the EPUB progress storage key is registered', () => {
	assert.equal(STORAGE_KEYS.EPUB_PROGRESS, 'readit_epub_progress');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/epub_i18n.test.ts`
Expected: FAIL — `EPUB_ERROR_CODES` is not exported from `constants.ts`.

- [ ] **Step 3: Add the codes and storage key**

In `src/shared/constants.ts`, directly below the existing `PdfErrorCode` type export (around line 12):

```ts
export const EPUB_ERROR_CODES = {
	parseFailed: 'epubParseFailed',
	drmProtected: 'epubDrmProtected',
	fileAccessDenied: 'epubFileAccessDenied',
} as const;

export type EpubErrorCode = (typeof EPUB_ERROR_CODES)[keyof typeof EPUB_ERROR_CODES];
```

In the same file, add one entry to the existing `STORAGE_KEYS` object:

```ts
	EPUB_PROGRESS: 'readit_epub_progress',
```

- [ ] **Step 4: Map the codes in i18n**

In `src/shared/i18n.ts`, extend the import on line 1 and add three cases to `getPlaybackErrorTranslationKey`'s switch, before `default`:

```ts
import { EPUB_ERROR_CODES, GOOGLE_DOCS_EXPORT_UNAVAILABLE, PDF_ERROR_CODES } from './constants.ts';
```

```ts
		case EPUB_ERROR_CODES.parseFailed:
			return 'epubParseFailed';
		case EPUB_ERROR_CODES.drmProtected:
			return 'epubDrmProtected';
		case EPUB_ERROR_CODES.fileAccessDenied:
			return 'epubFileAccessDenied';
```

- [ ] **Step 5: Add the strings to both locales**

Append to `src/shared/locales/en.json` (keep the existing key ordering style — put these next to the `pdf*` keys):

```json
	"epubParseFailed": "This EPUB could not be read. It may be corrupted or in an unsupported format.",
	"epubDrmProtected": "This EPUB is DRM-protected and cannot be read.",
	"epubFileAccessDenied": "Access to the book file was denied. Grant access to continue reading.",
	"openBook": "Open book",
	"resumeReading": "Continue reading",
	"chapterProgress": "Chapter",
	"bookOpenFailed": "Could not open this book."
```

Append the same keys to `src/shared/locales/vi.json`:

```json
	"epubParseFailed": "Không thể đọc EPUB này. Tệp có thể bị hỏng hoặc không được hỗ trợ.",
	"epubDrmProtected": "EPUB này có DRM nên không thể đọc.",
	"epubFileAccessDenied": "Quyền truy cập tệp sách bị từ chối. Hãy cấp quyền để đọc tiếp.",
	"openBook": "Mở sách",
	"resumeReading": "Tiếp tục đọc",
	"chapterProgress": "Chương",
	"bookOpenFailed": "Không thể mở sách này."
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/epub_i18n.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/shared/constants.ts src/shared/i18n.ts tests/unit/epub_i18n.test.ts
git add src/shared/constants.ts src/shared/i18n.ts src/shared/locales/en.json src/shared/locales/vi.json tests/unit/epub_i18n.test.ts
git commit -m "feat: add EPUB error codes, progress storage key, and localized strings"
```

---

### Task 2: Reading-position math

Pure offset arithmetic used by both progress saving and resume. Isolated here because it is the one piece of the resume mechanism that is fully testable without a DOM or a browser.

**Files:**
- Create: `src/shared/epub_position.ts`
- Test: `tests/unit/epub_position.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveChapterStart(chapterText: string, charOffset: number): { text: string; baseOffset: number }`
  - `toAbsoluteOffset(baseOffset: number, rangeStart: number): number`

Why both exist: when a chapter is resumed mid-way, the content handed to playback is a *slice*, so the highlight offsets the Reader later computes are relative to that slice. `toAbsoluteOffset` re-adds the slice's base so repeated resumes do not drift backwards toward the chapter start.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/epub_position.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChapterStart, toAbsoluteOffset } from '../../src/shared/epub_position.ts';

const chapter = 'First sentence. Second sentence. Third sentence.';

test('a zero offset returns the whole chapter', () => {
	assert.deepEqual(resolveChapterStart(chapter, 0), { text: chapter, baseOffset: 0 });
});

test('a mid-chapter offset slices from that character', () => {
	const offset = chapter.indexOf('Second');
	assert.deepEqual(resolveChapterStart(chapter, offset), { text: 'Second sentence. Third sentence.', baseOffset: offset });
});

test('an offset past the end of the chapter restarts the chapter', () => {
	assert.deepEqual(resolveChapterStart(chapter, chapter.length + 50), { text: chapter, baseOffset: 0 });
});

test('a negative or non-finite offset restarts the chapter', () => {
	assert.deepEqual(resolveChapterStart(chapter, -5), { text: chapter, baseOffset: 0 });
	assert.deepEqual(resolveChapterStart(chapter, Number.NaN), { text: chapter, baseOffset: 0 });
});

test('absolute offsets are rebased onto the slice base', () => {
	assert.equal(toAbsoluteOffset(17, 7), 24);
	assert.equal(toAbsoluteOffset(0, 7), 7);
});

test('resuming twice does not drift', () => {
	// Play from the start, stop at "Third".
	const firstStop = toAbsoluteOffset(0, chapter.indexOf('Third'));
	const firstResume = resolveChapterStart(chapter, firstStop);
	assert.equal(firstResume.text, 'Third sentence.');

	// Inside that slice, stop at "sentence." -> its absolute position must still be correct.
	const secondStop = toAbsoluteOffset(firstResume.baseOffset, firstResume.text.indexOf('sentence.'));
	assert.equal(secondStop, chapter.indexOf('Third') + 'Third '.length);
	assert.equal(resolveChapterStart(chapter, secondStop).text, 'sentence.');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/epub_position.test.ts`
Expected: FAIL — cannot find module `epub_position.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/epub_position.ts`:

```ts
/**
 * A resumed chapter is played as a slice of its full text, so highlight offsets
 * reported later are slice-relative. Callers keep `baseOffset` to convert them back.
 */
export function resolveChapterStart(chapterText: string, charOffset: number): { text: string; baseOffset: number } {
	if (!Number.isFinite(charOffset) || charOffset <= 0 || charOffset >= chapterText.length) {
		return { text: chapterText, baseOffset: 0 };
	}
	return { text: chapterText.slice(charOffset), baseOffset: charOffset };
}

export function toAbsoluteOffset(baseOffset: number, rangeStart: number): number {
	return baseOffset + rangeStart;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/epub_position.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write src/shared/epub_position.ts tests/unit/epub_position.test.ts
git add src/shared/epub_position.ts tests/unit/epub_position.test.ts
git commit -m "feat: add EPUB reading-position offset math"
```

---

### Task 3: EPUB progress store

Persists the small position record and the retained file handle. Mirrors the existing `src/shared/audio_export_handle_store.ts`, which already stores `FileSystemFileHandle` values in IndexedDB with an injectable `IDBFactory` for tests — read that file before starting and follow its structure.

**Files:**
- Create: `src/shared/epub_progress_store.ts`
- Test: `tests/unit/epub_progress_store.test.ts` (create)

**Interfaces:**
- Consumes: `STORAGE_KEYS.EPUB_PROGRESS` (Task 1).
- Produces:

```ts
export interface EpubProgressRecord {
	title: string;
	chapterIndex: number;
	charOffset: number;
	totalChapters: number;
	fileSize: number;
	fileLastModified: number;
	updatedAt: number;
}

export interface EpubBookHandleRecord {
	handle: FileSystemFileHandle;
	fileName: string;
	fileSize: number;
	fileLastModified: number;
}

export function saveEpubProgress(record: EpubProgressRecord): Promise<void>;
export function loadEpubProgress(): Promise<EpubProgressRecord | null>;
export function clearEpubProgress(): Promise<void>;
export function putEpubBookHandle(record: EpubBookHandleRecord, factory?: IDBFactory): Promise<void>;
export function getEpubBookHandle(factory?: IDBFactory): Promise<EpubBookHandleRecord | null>;
export function clearEpubBookHandle(factory?: IDBFactory): Promise<void>;
export function matchesSavedFile(record: EpubProgressRecord, file: { size: number; lastModified: number }): boolean;
```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/epub_progress_store.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
	clearEpubBookHandle,
	type EpubProgressRecord,
	getEpubBookHandle,
	loadEpubProgress,
	matchesSavedFile,
	putEpubBookHandle,
	saveEpubProgress,
} from '../../src/shared/epub_progress_store.ts';

const record: EpubProgressRecord = {
	title: 'Moby Dick',
	chapterIndex: 3,
	charOffset: 1200,
	totalChapters: 40,
	fileSize: 900_000,
	fileLastModified: 1_700_000_000_000,
	updatedAt: 1_700_000_500_000,
};

function installStorageStub(): { values: Record<string, unknown> } {
	const values: Record<string, unknown> = {};
	(globalThis as { chrome?: unknown }).chrome = {
		storage: {
			local: {
				get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]])),
				set: async (items: Record<string, unknown>) => Object.assign(values, items),
				remove: async (key: string) => {
					delete values[key];
				},
			},
		},
	};
	return { values };
}

test('progress round-trips through chrome.storage.local', async () => {
	installStorageStub();
	await saveEpubProgress(record);
	assert.deepEqual(await loadEpubProgress(), record);
});

test('a missing or malformed progress record reads as null', async () => {
	const storage = installStorageStub();
	assert.equal(await loadEpubProgress(), null);

	storage.values.readit_epub_progress = { title: 'Broken' };
	assert.equal(await loadEpubProgress(), null);
});

test('a file handle round-trips through IndexedDB', async () => {
	const factory = new IDBFactory();
	const handle = { name: 'book.epub' } as unknown as FileSystemFileHandle;
	await putEpubBookHandle({ handle, fileName: 'book.epub', fileSize: 900_000, fileLastModified: 1_700_000_000_000 }, factory);

	const stored = await getEpubBookHandle(factory);
	assert.equal(stored?.fileName, 'book.epub');
	assert.equal(stored?.fileSize, 900_000);
});

test('clearing removes the stored handle', async () => {
	const factory = new IDBFactory();
	const handle = { name: 'book.epub' } as unknown as FileSystemFileHandle;
	await putEpubBookHandle({ handle, fileName: 'book.epub', fileSize: 1, fileLastModified: 2 }, factory);
	await clearEpubBookHandle(factory);
	assert.equal(await getEpubBookHandle(factory), null);
});

test('a changed file is detected by size or mtime', () => {
	assert.equal(matchesSavedFile(record, { size: 900_000, lastModified: 1_700_000_000_000 }), true);
	assert.equal(matchesSavedFile(record, { size: 900_001, lastModified: 1_700_000_000_000 }), false);
	assert.equal(matchesSavedFile(record, { size: 900_000, lastModified: 1_700_000_000_001 }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/epub_progress_store.test.ts`
Expected: FAIL — cannot find module `epub_progress_store.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/epub_progress_store.ts`. Reuse the IndexedDB open/transaction helpers' shape from `src/shared/audio_export_handle_store.ts` (a `DATABASE_NAME`/`STORE_NAME` pair, `getFactory(factory?)`, promise-wrapped requests):

```ts
import { STORAGE_KEYS } from './constants.ts';

const DATABASE_NAME = 'readit-epub-library';
const DATABASE_VERSION = 1;
const STORE_NAME = 'handles';
const CURRENT_BOOK_KEY = 'current-book';

export interface EpubProgressRecord {
	title: string;
	chapterIndex: number;
	charOffset: number;
	totalChapters: number;
	fileSize: number;
	fileLastModified: number;
	updatedAt: number;
}

export interface EpubBookHandleRecord {
	handle: FileSystemFileHandle;
	fileName: string;
	fileSize: number;
	fileLastModified: number;
}

function isEpubProgressRecord(value: unknown): value is EpubProgressRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.title === 'string' &&
		Number.isInteger(record.chapterIndex) &&
		Number.isFinite(record.charOffset) &&
		Number.isInteger(record.totalChapters) &&
		Number.isFinite(record.fileSize) &&
		Number.isFinite(record.fileLastModified) &&
		Number.isFinite(record.updatedAt)
	);
}

export async function saveEpubProgress(record: EpubProgressRecord): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEYS.EPUB_PROGRESS]: record });
}

export async function loadEpubProgress(): Promise<EpubProgressRecord | null> {
	const result = (await chrome.storage.local.get([STORAGE_KEYS.EPUB_PROGRESS])) as Record<string, unknown>;
	const stored = result[STORAGE_KEYS.EPUB_PROGRESS];
	return isEpubProgressRecord(stored) ? stored : null;
}

export async function clearEpubProgress(): Promise<void> {
	await chrome.storage.local.remove(STORAGE_KEYS.EPUB_PROGRESS);
}

export function matchesSavedFile(record: EpubProgressRecord, file: { size: number; lastModified: number }): boolean {
	return record.fileSize === file.size && record.fileLastModified === file.lastModified;
}

function getFactory(factory?: IDBFactory): IDBFactory {
	if (factory) {
		return factory;
	}
	if (!globalThis.indexedDB) {
		throw new Error('IndexedDB is unavailable');
	}
	return globalThis.indexedDB;
}

function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = getFactory(factory).open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME);
			}
		};
		request.onerror = () => reject(request.error ?? new Error('Failed to open the EPUB library database'));
		request.onsuccess = () => resolve(request.result);
	});
}

async function withStore<Result>(
	factory: IDBFactory | undefined,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest,
): Promise<Result> {
	const database = await openDatabase(factory);
	try {
		return await new Promise<Result>((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, mode);
			const request = operation(transaction.objectStore(STORE_NAME));
			request.onerror = () => reject(request.error ?? new Error('EPUB library request failed'));
			request.onsuccess = () => resolve(request.result as Result);
		});
	} finally {
		database.close();
	}
}

export async function putEpubBookHandle(record: EpubBookHandleRecord, factory?: IDBFactory): Promise<void> {
	await withStore(factory, 'readwrite', (store) => store.put(record, CURRENT_BOOK_KEY));
}

export async function getEpubBookHandle(factory?: IDBFactory): Promise<EpubBookHandleRecord | null> {
	const stored = await withStore<EpubBookHandleRecord | undefined>(factory, 'readonly', (store) => store.get(CURRENT_BOOK_KEY));
	return stored && stored.handle ? stored : null;
}

export async function clearEpubBookHandle(factory?: IDBFactory): Promise<void> {
	await withStore(factory, 'readwrite', (store) => store.delete(CURRENT_BOOK_KEY));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/epub_progress_store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write src/shared/epub_progress_store.ts tests/unit/epub_progress_store.test.ts
git add src/shared/epub_progress_store.ts tests/unit/epub_progress_store.test.ts
git commit -m "feat: persist EPUB reading progress and book file handle"
```

---

### Task 4: EPUB extractor

Parses container/OPF/spine and yields one chapter's text at a time. `DOMParser` is injected as a dependency so the path-resolution and text-normalization logic stays unit-testable in Node; real XML parsing is covered by the e2e task.

**Files:**
- Modify: `package.json` (add `jszip`)
- Create: `src/shared/epub_extractor.ts`
- Test: `tests/unit/epub_extractor.test.ts` (create)

**Interfaces:**
- Consumes: `EPUB_ERROR_CODES` (Task 1).
- Produces:

```ts
export class EpubError extends Error { readonly code: EpubErrorCode }
export interface EpubBook {
	title: string;
	lang: string;
	chapterCount: number;
	getChapterText(index: number): Promise<string>;
}
export interface EpubExtractorDependencies {
	parseXml(text: string, mimeType: 'text/xml' | 'application/xhtml+xml'): Document;
}
export function resolveHref(opfPath: string, href: string): string;
export function normalizeChapterText(blocks: readonly string[]): string;
export function openEpubBook(bytes: ArrayBuffer, dependencies?: EpubExtractorDependencies): Promise<EpubBook>;
```

- [ ] **Step 1: Add the dependency**

Run: `pnpm add jszip`
Expected: `jszip` appears under `dependencies` in `package.json` and `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/epub_extractor.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChapterText, resolveHref } from '../../src/shared/epub_extractor.ts';

test('hrefs resolve relative to the OPF directory', () => {
	assert.equal(resolveHref('OEBPS/content.opf', 'chapter1.xhtml'), 'OEBPS/chapter1.xhtml');
	assert.equal(resolveHref('OEBPS/content.opf', 'text/chapter1.xhtml'), 'OEBPS/text/chapter1.xhtml');
	assert.equal(resolveHref('content.opf', 'chapter1.xhtml'), 'chapter1.xhtml');
});

test('parent segments in hrefs are resolved', () => {
	assert.equal(resolveHref('OEBPS/text/content.opf', '../images/../chapter1.xhtml'), 'OEBPS/chapter1.xhtml');
});

test('percent-encoded hrefs are decoded to their archive path', () => {
	assert.equal(resolveHref('OEBPS/content.opf', 'chapter%201.xhtml'), 'OEBPS/chapter 1.xhtml');
});

test('blocks are joined as paragraphs with whitespace collapsed', () => {
	assert.equal(normalizeChapterText(['  First   block  ', 'Second\tblock']), 'First block\n\nSecond block');
});

test('empty and whitespace-only blocks are dropped', () => {
	assert.equal(normalizeChapterText(['First', '   ', '', 'Second']), 'First\n\nSecond');
});

test('a chapter with no text normalizes to an empty string', () => {
	assert.equal(normalizeChapterText(['', '  ']), '');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/epub_extractor.test.ts`
Expected: FAIL — cannot find module `epub_extractor.ts`.

- [ ] **Step 4: Write the implementation**

Create `src/shared/epub_extractor.ts`:

```ts
import JSZip from 'jszip';
import { EPUB_ERROR_CODES, type EpubErrorCode } from './constants.ts';

const CONTAINER_PATH = 'META-INF/container.xml';
const ENCRYPTION_PATH = 'META-INF/encryption.xml';
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, pre';

export class EpubError extends Error {
	readonly code: EpubErrorCode;

	constructor(code: EpubErrorCode) {
		super(code);
		this.name = 'EpubError';
		this.code = code;
	}
}

export interface EpubBook {
	title: string;
	lang: string;
	chapterCount: number;
	getChapterText(index: number): Promise<string>;
}

export interface EpubExtractorDependencies {
	parseXml(text: string, mimeType: 'text/xml' | 'application/xhtml+xml'): Document;
}

function defaultDependencies(): EpubExtractorDependencies {
	return {
		parseXml: (text, mimeType) => new DOMParser().parseFromString(text, mimeType),
	};
}

/** Resolve a manifest href against the OPF's own directory, as EPUB paths are OPF-relative. */
export function resolveHref(opfPath: string, href: string): string {
	const directory = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
	const segments = directory ? directory.split('/') : [];
	for (const segment of decodeURIComponent(href).split('/')) {
		if (segment === '.' || segment === '') {
			continue;
		}
		if (segment === '..') {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join('/');
}

export function normalizeChapterText(blocks: readonly string[]): string {
	return blocks
		.map((block) => block.replace(/\s+/gu, ' ').trim())
		.filter((block) => block.length > 0)
		.join('\n\n');
}

function requireElementText(document: Document, tagName: string): string | undefined {
	const value = document.getElementsByTagName(tagName)[0]?.textContent?.trim();
	return value ? value : undefined;
}

export async function openEpubBook(
	bytes: ArrayBuffer,
	dependencies: EpubExtractorDependencies = defaultDependencies(),
): Promise<EpubBook> {
	let archive: JSZip;
	try {
		archive = await JSZip.loadAsync(bytes);
	} catch {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}

	if (archive.file(ENCRYPTION_PATH)) {
		throw new EpubError(EPUB_ERROR_CODES.drmProtected);
	}

	const containerXml = await archive.file(CONTAINER_PATH)?.async('string');
	if (!containerXml) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}
	const opfPath = dependencies
		.parseXml(containerXml, 'text/xml')
		.getElementsByTagName('rootfile')[0]
		?.getAttribute('full-path');
	if (!opfPath) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}

	const opfXml = await archive.file(opfPath)?.async('string');
	if (!opfXml) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}
	const opf = dependencies.parseXml(opfXml, 'text/xml');

	const hrefById = new Map<string, string>();
	for (const item of Array.from(opf.getElementsByTagName('item'))) {
		const id = item.getAttribute('id');
		const href = item.getAttribute('href');
		if (id && href) {
			hrefById.set(id, resolveHref(opfPath, href));
		}
	}

	const chapterPaths = Array.from(opf.getElementsByTagName('itemref'))
		.map((itemref) => itemref.getAttribute('idref'))
		.map((idref) => (idref ? hrefById.get(idref) : undefined))
		.filter((path): path is string => Boolean(path));

	if (chapterPaths.length === 0) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}

	return {
		title: requireElementText(opf, 'dc:title') ?? requireElementText(opf, 'title') ?? '',
		lang: requireElementText(opf, 'dc:language') ?? requireElementText(opf, 'language') ?? '',
		chapterCount: chapterPaths.length,
		async getChapterText(index) {
			const path = chapterPaths[index];
			const chapterXml = path ? await archive.file(path)?.async('string') : undefined;
			if (!chapterXml) {
				return '';
			}
			const chapter = dependencies.parseXml(chapterXml, 'application/xhtml+xml');
			const blocks = Array.from(chapter.querySelectorAll(BLOCK_SELECTOR)).map((element) => element.textContent ?? '');
			// Some books wrap everything in divs; fall back to the whole body rather than reading nothing.
			return normalizeChapterText(blocks.length > 0 ? blocks : [chapter.body?.textContent ?? '']);
		},
	};
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/epub_extractor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Verify the bundle still builds**

Run: `CI=true pnpm build:chrome`
Expected: build succeeds with `jszip` bundled.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/shared/epub_extractor.ts tests/unit/epub_extractor.test.ts
git add package.json pnpm-lock.yaml src/shared/epub_extractor.ts tests/unit/epub_extractor.test.ts
git commit -m "feat: add EPUB container/OPF/spine extractor with per-chapter text"
```

---

### Task 5: Extract PDF parsing from fetching

Lets a locally picked PDF reuse the existing parser without a network fetch.

**Files:**
- Modify: `src/background/pdf_extractor.ts:141-211`
- Test: `tests/unit/pdf_extractor.test.ts` (extend)

**Interfaces:**
- Consumes: existing `PdfDocument`, `PdfArticleResponse` from the same file.
- Produces: `extractPdfArticleFromBytes(bytes: Uint8Array, title: string, dependencies: { loadDocument(data: Uint8Array): Promise<PdfDocument> }): Promise<PdfArticleResponse>`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/pdf_extractor.test.ts`:

```ts
test('extracts an article from raw bytes without fetching', async () => {
	const response = await extractPdfArticleFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'Local file.pdf', {
		loadDocument: async () => ({
			numPages: 2,
			getMetadata: async () => ({ info: { Title: 'Quarterly report' } }),
			getPage: async (pageNumber: number) => ({
				getTextContent: async () => ({ items: [{ str: pageNumber === 1 ? 'First page.' : 'Second page.', hasEOL: true }] }),
			}),
			destroy: async () => undefined,
		}),
	});

	assert.equal(response.success, true);
	assert.ok(response.success && response.article.content.includes('First page.'));
	assert.ok(response.success && response.article.content.includes('Second page.'));
	assert.equal(response.success && response.article.title, 'Quarterly report');
	assert.equal(response.success && response.readableSurface, 'document-reader');
});

test('falls back to the supplied title when the PDF has no metadata title', async () => {
	const response = await extractPdfArticleFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'Local file.pdf', {
		loadDocument: async () => ({
			numPages: 1,
			getMetadata: async () => ({}),
			getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Body text.', hasEOL: true }] }) }),
			destroy: async () => undefined,
		}),
	});

	assert.equal(response.success && response.article.title, 'Local file.pdf');
});

test('reports textless PDFs from raw bytes', async () => {
	const response = await extractPdfArticleFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'Scan.pdf', {
		loadDocument: async () => ({
			numPages: 1,
			getMetadata: async () => ({}),
			getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
			destroy: async () => undefined,
		}),
	});

	assert.deepEqual(response, { success: false, error: PDF_ERROR_CODES.textUnavailable });
});

test('maps password-protected PDFs from raw bytes', async () => {
	const passwordError = new Error('password required');
	passwordError.name = 'PasswordException';
	const response = await extractPdfArticleFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'Locked.pdf', {
		loadDocument: async () => {
			throw passwordError;
		},
	});

	assert.deepEqual(response, { success: false, error: PDF_ERROR_CODES.passwordProtected });
});
```

Extend the import at the top of the same file to include the new function:

```ts
import { extractPdfArticle, extractPdfArticleFromBytes, isSupportedPdfSource, type PdfExtractorDependencies } from '../../src/background/pdf_extractor.ts';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/pdf_extractor.test.ts`
Expected: FAIL — `extractPdfArticleFromBytes` is not exported.

- [ ] **Step 3: Extract the parsing half**

In `src/background/pdf_extractor.ts`, add this exported function above `extractPdfArticle` (it is the body of the existing `try` block at lines 184-210, with the title/lang resolution parameterized):

```ts
export async function extractPdfArticleFromBytes(
	bytes: Uint8Array,
	title: string,
	dependencies: Pick<PdfExtractorDependencies, 'loadDocument'>,
	url = title,
): Promise<PdfArticleResponse> {
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
				title: documentTitle(metadata, { url, title }),
				content,
				url,
				lang: detectContentLanguage(content, 'na'),
			},
			readableSurface: 'document-reader',
		};
	} catch (error) {
		return extractionFailure(
			error instanceof Error && error.name === 'PasswordException' ? PDF_ERROR_CODES.passwordProtected : PDF_ERROR_CODES.extractionFailed,
		);
	} finally {
		if (document) await document.destroy();
	}
}
```

Then replace the whole `let document: PdfDocument | undefined; try { ... } finally { ... }` block at the end of `extractPdfArticle` (lines 184-210) with a delegation:

```ts
	return extractPdfArticleFromBytes(bytes, source.title, dependencies, source.url);
```

- [ ] **Step 4: Run the full unit suite to verify nothing regressed**

Run: `CI=true pnpm test:unit`
Expected: PASS, including all pre-existing `pdf_extractor` tests (URL fetching, file-scheme permission, non-PDF fallback).

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write src/background/pdf_extractor.ts tests/unit/pdf_extractor.test.ts
git add src/background/pdf_extractor.ts tests/unit/pdf_extractor.test.ts
git commit -m "refactor: split PDF byte parsing from fetching"
```

---

### Task 6: Background `START_READER_CONTENT` handler

Creates a `document-reader` session owned by the *calling* Reader tab.

**Files:**
- Modify: `src/background/background.ts` (message switch near line 1607, alongside `START_CURRENT_PAGE`)
- Test: `tests/unit/reader_content_request.test.ts` (create)
- Create: `src/background/reader_content_request.ts`

**Interfaces:**
- Consumes: existing `startPlayback(input: StartPlaybackInput)`.
- Produces:

```ts
export interface ReaderContentRequest {
	tabId: number;
	title: string;
	content: string;
	lang: string;
}
export function parseReaderContentRequest(payload: unknown, senderTabId: number | undefined): ReaderContentRequest | null;
```

Validation lives in its own module so it is unit-testable without importing the whole background worker (mirrors `src/background/selected_text.ts`'s `prepareSelectedTextRequest`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reader_content_request.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReaderContentRequest } from '../../src/background/reader_content_request.ts';

test('accepts a well-formed request and trusts the sender tab id', () => {
	const request = parseReaderContentRequest({ title: 'Chapter 1', content: 'Hello there.', lang: 'en' }, 42);
	assert.deepEqual(request, { tabId: 42, title: 'Chapter 1', content: 'Hello there.', lang: 'en' });
});

test('rejects a request with no sender tab', () => {
	assert.equal(parseReaderContentRequest({ title: 'Chapter 1', content: 'Hello.', lang: 'en' }, undefined), null);
});

test('rejects empty or whitespace-only content', () => {
	assert.equal(parseReaderContentRequest({ title: 'Chapter 1', content: '   ', lang: 'en' }, 42), null);
	assert.equal(parseReaderContentRequest({ title: 'Chapter 1', content: '', lang: 'en' }, 42), null);
});

test('rejects malformed payloads', () => {
	assert.equal(parseReaderContentRequest(null, 42), null);
	assert.equal(parseReaderContentRequest({ content: 'Hello.', lang: 'en' }, 42), null);
	assert.equal(parseReaderContentRequest({ title: 5, content: 'Hello.', lang: 'en' }, 42), null);
});

test('falls back to automatic language detection when lang is missing', () => {
	const request = parseReaderContentRequest({ title: 'Chapter 1', content: 'Hello.' }, 42);
	assert.equal(request?.lang, 'na');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/reader_content_request.test.ts`
Expected: FAIL — cannot find module `reader_content_request.ts`.

- [ ] **Step 3: Write the validator**

Create `src/background/reader_content_request.ts`:

```ts
export interface ReaderContentRequest {
	tabId: number;
	title: string;
	content: string;
	lang: string;
}

/**
 * The Reader page is both the loader and the display surface for local books, so the
 * owning tab is the sender itself rather than a separate content tab.
 */
export function parseReaderContentRequest(payload: unknown, senderTabId: number | undefined): ReaderContentRequest | null {
	if (!payload || typeof payload !== 'object' || typeof senderTabId !== 'number') {
		return null;
	}
	const request = payload as Record<string, unknown>;
	if (typeof request.title !== 'string' || typeof request.content !== 'string' || !request.content.trim()) {
		return null;
	}
	return {
		tabId: senderTabId,
		title: request.title,
		content: request.content,
		lang: typeof request.lang === 'string' && request.lang ? request.lang : 'na',
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/reader_content_request.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the handler into the background message switch**

In `src/background/background.ts`, add the import alongside the other `./` background imports:

```ts
import { parseReaderContentRequest } from './reader_content_request.ts';
```

Add this case immediately after the existing `case 'START_CURRENT_PAGE':` block (around line 1608):

```ts
			case 'START_READER_CONTENT': {
				const request = parseReaderContentRequest(msg.payload, sender.tab?.id);
				if (!request) {
					sendResponse({ success: false, error: ERROR_MESSAGES.noSession });
					return undefined;
				}
				return respondFromQueue(
					() =>
						startPlayback({
							contentScope: 'article',
							source: { kind: 'tab', tabId: request.tabId, title: request.title, url: request.title },
							content: { content: request.content, lang: request.lang },
							readableSurface: 'document-reader',
						}),
					sendResponse,
				);
			}
```

- [ ] **Step 6: Verify the build and full unit suite**

Run: `CI=true pnpm test:unit && CI=true pnpm build:chrome`
Expected: PASS and a successful build.

- [ ] **Step 7: Commit**

```bash
pnpm exec biome check --write src/background/background.ts src/background/reader_content_request.ts tests/unit/reader_content_request.test.ts
git add src/background/background.ts src/background/reader_content_request.ts tests/unit/reader_content_request.test.ts
git commit -m "feat: start document-reader playback from locally loaded reader content"
```

---

### Task 7: Broadcast natural completion to extension pages

`completedNaturally` is computed in `applyProgressMessage` but consumed only by the playlist queue, so pages cannot distinguish a finished chapter from a user-pressed Stop. Without this, chapter chaining would advance when the user stops.

**Files:**
- Modify: `src/background/background.ts:1465-1478` (`applyProgressMessage`)
- Modify: `src/shared/document_reader.ts` (message type)
- Test: `tests/unit/document_reader.test.ts` (extend)

**Interfaces:**
- Consumes: existing `broadcastSession`-style `chrome.runtime.sendMessage` pattern.
- Produces:

```ts
export interface DocumentReaderCompletedMessage {
	action: 'DOCUMENT_READER_COMPLETED';
	sessionId: string;
}
export function isDocumentReaderCompletedMessage(value: unknown): value is DocumentReaderCompletedMessage;
```

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/document_reader.test.ts`:

```ts
test('recognizes a well-formed completion message', () => {
	assert.equal(isDocumentReaderCompletedMessage({ action: 'DOCUMENT_READER_COMPLETED', sessionId: 'abc' }), true);
});

test('rejects completion messages with a missing or wrong shape', () => {
	assert.equal(isDocumentReaderCompletedMessage({ action: 'DOCUMENT_READER_COMPLETED' }), false);
	assert.equal(isDocumentReaderCompletedMessage({ action: 'DOCUMENT_READER_COMPLETED', sessionId: '' }), false);
	assert.equal(isDocumentReaderCompletedMessage({ action: 'PLAYBACK_STATE_UPDATE', sessionId: 'abc' }), false);
	assert.equal(isDocumentReaderCompletedMessage(null), false);
});
```

Extend that file's existing import from `../../src/shared/document_reader.ts` to include `isDocumentReaderCompletedMessage`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/document_reader.test.ts`
Expected: FAIL — `isDocumentReaderCompletedMessage` is not exported.

- [ ] **Step 3: Add the message type and guard**

Append to `src/shared/document_reader.ts`:

```ts
/**
 * Natural completion is otherwise invisible to extension pages: a finished session and a
 * user-pressed Stop both surface as `status: 'stopped'` on the session snapshot.
 */
export interface DocumentReaderCompletedMessage {
	action: 'DOCUMENT_READER_COMPLETED';
	sessionId: string;
}

export function isDocumentReaderCompletedMessage(value: unknown): value is DocumentReaderCompletedMessage {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const message = value as Record<string, unknown>;
	return message.action === 'DOCUMENT_READER_COMPLETED' && typeof message.sessionId === 'string' && message.sessionId.length > 0;
}
```

- [ ] **Step 4: Broadcast it from the background**

In `src/background/background.ts`, inside `applyProgressMessage`'s `if (updatedSession.status === 'stopped')` block, after the existing `await clearSession();` call and before the queue-advance check, add:

```ts
		if (completedNaturally && completedSession?.readableSurface === 'document-reader') {
			try {
				await chrome.runtime.sendMessage({ action: 'DOCUMENT_READER_COMPLETED', sessionId: completedSession.sessionId });
			} catch (_error) {
				// The Reader may be closed, so there may be no receiver for this broadcast.
			}
		}
```

- [ ] **Step 5: Run tests and build to verify**

Run: `CI=true pnpm test:unit && CI=true pnpm build:chrome`
Expected: PASS and a successful build.

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write src/background/background.ts src/shared/document_reader.ts tests/unit/document_reader.test.ts
git add src/background/background.ts src/shared/document_reader.ts tests/unit/document_reader.test.ts
git commit -m "feat: broadcast natural completion of document-reader sessions"
```

---

### Task 8: Reader file picker and local PDF path

After this task, opening a local **PDF** works end to end. EPUB is wired in Task 9.

**Files:**
- Create: `src/reader/book_loader.ts`
- Modify: `src/reader/App.tsx:276-281` (the `document-reader-empty` section) and its state
- Modify: `src/reader/reader.css` (styles for the new empty-state actions)
- Test: covered by e2e in Task 12; `book_loader.ts`'s pure part is unit-tested here.
- Test: `tests/unit/book_loader.test.ts` (create)

**Interfaces:**
- Consumes: `extractPdfArticleFromBytes` (Task 5), `openEpubBook`/`EpubError` (Task 4), `EPUB_ERROR_CODES` (Task 1).
- Produces:

```ts
export type BookKind = 'epub' | 'pdf';
export function isFileSystemAccessSupported(): boolean;
export function detectBookKind(fileName: string): BookKind | null;
export function pickBookFile(): Promise<FileSystemFileHandle | null>;
export function sendReaderContent(payload: { title: string; content: string; lang: string }): Promise<CommandResponse>;
```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/book_loader.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBookKind } from '../../src/reader/book_loader.ts';

test('detects book kinds from the file extension, case-insensitively', () => {
	assert.equal(detectBookKind('novel.epub'), 'epub');
	assert.equal(detectBookKind('NOVEL.EPUB'), 'epub');
	assert.equal(detectBookKind('report.pdf'), 'pdf');
	assert.equal(detectBookKind('report.PDF'), 'pdf');
});

test('rejects unsupported and extensionless files', () => {
	assert.equal(detectBookKind('notes.txt'), null);
	assert.equal(detectBookKind('archive.epub.zip'), null);
	assert.equal(detectBookKind('README'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/book_loader.test.ts`
Expected: FAIL — cannot find module `book_loader.ts`.

- [ ] **Step 3: Write the loader module**

Create `src/reader/book_loader.ts`:

```ts
import { sendPlaybackCommand } from '../shared/playback_client.ts';
import type { CommandResponse } from '../shared/types.ts';

export type BookKind = 'epub' | 'pdf';

interface FilePickerWindow {
	showOpenFilePicker?: (options: {
		multiple?: boolean;
		types?: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<FileSystemFileHandle[]>;
}

export function isFileSystemAccessSupported(): boolean {
	return typeof (window as FilePickerWindow).showOpenFilePicker === 'function';
}

export function detectBookKind(fileName: string): BookKind | null {
	const lowered = fileName.toLowerCase();
	if (lowered.endsWith('.epub')) {
		return 'epub';
	}
	return lowered.endsWith('.pdf') ? 'pdf' : null;
}

/** Resolves to null when the user dismisses the native picker. */
export async function pickBookFile(): Promise<FileSystemFileHandle | null> {
	const picker = (window as FilePickerWindow).showOpenFilePicker;
	if (!picker) {
		return null;
	}
	try {
		const [handle] = await picker({
			multiple: false,
			types: [{ description: 'Books', accept: { 'application/epub+zip': ['.epub'], 'application/pdf': ['.pdf'] } }],
		});
		return handle ?? null;
	} catch {
		return null;
	}
}

export function sendReaderContent(payload: { title: string; content: string; lang: string }): Promise<CommandResponse> {
	return sendPlaybackCommand({ action: 'START_READER_CONTENT', payload });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/book_loader.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Render the empty-state actions and handle PDF**

In `src/reader/App.tsx`, add these imports:

```ts
import { loadPdfJsDocument } from '../background/pdfjs_loader.ts';
import { extractPdfArticleFromBytes } from '../background/pdf_extractor.ts';
import { detectBookKind, isFileSystemAccessSupported, pickBookFile, sendReaderContent } from './book_loader.ts';
import { getLocalizedPlaybackError } from '../shared/i18n.ts';
```

Add state next to the existing `useState` declarations:

```ts
	const [bookError, setBookError] = useState('');
	const [isLoadingBook, setIsLoadingBook] = useState(false);
```

Add the handler above the `return`:

```ts
	const handleOpenBook = async () => {
		setBookError('');
		const handle = await pickBookFile();
		if (!handle) {
			return;
		}
		const kind = detectBookKind(handle.name);
		if (!kind) {
			setBookError(t('bookOpenFailed'));
			return;
		}
		setIsLoadingBook(true);
		try {
			const file = await handle.getFile();
			if (kind === 'pdf') {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const extraction = await extractPdfArticleFromBytes(bytes, file.name, { loadDocument: loadPdfJsDocument });
				if (!extraction.success) {
					setBookError(getLocalizedPlaybackError(extraction.error) ?? t('bookOpenFailed'));
					return;
				}
				const response = await sendReaderContent({
					title: extraction.article.title,
					content: extraction.article.content,
					lang: extraction.article.lang,
				});
				if (!response.success) {
					setBookError(t('bookOpenFailed'));
				}
				return;
			}
			setBookError(t('bookOpenFailed'));
		} catch {
			setBookError(t('bookOpenFailed'));
		} finally {
			setIsLoadingBook(false);
		}
	};
```

Replace the existing empty-state `<section>` (currently lines 276-281) with:

```tsx
					<section className="document-reader-empty">
						<h2>{t('documentReaderEmptyTitle')}</h2>
						<p>{t('documentReaderEmptyBody')}</p>
						{bookError && <div className="alert alert-danger">{bookError}</div>}
						{isFileSystemAccessSupported() && (
							<div className="document-reader-empty-actions">
								<button className="btn btn-primary" type="button" disabled={isLoadingBook} onClick={() => void handleOpenBook()}>
									{t('openBook')}
								</button>
							</div>
						)}
					</section>
```

- [ ] **Step 6: Add the styles**

Append to `src/reader/reader.css`:

```css
.document-reader-empty-actions {
	display: flex;
	gap: 12px;
	justify-content: center;
	margin-top: 20px;
}
```

- [ ] **Step 7: Verify the build**

Run: `CI=true pnpm test:unit && CI=true pnpm build:chrome`
Expected: PASS and a successful build.

- [ ] **Step 8: Manually smoke-test the PDF path**

Load `dist/chrome` as an unpacked extension, open the Reader via `chrome-extension://<id>/src/reader/reader.html`, click **Open book**, and pick any text-layer PDF.
Expected: the PDF's text renders in the Reader and playback starts with word highlighting.

- [ ] **Step 9: Commit**

```bash
pnpm exec biome check --write src/reader/App.tsx src/reader/book_loader.ts tests/unit/book_loader.test.ts
git add src/reader/App.tsx src/reader/book_loader.ts src/reader/reader.css tests/unit/book_loader.test.ts
git commit -m "feat: open a local PDF from the Document Reader file picker"
```

---

### Task 9: EPUB chapter chaining

Plays chapters back-to-back, prefetches the next chapter's text, and persists position.

**Files:**
- Create: `src/reader/epub_session.ts`
- Modify: `src/reader/App.tsx` (wire the coordinator into the EPUB branch of `handleOpenBook`, render chapter progress)
- Test: `tests/unit/epub_session.test.ts` (create)

**Interfaces:**
- Consumes: `EpubBook` (Task 4), `resolveChapterStart`/`toAbsoluteOffset` (Task 2), `saveEpubProgress` (Task 3), `sendReaderContent` (Task 8), `isDocumentReaderCompletedMessage` (Task 7).
- Produces:

```ts
export interface EpubSessionDependencies {
	book: EpubBook;
	file: { name: string; size: number; lastModified: number };
	startChapter(payload: { title: string; content: string; lang: string }): Promise<boolean>;
	saveProgress(record: EpubProgressRecord): Promise<void>;
	now(): number;
}
export interface EpubSession {
	start(from: { chapterIndex: number; charOffset: number }): Promise<boolean>;
	advance(): Promise<boolean>;
	recordPosition(sliceRangeStart: number): void;
	prefetchNext(): void;
	flush(): Promise<void>;
	state(): { chapterIndex: number; chapterCount: number };
}
export function createEpubSession(dependencies: EpubSessionDependencies): EpubSession;
```

`advance()` resolves `false` when the book has no further chapters with text — the caller then stops and returns to the empty state.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/epub_session.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EpubBook } from '../../src/shared/epub_extractor.ts';
import type { EpubProgressRecord } from '../../src/shared/epub_progress_store.ts';
import { createEpubSession } from '../../src/reader/epub_session.ts';

function fakeBook(chapters: string[]): EpubBook {
	return {
		title: 'Test Book',
		lang: 'en',
		chapterCount: chapters.length,
		getChapterText: async (index) => chapters[index] ?? '',
	};
}

function harness(chapters: string[]) {
	const started: { title: string; content: string; lang: string }[] = [];
	const saved: EpubProgressRecord[] = [];
	const session = createEpubSession({
		book: fakeBook(chapters),
		file: { name: 'book.epub', size: 1234, lastModified: 999 },
		startChapter: async (payload) => {
			started.push(payload);
			return true;
		},
		saveProgress: async (record) => {
			saved.push(record);
		},
		now: () => 1_700_000_000_000,
	});
	return { session, started, saved };
}

test('starting plays the requested chapter from the requested offset', async () => {
	const { session, started } = harness(['First chapter text.', 'Second chapter text.']);
	assert.equal(await session.start({ chapterIndex: 1, charOffset: 'Second '.length }), true);
	assert.equal(started.length, 1);
	assert.equal(started[0].content, 'chapter text.');
	assert.equal(session.state().chapterIndex, 1);
});

test('advancing moves to the next chapter from its beginning', async () => {
	const { session, started } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.advance(), true);
	assert.equal(started[1].content, 'Second chapter.');
	assert.equal(session.state().chapterIndex, 1);
});

test('advancing skips chapters with no extractable text', async () => {
	const { session, started } = harness(['First chapter.', '', '   ', 'Fourth chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.advance(), true);
	assert.equal(started[1].content, 'Fourth chapter.');
	assert.equal(session.state().chapterIndex, 3);
});

test('advancing past the last chapter reports the book is finished', async () => {
	const { session } = harness(['Only chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.advance(), false);
});

test('recorded positions are rebased onto the resumed slice', async () => {
	const { session, saved } = harness(['First chapter text here.']);
	await session.start({ chapterIndex: 0, charOffset: 'First '.length });
	session.recordPosition('chapter '.length);
	await session.flush();

	assert.equal(saved.at(-1)?.charOffset, 'First chapter '.length);
	assert.equal(saved.at(-1)?.chapterIndex, 0);
	assert.equal(saved.at(-1)?.totalChapters, 1);
	assert.equal(saved.at(-1)?.fileSize, 1234);
	assert.equal(saved.at(-1)?.fileLastModified, 999);
});

test('advancing persists the new chapter at offset zero', async () => {
	const { session, saved } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	await session.advance();

	assert.equal(saved.at(-1)?.chapterIndex, 1);
	assert.equal(saved.at(-1)?.charOffset, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/epub_session.test.ts`
Expected: FAIL — cannot find module `epub_session.ts`.

- [ ] **Step 3: Write the coordinator**

Create `src/reader/epub_session.ts`:

```ts
import type { EpubBook } from '../shared/epub_extractor.ts';
import { resolveChapterStart, toAbsoluteOffset } from '../shared/epub_position.ts';
import type { EpubProgressRecord } from '../shared/epub_progress_store.ts';

export interface EpubSessionDependencies {
	book: EpubBook;
	file: { name: string; size: number; lastModified: number };
	startChapter(payload: { title: string; content: string; lang: string }): Promise<boolean>;
	saveProgress(record: EpubProgressRecord): Promise<void>;
	now(): number;
}

export interface EpubSession {
	start(from: { chapterIndex: number; charOffset: number }): Promise<boolean>;
	advance(): Promise<boolean>;
	recordPosition(sliceRangeStart: number): void;
	prefetchNext(): void;
	flush(): Promise<void>;
	state(): { chapterIndex: number; chapterCount: number };
}

export function createEpubSession(dependencies: EpubSessionDependencies): EpubSession {
	const { book, file } = dependencies;
	let chapterIndex = 0;
	let baseOffset = 0;
	let pendingOffset = 0;
	let prefetched: { index: number; text: string } | null = null;

	const chapterText = async (index: number): Promise<string> => {
		if (prefetched?.index === index) {
			const { text } = prefetched;
			prefetched = null;
			return text;
		}
		return book.getChapterText(index);
	};

	const buildRecord = (): EpubProgressRecord => ({
		title: book.title || file.name,
		chapterIndex,
		charOffset: pendingOffset,
		totalChapters: book.chapterCount,
		fileSize: file.size,
		fileLastModified: file.lastModified,
		updatedAt: dependencies.now(),
	});

	const playChapter = async (index: number, charOffset: number): Promise<boolean> => {
		const text = (await chapterText(index)).trim();
		if (!text) {
			return false;
		}
		const slice = resolveChapterStart(text, charOffset);
		chapterIndex = index;
		baseOffset = slice.baseOffset;
		pendingOffset = slice.baseOffset;
		const started = await dependencies.startChapter({ title: book.title || file.name, content: slice.text, lang: book.lang });
		if (started) {
			await dependencies.saveProgress(buildRecord());
		}
		return started;
	};

	return {
		async start(from) {
			for (let index = Math.max(0, from.chapterIndex); index < book.chapterCount; index++) {
				// Only the requested chapter honours the saved offset; skipped-into chapters start fresh.
				if (await playChapter(index, index === from.chapterIndex ? from.charOffset : 0)) {
					return true;
				}
			}
			return false;
		},
		async advance() {
			for (let index = chapterIndex + 1; index < book.chapterCount; index++) {
				if (await playChapter(index, 0)) {
					return true;
				}
			}
			return false;
		},
		recordPosition(sliceRangeStart) {
			pendingOffset = toAbsoluteOffset(baseOffset, sliceRangeStart);
		},
		prefetchNext() {
			const next = chapterIndex + 1;
			if (prefetched?.index === next || next >= book.chapterCount) {
				return;
			}
			void book.getChapterText(next).then(
				(text) => {
					prefetched = { index: next, text };
				},
				() => {
					prefetched = null;
				},
			);
		},
		async flush() {
			await dependencies.saveProgress(buildRecord());
		},
		state() {
			return { chapterIndex, chapterCount: book.chapterCount };
		},
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/epub_session.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the coordinator into the Reader**

In `src/reader/App.tsx`, add imports:

```ts
import { openEpubBook, EpubError } from '../shared/epub_extractor.ts';
import { putEpubBookHandle, saveEpubProgress } from '../shared/epub_progress_store.ts';
import { isDocumentReaderCompletedMessage } from '../shared/document_reader.ts';
import { createEpubSession, type EpubSession } from './epub_session.ts';
```

Add a ref and chapter state:

```ts
	const epubSessionRef = useRef<EpubSession | null>(null);
	const [chapterState, setChapterState] = useState<{ chapterIndex: number; chapterCount: number } | null>(null);
```

Replace the `setBookError(t('bookOpenFailed'));` line that currently stands in for the EPUB branch in `handleOpenBook` with:

```ts
			const book = await openEpubBook(await file.arrayBuffer());
			await putEpubBookHandle({ handle, fileName: file.name, fileSize: file.size, fileLastModified: file.lastModified });
			const session = createEpubSession({
				book,
				file: { name: file.name, size: file.size, lastModified: file.lastModified },
				startChapter: async (payload) => (await sendReaderContent(payload)).success,
				saveProgress: saveEpubProgress,
				now: () => Date.now(),
			});
			epubSessionRef.current = session;
			if (!(await session.start({ chapterIndex: 0, charOffset: 0 }))) {
				epubSessionRef.current = null;
				setBookError(t('bookOpenFailed'));
				return;
			}
			setChapterState(session.state());
```

Change the `catch` clause of `handleOpenBook` to surface EPUB error codes:

```ts
		} catch (error) {
			setBookError(error instanceof EpubError ? (getLocalizedPlaybackError(error.code) ?? t('bookOpenFailed')) : t('bookOpenFailed'));
		} finally {
```

Add an effect that chains chapters on natural completion:

```ts
	useEffect(() => {
		const handleCompleted = (message: unknown) => {
			if (!isDocumentReaderCompletedMessage(message) || !epubSessionRef.current) {
				return;
			}
			const session = epubSessionRef.current;
			void session.advance().then((advanced) => {
				if (advanced) {
					setChapterState(session.state());
					return;
				}
				epubSessionRef.current = null;
				setChapterState(null);
			});
		};
		chrome.runtime.onMessage.addListener(handleCompleted);
		return () => chrome.runtime.onMessage.removeListener(handleCompleted);
	}, []);
```

Add an effect that records the current position and prefetches, keyed on the highlight the Reader already tracks:

```ts
	useEffect(() => {
		const session = epubSessionRef.current;
		const range = wordRanges[currentWordIndex];
		if (!session || !range) {
			return;
		}
		session.recordPosition(range.start);
		if ((documentSession?.progressPercentage ?? 0) >= 80) {
			session.prefetchNext();
		}
	}, [currentWordIndex, wordRanges, documentSession?.progressPercentage]);
```

Add a debounced/lifecycle flush:

```ts
	useEffect(() => {
		const flush = () => void epubSessionRef.current?.flush();
		const interval = setInterval(flush, 5000);
		window.addEventListener('beforeunload', flush);
		return () => {
			clearInterval(interval);
			window.removeEventListener('beforeunload', flush);
			flush();
		};
	}, []);
```

Render chapter progress inside the existing `document-reader-progress` form group, directly under the percentage output:

```tsx
							{chapterState && (
								<span className="slider-value">
									{t('chapterProgress')} {chapterState.chapterIndex + 1}/{chapterState.chapterCount}
								</span>
							)}
```

- [ ] **Step 6: Verify the build and full suite**

Run: `CI=true pnpm test:unit && CI=true pnpm build:chrome`
Expected: PASS and a successful build.

- [ ] **Step 7: Manually smoke-test chapter chaining**

Load the unpacked extension, open the Reader, pick a multi-chapter EPUB, and let chapter 1 finish.
Expected: chapter 2 begins automatically after a short synthesis gap; pressing Stop mid-chapter does **not** advance.

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write src/reader/App.tsx src/reader/epub_session.ts tests/unit/epub_session.test.ts
git add src/reader/App.tsx src/reader/epub_session.ts tests/unit/epub_session.test.ts
git commit -m "feat: chain EPUB chapters with prefetch and progress persistence"
```

---

### Task 10: Resume a saved book

**Files:**
- Modify: `src/reader/App.tsx` (resume button + handler)
- Modify: `src/reader/book_loader.ts` (permission helper)
- Test: `tests/unit/book_loader.test.ts` (extend)

**Interfaces:**
- Consumes: `loadEpubProgress`/`getEpubBookHandle`/`matchesSavedFile` (Task 3), `createEpubSession` (Task 9).
- Produces: `ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/book_loader.test.ts`:

```ts
import { ensureReadPermission } from '../../src/reader/book_loader.ts';

function permissionHandle(query: PermissionState, request?: PermissionState): FileSystemFileHandle {
	return {
		queryPermission: async () => query,
		requestPermission: async () => request ?? query,
	} as unknown as FileSystemFileHandle;
}

test('an already-granted handle needs no prompt', async () => {
	assert.equal(await ensureReadPermission(permissionHandle('granted')), true);
});

test('a promptable handle is granted after requesting', async () => {
	assert.equal(await ensureReadPermission(permissionHandle('prompt', 'granted')), true);
});

test('a denied request reports failure', async () => {
	assert.equal(await ensureReadPermission(permissionHandle('prompt', 'denied')), false);
});

test('a handle without the permission API is treated as unavailable', async () => {
	assert.equal(await ensureReadPermission({} as FileSystemFileHandle), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/book_loader.test.ts`
Expected: FAIL — `ensureReadPermission` is not exported.

- [ ] **Step 3: Add the permission helper**

Append to `src/reader/book_loader.ts`:

```ts
interface PermissionCapableHandle {
	queryPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
	requestPermission?: (options: { mode: 'read' }) => Promise<PermissionState>;
}

/** Must be called inside a user gesture: Chrome may re-prompt after a browser restart. */
export async function ensureReadPermission(handle: FileSystemFileHandle): Promise<boolean> {
	const permissions = handle as unknown as PermissionCapableHandle;
	if (!permissions.queryPermission || !permissions.requestPermission) {
		return false;
	}
	if ((await permissions.queryPermission({ mode: 'read' })) === 'granted') {
		return true;
	}
	return (await permissions.requestPermission({ mode: 'read' })) === 'granted';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/book_loader.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Render and wire the resume action**

In `src/reader/App.tsx`, add imports and state:

```ts
import { EPUB_ERROR_CODES } from '../shared/constants.ts';
import { type EpubProgressRecord, getEpubBookHandle, loadEpubProgress, matchesSavedFile } from '../shared/epub_progress_store.ts';
import { ensureReadPermission } from './book_loader.ts';
```

```ts
	const [savedProgress, setSavedProgress] = useState<EpubProgressRecord | null>(null);
```

Load the saved record on mount:

```ts
	useEffect(() => {
		void loadEpubProgress().then(async (progress) => {
			setSavedProgress(progress && (await getEpubBookHandle()) ? progress : null);
		});
	}, []);
```

Add the handler:

```ts
	const handleResumeBook = async () => {
		setBookError('');
		const progress = savedProgress;
		const stored = await getEpubBookHandle();
		if (!progress || !stored) {
			setSavedProgress(null);
			return;
		}
		if (!(await ensureReadPermission(stored.handle))) {
			setBookError(getLocalizedPlaybackError(EPUB_ERROR_CODES.fileAccessDenied) ?? t('bookOpenFailed'));
			return;
		}
		setIsLoadingBook(true);
		try {
			const file = await stored.handle.getFile();
			const book = await openEpubBook(await file.arrayBuffer());
			const session = createEpubSession({
				book,
				file: { name: file.name, size: file.size, lastModified: file.lastModified },
				startChapter: async (payload) => (await sendReaderContent(payload)).success,
				saveProgress: saveEpubProgress,
				now: () => Date.now(),
			});
			epubSessionRef.current = session;
			// A replaced file cannot be trusted to keep its chapter offsets.
			const from = matchesSavedFile(progress, file)
				? { chapterIndex: progress.chapterIndex, charOffset: progress.charOffset }
				: { chapterIndex: 0, charOffset: 0 };
			if (!(await session.start(from))) {
				epubSessionRef.current = null;
				setBookError(t('bookOpenFailed'));
				return;
			}
			setChapterState(session.state());
		} catch (error) {
			setBookError(error instanceof EpubError ? (getLocalizedPlaybackError(error.code) ?? t('bookOpenFailed')) : t('bookOpenFailed'));
		} finally {
			setIsLoadingBook(false);
		}
	};
```

Add the button inside `document-reader-empty-actions`, after the **Open book** button:

```tsx
								{savedProgress && (
									<button
										className="btn btn-secondary"
										type="button"
										disabled={isLoadingBook}
										onClick={() => void handleResumeBook()}
									>
										{t('resumeReading')}: {savedProgress.title} — {t('chapterProgress')} {savedProgress.chapterIndex + 1}/
										{savedProgress.totalChapters}
									</button>
								)}
```

- [ ] **Step 6: Verify the build and full suite**

Run: `CI=true pnpm test:unit && CI=true pnpm build:chrome`
Expected: PASS and a successful build.

- [ ] **Step 7: Manually smoke-test resume**

Read a few paragraphs of an EPUB, close the Reader tab, reopen it.
Expected: the **Continue reading** button appears with the right chapter; clicking it resumes near the saved position.

- [ ] **Step 8: Commit**

```bash
pnpm exec biome check --write src/reader/App.tsx src/reader/book_loader.ts tests/unit/book_loader.test.ts
git add src/reader/App.tsx src/reader/book_loader.ts tests/unit/book_loader.test.ts
git commit -m "feat: resume a saved EPUB from its stored chapter and offset"
```

---

### Task 11: Entry points and local-session behavior

Adds the **Open book** button to Popup and Side Panel, suppresses the now-redundant **Open full reader** for local books, and returns the Reader to its empty state when a local session stops.

**Files:**
- Modify: `src/popup/App.tsx`
- Modify: `src/sidepanel/App.tsx:565-569`
- Modify: `src/reader/App.tsx`
- Test: `tests/unit/local_reader_session.test.ts` (create)

**Interfaces:**
- Consumes: `isFileSystemAccessSupported` (Task 8).
- Produces: `isLocalBookSession(session: PlaybackSessionSnapshot | null): boolean` in `src/shared/local_book_session.ts`

A local book's session has `source.url === source.title` (both are the file name, per Task 6) and no scheme, which distinguishes it from tab-attached PDF/Google Docs sessions whose `url` is a real `https:`/`file:` URL.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/local_reader_session.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalBookSession } from '../../src/shared/local_book_session.ts';
import type { PlaybackSessionSnapshot } from '../../src/shared/types.ts';

function documentSession(url: string, title: string): PlaybackSessionSnapshot {
	return {
		sessionId: 'session-1',
		contentScope: 'article',
		readableSurface: 'document-reader',
		source: { kind: 'tab', tabId: 7, title, url },
		lang: 'en',
		status: 'playing',
		currentParagraphIndex: 0,
		totalParagraphs: 3,
		progressPercentage: 0,
		voiceStyleId: 'M1',
		speed: 1.1,
		updatedAt: 0,
	};
}

test('a locally opened book is recognized', () => {
	assert.equal(isLocalBookSession(documentSession('novel.epub', 'novel.epub')), true);
	assert.equal(isLocalBookSession(documentSession('report.pdf', 'report.pdf')), true);
});

test('a tab-attached PDF or Google Doc is not a local book', () => {
	assert.equal(isLocalBookSession(documentSession('https://example.com/q2.pdf', 'Q2 report')), false);
	assert.equal(isLocalBookSession(documentSession('file:///Users/me/q2.pdf', 'Q2 report')), false);
});

test('non-document surfaces and empty sessions are not local books', () => {
	const website = documentSession('novel.epub', 'novel.epub');
	assert.equal(isLocalBookSession({ ...website, readableSurface: 'website-dom' }), false);
	assert.equal(isLocalBookSession(null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/local_reader_session.test.ts`
Expected: FAIL — cannot find module `local_book_session.ts`.

- [ ] **Step 3: Write the predicate**

Create `src/shared/local_book_session.ts`:

```ts
import type { PlaybackSessionSnapshot } from './types.ts';

/**
 * A locally opened book has no navigable source: the Reader tab is both loader and
 * surface, so its session carries the picked file name in place of a URL.
 */
export function isLocalBookSession(session: PlaybackSessionSnapshot | null): boolean {
	if (!session || session.readableSurface !== 'document-reader' || session.source.kind !== 'tab') {
		return false;
	}
	try {
		new URL(session.source.url);
		return false;
	} catch {
		return true;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/local_reader_session.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the Popup entry point**

In `src/popup/App.tsx`, add the import:

```ts
import { isFileSystemAccessSupported } from '../reader/book_loader';
```

Add the handler next to `handleReadCurrentPage`:

```ts
	const handleOpenBook = () => {
		void chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/reader.html') });
	};
```

Render it directly after the `privacy-disclosure` block's closing `</div>` inside `controls-group`, before that div closes:

```tsx
						{isFileSystemAccessSupported() && (
							<button className="btn btn-secondary btn-open-book" type="button" onClick={handleOpenBook}>
								{t('openBook')}
							</button>
						)}
```

- [ ] **Step 6: Add the Side Panel entry point and suppress the redundant action**

In `src/sidepanel/App.tsx`, add imports:

```ts
import { isFileSystemAccessSupported } from '../reader/book_loader';
import { isLocalBookSession } from '../shared/local_book_session';
```

Change the existing **Open full reader** condition (line 565) so it hides for local books:

```tsx
						{session.readableSurface === 'document-reader' && !isLocalBookSession(session) && (
```

Add the same **Open book** button as the Popup in the Side Panel's no-session branch, next to its existing page-info actions:

```tsx
						{isFileSystemAccessSupported() && (
							<button
								className="secondary-button"
								type="button"
								onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/reader.html') })}
							>
								{t('openBook')}
							</button>
						)}
```

- [ ] **Step 7: Return the Reader to its empty state after a local session stops**

In `src/reader/App.tsx`, add the import and an effect that clears a local snapshot once its session ends. Tab-attached sessions keep today's retain-after-stop behavior.

```ts
import { isLocalBookSession } from '../shared/local_book_session.ts';
```

```ts
	const localOriginRef = useRef(false);

	useEffect(() => {
		if (isLocalBookSession(session)) {
			localOriginRef.current = true;
			return;
		}
		if (session === null && localOriginRef.current && epubSessionRef.current === null) {
			localOriginRef.current = false;
			setSnapshot(null);
			setChapterState(null);
			void loadEpubProgress().then(setSavedProgress);
		}
	}, [session]);
```

- [ ] **Step 8: Verify the build and full suite**

Run: `CI=true pnpm test:unit && CI=true pnpm build && CI=true pnpm validate:manifest`
Expected: PASS, both browser builds succeed, and the manifest validates unchanged.

- [ ] **Step 9: Commit**

```bash
pnpm exec biome check --write src/popup/App.tsx src/sidepanel/App.tsx src/reader/App.tsx src/shared/local_book_session.ts tests/unit/local_reader_session.test.ts
git add src/popup/App.tsx src/sidepanel/App.tsx src/reader/App.tsx src/shared/local_book_session.ts tests/unit/local_reader_session.test.ts
git commit -m "feat: add Open book entry points and local-session reader lifecycle"
```

---

### Task 12: End-to-end coverage

Playwright cannot drive a native file picker, so `window.showOpenFilePicker` is stubbed via `addInitScript` with a handle backed by bytes generated in the page.

**Files:**
- Create: `tests/e2e/epub-reading.spec.ts`
- Create: `tests/e2e/epub_fixture.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildEpubFixture(chapters: { title: string; body: string }[]): Promise<Buffer>`

- [ ] **Step 1: Write the fixture builder**

Create `tests/e2e/epub_fixture.ts`:

```ts
import JSZip from 'jszip';

/** Builds a minimal but structurally valid EPUB 3 archive in memory. */
export async function buildEpubFixture(chapters: { title: string; body: string }[]): Promise<Buffer> {
	const archive = new JSZip();
	archive.file('mimetype', 'application/epub+zip');
	archive.file(
		'META-INF/container.xml',
		`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
	);

	const manifestItems = chapters
		.map((_, index) => `<item id="c${index}" href="chapter${index}.xhtml" media-type="application/xhtml+xml"/>`)
		.join('');
	const spineItems = chapters.map((_, index) => `<itemref idref="c${index}"/>`).join('');
	archive.file(
		'OEBPS/content.opf',
		`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Book</dc:title><dc:language>en</dc:language></metadata><manifest>${manifestItems}</manifest><spine>${spineItems}</spine></package>`,
	);

	chapters.forEach((chapter, index) => {
		archive.file(
			`OEBPS/chapter${index}.xhtml`,
			`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title></head><body><h1>${chapter.title}</h1><p>${chapter.body}</p></body></html>`,
		);
	});

	return archive.generateAsync({ type: 'nodebuffer' });
}
```

- [ ] **Step 2: Write the failing e2e spec**

Create `tests/e2e/epub-reading.spec.ts`:

```ts
import { expect, test } from './fixtures';
import { buildEpubFixture } from './epub_fixture';

const CHAPTERS = [
	{ title: 'Chapter One', body: 'The first chapter has a short body.' },
	{ title: 'Chapter Two', body: 'The second chapter follows the first.' },
];

/** Replace the native picker with one backed by bytes we inject into the page. */
async function stubFilePicker(page: import('@playwright/test').Page, fileName: string, bytes: Buffer) {
	await page.addInitScript(
		({ name, data }) => {
			const file = new File([new Uint8Array(data)], name, { type: 'application/epub+zip', lastModified: 1_700_000_000_000 });
			const handle = {
				name,
				getFile: async () => file,
				queryPermission: async () => 'granted',
				requestPermission: async () => 'granted',
			};
			(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = async () => [handle];
		},
		{ name: fileName, data: Array.from(bytes) },
	);
}

test('opens a local EPUB and renders its first chapter', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(reader, 'fixture.epub', await buildEpubFixture(CHAPTERS));
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await reader.getByRole('button', { name: 'Open book' }).click();

	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter has a short body.');
});

test('shows a resume action for a saved book and hides it when nothing is saved', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(reader, 'fixture.epub', await buildEpubFixture(CHAPTERS));
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await expect(reader.getByRole('button', { name: /Continue reading/ })).toHaveCount(0);

	await reader.getByRole('button', { name: 'Open book' }).click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	const resumed = await context.newPage();
	await stubFilePicker(resumed, 'fixture.epub', await buildEpubFixture(CHAPTERS));
	await resumed.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
	await expect(resumed.getByRole('button', { name: /Continue reading/ })).toBeVisible();
});

test('hides the entry point when the File System Access API is unavailable', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await reader.addInitScript(() => {
		delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
	});
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await expect(reader.locator('.document-reader-empty')).toBeVisible();
	await expect(reader.getByRole('button', { name: 'Open book' })).toHaveCount(0);
});

test('does not persist chapter text to extension storage', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(reader, 'fixture.epub', await buildEpubFixture(CHAPTERS));
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
	await reader.getByRole('button', { name: 'Open book' }).click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	const stored = await reader.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
	expect(stored).not.toContain('The first chapter has a short body.');
	expect(stored).toContain('readit_epub_progress');
});
```

- [ ] **Step 3: Run the spec to verify it fails before a build**

Run: `CI=true pnpm build:chrome && CI=true pnpm exec playwright test tests/e2e/epub-reading.spec.ts`
Expected: initially FAIL if any wiring is incomplete; iterate until all four tests pass.

- [ ] **Step 4: Run the full verification sequence from the spec**

Run each in order, fixing failures before moving on:

```bash
CI=true pnpm test:unit
CI=true pnpm build
CI=true pnpm validate:manifest
CI=true pnpm exec playwright test tests/e2e/epub-reading.spec.ts tests/e2e/document-reader.spec.ts tests/e2e/pdf-reading.spec.ts
CI=true pnpm test:e2e
git diff --check
```

Expected: all pass; `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Refresh the knowledge graph**

Run: `graphify update .`
Expected: the graph rebuilds with the new modules.

- [ ] **Step 6: Commit**

```bash
pnpm exec biome check --write tests/e2e/epub-reading.spec.ts tests/e2e/epub_fixture.ts
git add tests/e2e/epub-reading.spec.ts tests/e2e/epub_fixture.ts graphify-out
git commit -m "test: cover local EPUB loading, resume, and storage boundaries"
```

---

## Spec Coverage

| Spec section | Task |
| --- | --- |
| Entry point in Popup/Side Panel | 11 |
| Reader empty state + file picker | 8 |
| Return to picker after Stop | 11 |
| EPUB parsing (container/OPF/spine, DRM, skip empty) | 4 |
| Memory profile (one chapter at a time, prefetch) | 9 |
| Local PDF parsing | 5, 8 |
| Chapter chaining + natural-completion detection | 7, 9 |
| `START_READER_CONTENT` | 6 |
| Progress persistence (storage + IndexedDB) | 3 |
| Character-offset position and rebasing | 2, 9 |
| Resume flow incl. permission re-grant and changed file | 10 |
| Browser support / capability gating | 8, 11, 12 |
| Error codes and localization | 1 |
| Data & privacy boundaries | 12 (assertion) |
| Verification sequence | 12 |
