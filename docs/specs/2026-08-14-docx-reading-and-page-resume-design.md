# DOCX Reading & Page-Based Resume Design

**Date:** 2026-08-14

**Status:** Approved design

**Scope:** Add `.docx` to the formats the Document Reader can open locally, and give both PDF and DOCX the resume-after-restart behaviour that only EPUB has today. Position for these two formats is anchored to a page number rather than a chapter. Chrome only, for the same File System Access reasons as the EPUB design.

## Summary

`docs/specs/2026-08-12-epub-reading-design.md` shipped local book loading for `.epub` and `.pdf`, but deliberately left local PDF "in-memory-only, unpersisted". As a result, a PDF closed halfway through is a PDF started over. EPUB, meanwhile, persists chapter index plus character offset and resumes across a browser restart.

This design does two things at once because they land on the same code:

1. **A DOCX extractor.** `.docx` is a ZIP holding `word/document.xml`, so it needs nothing beyond the `jszip` and `DOMParser` that `epub_extractor.ts` already uses. No new dependency.
2. **Resume for PDF and DOCX.** Both are modelled as a **single-chapter book with page boundaries**. The existing session and progress store, renamed from `epub_*` to `book_*`, drive them unchanged; the only new concept is an optional list of page-start offsets.

The key observation making (2) cheap: `createEpubSession` never touches EPUB. It consumes `{ title, lang, chapterCount, getChapterText(i) }` and nothing more. Promoting that interface to `BookSource` and letting PDF/DOCX implement it with `chapterCount: 1` reuses `resolveChapterStart()`, the 5-second flush loop, the reload-adopt path, and their tests as they stand.

## Goals

- Open a local `.docx` from the Reader's existing file picker and read it aloud on the Document Reader surface.
- Persist and resume reading position for local PDF and DOCX, including across a browser restart.
- Express that position as a page number the reader can recognise, plus a percentage.
- Repurpose the existing previous/next buttons as page jumps when the open book has pages instead of chapters.
- Reject `.doc` with a message that says what to do about it.
- Leave EPUB behaviour, and every persisted EPUB record, exactly as it is.
- Add no new dependency and no new manifest permission.

## Out of Scope

- **Legacy `.doc`** (Word 97-2003). It is a binary OLE2/CFB container that no browser parses natively; supporting it means adding a binary parser whose JS implementations handle Vietnamese-era encodings poorly. Detected and rejected with a dedicated message.
- **Real chapter splitting for PDF/DOCX** (per-page or per-Heading-1 chapters). This would make resume avoid re-parsing the whole file, and is the natural follow-up, but it is a separate design.
- Header, footer, footnote, endnote and comment text in DOCX — they repeat on every page and are noise when spoken.
- DOCX styling, images, embedded objects, tracked changes, and content controls.
- Page numbers for DOCX that match what Word displays (see Pagination below).
- A multi-book library. As today, one current book at a time.
- Firefox. Unchanged from the EPUB design: no `showOpenFilePicker()`, no persistable handles.

## Domain Model

### `BookSource`

`EpubBook` is renamed and gains one optional field:

```ts
// src/shared/book_source.ts
export interface BookSource {
	title: string;
	lang: string;
	chapterCount: number;
	getChapterText(index: number): Promise<string>;
	/** Character offsets where each page starts, within chapter 0's text.
	 *  Present only on single-chapter books (PDF, DOCX). */
	pageStarts?: readonly number[];
}
```

One field distinguishes the two navigation modes:

| | `chapterCount` | `pageStarts` | Navigation unit |
|---|---|---|---|
| EPUB | n | absent | chapter |
| PDF | 1 | page offsets | page |
| DOCX | 1 | virtual page offsets | page |

A book cannot be in both modes. `pageStarts` is only read when `chapterCount === 1`; anything else is a programming error and the session ignores the field.

`pageStarts[0]` is always `0`. An empty or absent list means the whole text is one page, and the previous/next buttons are hidden.

### Position

Position stays what it is today: a character offset into the current chapter's text. Page number is **derived** from that offset by binary search over `pageStarts`, never stored alongside it. One source of truth means the page shown can never disagree with the audio.

## Pagination

**PDF pages are real.** `extractPdfArticleFromBytes()` already builds `pages: string[]` and joins them with `\n\n`; accumulating lengths during that join yields `pageStarts` exactly. It is returned as a new optional `pageStarts` field on `PdfArticleResponse` itself, *not* on `Article`: `Article` is serialised across `chrome.runtime` messages into the background and offscreen, and a few hundred numbers do not belong in that payload. The URL-based extraction path simply ignores the new field. Pages that extract to empty text are skipped today and stay skipped, so the reported page count is the count of pages that have text; for documents with image-only pages it can be lower than the PDF's own page count.

**DOCX pages are not real.** A `.docx` file does not store pagination; Word computes it at layout time from font metrics, page size and printer driver. The file offers only manual page breaks (`w:br w:type="page"`) and `w:lastRenderedPageBreak` hints that Word writes opportunistically and are absent from files produced by other tools.

DOCX therefore uses **virtual pages**: a fixed target of 1800 characters, cut at the nearest paragraph boundary.

```ts
// src/shared/virtual_pages.ts
export function computeVirtualPageStarts(text: string, targetChars = 1800): number[];
```

A pure function over the normalised text, independent of DOCX. Properties it must hold:

- Always returns at least `[0]`.
- Every returned offset is either `0` or the first character after a `\n\n` separator.
- Strictly increasing.
- Deterministic: the same text always produces the same pages, so a saved page number stays meaningful between sessions.

These numbers will not match Word's. That is an accepted, stated trade-off: what matters is that "page 12 of 240" is stable and locates a position, not that it agrees with another program's layout engine.

## DOCX Extraction

New `src/shared/docx_extractor.ts`, following `epub_extractor.ts`'s shape — a `DocxError` carrying a code, and an injectable `parseXml` dependency so tests need no DOM.

```ts
export async function extractDocxText(
	bytes: ArrayBuffer,
	fallbackTitle: string,
	dependencies?: DocxExtractorDependencies,
): Promise<{ title: string; lang: string; content: string }>;
```

Steps:

1. `JSZip.loadAsync(bytes)`; failure → `parseFailed`.
2. Read `word/document.xml`; missing → `parseFailed`.
3. Parse as `text/xml` and walk `w:p` elements in document order. Paragraphs inside `w:tbl` are `w:p` too, so table text is picked up in place without special handling.
4. Per paragraph: concatenate `w:t` text; `w:tab` and `w:br` become a space. Only `w:body` descendants are visited, which is what excludes headers, footers, footnotes and comments — they live in separate parts (`word/header1.xml`, `word/footnotes.xml`, …) that are never opened.
5. Join through the existing `normalizeChapterText()` from `epub_extractor.ts`: collapse whitespace, drop empty blocks, join with `\n\n`.
6. Empty result → `textUnavailable`.
7. `title` from `dc:title` in `docProps/core.xml`, falling back to the file name — mirroring `documentTitle()` in `pdf_extractor.ts`.
8. `lang` from `detectContentLanguage(content, 'na')`, identical to the PDF path.

## Session

`src/reader/epub_session.ts` → `src/reader/book_session.ts`; `EpubSession` → `BookSession`; `createEpubSession` → `createBookSession`. Existing logic is unchanged — this is a rename plus the page mode below.

`state()` changes shape:

```ts
state(): { kind: 'chapter' | 'page'; index: number; count: number }
```

In page mode (`chapterCount === 1` and `pageStarts` non-empty):

- `advance()` / `previous()` play chapter 0 from `pageStarts[index ± 1]` via the existing `playChapter(0, offset)`. `resolveChapterStart()` already slices text at an offset and reports the base for highlight mapping, so no new positioning code is written.
- Stepping past the last or before the first page returns `false`, exactly as running out of chapters does. `App.tsx` already distinguishes the two callers: a button press that returns `false` leaves playback alone, whereas natural completion returning `false` hands the tab back to the picker.
- `recordPosition()` is untouched; `state().index` is recomputed from the stored offset by binary search over `pageStarts`.

Natural completion in page mode deserves a note: PDF and DOCX submit their whole text as one playback session, so `DOCUMENT_READER_COMPLETED` fires once, at the end of the document — not per page. Page mode's `advance()` is therefore driven by the buttons, and the completion handler's `advance()` call correctly returns `false` and ends the book.

## Progress Store

`src/shared/epub_progress_store.ts` → `src/shared/book_progress_store.ts`; `EpubProgressRecord` → `BookProgressRecord`; `EpubBookHandleRecord` → `BookHandleRecord`. Function names follow (`saveBookProgress`, `loadBookProgress`, `putBookHandle`, …).

**The persisted keys do not change.** `STORAGE_KEYS.EPUB_PROGRESS` and the IndexedDB database name `readit-epub-library` keep their current values. Renaming them would orphan the progress of every reader currently partway through a book, for a cosmetic gain.

The record gains one optional field:

```ts
interface BookProgressRecord {
	title: string;
	chapterIndex: number;   // always 0 for PDF/DOCX
	charOffset: number;
	totalChapters: number;  // always 1 for PDF/DOCX
	totalChars?: number;    // new; drives the percentage
	fileSize: number;
	fileLastModified: number;
	updatedAt: number;
}
```

`isBookProgressRecord()` must accept `totalChars` being absent, so records written by the current release still load. A record without it shows no percentage rather than showing `0%`.

Which extractor to reopen with is decided by `detectBookKind(handleRecord.fileName)` — the handle record already carries the file name, so no format tag is persisted.

`matchesSavedFile()` (size plus `lastModified`) is format-agnostic and stays as is.

## Reader UI

`src/reader/App.tsx`:

- `openEpubSession(file)` becomes `openBookSession(file, kind)`, switching on kind to build a `BookSource`: `epub` → `openEpubBook()`; `pdf` → `extractPdfArticleFromBytes()` wrapped as a one-chapter source with `pageStarts`; `docx` → `extractDocxText()` plus `computeVirtualPageStarts()`.
- `handleOpenBook()` loses its special PDF branch. All three formats take the same path, and **all three store the file handle** — PDF not storing one is precisely why it cannot resume today.
- `handleResumeBook()` and the post-reload adopt effect resolve the format from the stored file name and go through `openBookSession`.
- `chapterState` becomes `positionState` carrying `state()`'s discriminated shape. Previous/next render only when `count > 1`, labelled `previousChapter`/`nextChapter` or `previousPage`/`nextPage`. PDF and DOCX no longer show two permanently disabled buttons.
- The resume line keeps `chapterProgress` for EPUB and uses a new `pageProgress` string for PDF/DOCX: title, `page X/Y`, and `round(charOffset / totalChars * 100)%`.

`book_loader.ts`: `BookKind` becomes `'epub' | 'pdf' | 'docx'`, and `detectBookKind()` returns `BookKind | 'doc-legacy' | null` — `.doc` is named rather than lumped in with `null`, so the caller shows the legacy-format message instead of the generic failure. The picker accepts the DOCX MIME type, and also `application/msword` — a `.doc` the user can select and get an explanation for beats a `.doc` greyed out for no visible reason.

## Errors

```ts
export const DOCX_ERROR_CODES = {
	parseFailed: 'docxParseFailed',
	textUnavailable: 'docxTextUnavailable',
	legacyFormat: 'docLegacyFormat',
} as const;
```

Wired into `getPlaybackErrorTranslationKey()` alongside the PDF and EPUB codes. New strings in `locales/en.json` and `locales/vi.json`: `docxParseFailed`, `docxTextUnavailable`, `docLegacyFormat` ("Word 97-2003 `.doc` is not supported — save the file as `.docx` and try again"), `previousPage`, `nextPage`, `pageProgress`.

## Testing

New:

- `tests/unit/docx_extractor.test.ts` — archives built with `jszip` in the test itself: multi-paragraph body; `w:tab` and `w:br`; text inside a table; `dc:title` present and absent; corrupt ZIP; document with no text.
- `tests/unit/virtual_pages.test.ts` — the four properties listed under Pagination, plus text shorter than one page and empty text.

Changed:

- `tests/unit/epub_session.test.ts` → `book_session.test.ts`, with page-mode cases: advance and previous jump to the right offsets, stepping past either end returns `false`, page index is derived correctly from an arbitrary offset, and chapter mode still behaves exactly as before.
- `tests/unit/epub_progress_store.test.ts` → `book_progress_store.test.ts`, including a record written without `totalChars` still loading.
- `tests/unit/pdf_extractor.test.ts` — `pageStarts` matches the joined page text, and empty pages are accounted for.
- `tests/unit/book_loader.test.ts` — `.docx`, `.DOCX`, `.doc`, and existing negatives.
- `tests/e2e/document-reader.spec.ts` — open a `.docx` fixture and play it; open a PDF, reload, and see the resume entry with the right page and percentage.

## Risks

**Resume re-parses the whole file.** A resumed PDF runs through pdf.js again before the first word is spoken; a few hundred pages takes seconds, covered by the existing `isLoadingBook` spinner. Real chapter splitting is the fix, and is out of scope here.

**Virtual page numbers differ from Word's.** Stated in the UI's terms only as "page X/Y"; readers comparing against Word will see a mismatch. Accepted in exchange for numbers that are stable and testable.

**The rename touches many files.** It is mechanical — identifiers only, no behaviour, no persisted key. Type checking and the existing unit suite cover it.
