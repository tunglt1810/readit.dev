# EPUB Reading & Local Book Loading Design

**Date:** 2026-08-12

**Status:** Approved design

**Scope:** Let readit.dev open a local `.epub` or `.pdf` file directly (not tied to an open browser tab), read it aloud with word highlighting in the existing Document Reader surface, and — for EPUB specifically — persist reading progress locally so the book can be resumed after the browser is closed. EPUB content is streamed one chapter at a time to bound memory use for long books. Chrome only; see Browser Support.

## Summary

Today, PDF playback only starts from a PDF already open in the active browser tab (`https://` or `file://` URL). There is no way to pick a local file directly, and there is no reader entry point that exists independently of an active playback session.

This design adds:

1. A **"Open book"** entry point in the Popup and Side Panel that opens/focuses the extension's existing `src/reader/reader.html` page.
2. A file picker on the Reader's empty state, built on the File System Access API, accepting both `.epub` and `.pdf`.
3. An EPUB adapter (`src/shared/epub_extractor.ts`) that parses the container/OPF/spine and yields chapter text **one chapter at a time**, so only one chapter's decompressed text is ever resident.
4. A **chapter-chaining coordinator** living in the Reader page that plays chapters back-to-back as independent playback sessions through the existing pipeline, with no changes to the offscreen synthesis engine.
5. **Persisted EPUB progress** (`chrome.storage.local` for position, IndexedDB for the retained file handle) so the same book can be resumed — including after a full browser restart — without re-browsing for the file.
6. A refactor of `pdf_extractor.ts` to accept raw bytes directly (`extractPdfArticleFromBytes`), so a locally picked PDF reuses the exact same parsing and Document Reader path as URL-based PDF reading today. Local PDF reading remains fully in-memory and unpersisted, matching its existing behavior.

Both formats converge on one new background message, `START_READER_CONTENT`, which creates a tab-owned `document-reader` playback session pointing at the *calling* reader tab — the reverse of PDF-from-tab, where a source tab exists first and the reader tab attaches to it afterward.

## Goals

- Open a local `.epub` or `.pdf` file from a dedicated entry point, independent of any browser tab's URL.
- Read EPUB content aloud with the same word-highlighting Document Reader surface already used for PDF/Google Docs.
- Never hold more than one EPUB chapter's decompressed text at a time.
- Persist EPUB reading position (chapter + character offset) locally and resume it, including across browser restarts.
- Reuse the existing playback, TTS, highlighting, and Document Reader machinery without modifying the offscreen synthesis engine.
- Keep local PDF loading's memory/persistence behavior identical to today's URL-based PDF reading.
- Add no new manifest permission.

## Out of Scope

- **Firefox support.** See Browser Support below.
- DRM-protected EPUB (Adobe ADEPT or any `encryption.xml` entry) — detected and rejected, not decrypted.
- A multi-book library UI. Only one "current book" is tracked at a time; opening a new file replaces it.
- A table-of-contents navigation UI. The nav document decides the chapter list (see below), but there is no chapter picker; chapters play in spine order and are stepped one at a time.
- Progress persistence or resume for locally opened PDFs — they keep today's in-memory-only behavior.
- Windowing/pagination *within* a single chapter's text.
- Gapless audio across chapter boundaries (see Chapter Chaining for why a short gap is inherent).
- MP3 audio export for EPUB sessions (the existing per-session export feature is unaffected but not specifically extended here).
- Cross-device sync of reading progress.
- OCR, scanned/image-only PDFs (unchanged from existing PDF design).

## Browser Support

This feature is **Chrome-only**. It depends on the File System Access API for both picking a file and — critically — retaining a `FileSystemFileHandle` so resume does not require re-browsing for the book. Firefox implements neither `showOpenFilePicker()` nor persistable file handles, so the resume story cannot be delivered there.

The repository ships a real Firefox build (`browser_specific_settings.gecko`, `strict_min_version: 115.0`, an approved AMO listing), and `rsbuild.config.ts` already strips Chrome-only capabilities from the Firefox manifest (`sidePanel`, `offscreen`, `file://*/*`). This feature follows that precedent, but at the UI layer: because `rsbuild.config.ts` does not expose the build target to source code, the codebase's existing idiom is **runtime capability detection** (see `getDefaultBrowserApi()` in `src/shared/browser.ts`, which branches on `sidebarAction` vs `sidePanel`).

Accordingly, the **"Open book"** entry point renders only when `typeof window.showOpenFilePicker === 'function'`. On Firefox — and on any Chrome build lacking the API — the button is absent rather than present-but-broken. No fallback loading path is built.

## Domain Model

No new `ReadableSurfaceKind` and no new `PlaybackSessionSnapshot` source variant are required. `TabPlaybackSessionSnapshot`'s existing `article` variant already has the needed shape:

```ts
source: { kind: 'tab'; tabId: number; title: string; url: string }
```

For a locally opened book, `tabId` is the Reader tab's own ID — the Reader tab is simultaneously the loader and the display surface, unlike PDF/web where `source.tabId` points at a separate content tab.

`source.url` carries the picked file's name (e.g. `book.epub`). It is an identifying label only: it is never fetched or navigated to. Consumers already tolerate a non-URL value — `getHost()` in `src/popup/App.tsx` wraps `new URL()` in a try/catch and falls back to the raw string.

| Content Source | Readable Surface | `source.tabId` points at |
| --- | --- | --- |
| Website / Google Docs / PDF-from-tab (existing) | `website-dom` / `document-reader` | the content tab |
| **Local EPUB chapter (new)** | `document-reader` | the Reader tab itself |
| **Local PDF (new)** | `document-reader` | the Reader tab itself |

Because the Reader tab is the source tab for local books, the Side Panel's existing **Open full reader** action is redundant for these sessions and is suppressed for them (it remains unchanged for tab-attached PDF/Google Docs sessions).

## Architecture

### Entry point

`src/popup/App.tsx` and `src/sidepanel/App.tsx` each get an **"Open book"** button, always visible when supported (not dependent on an active session), calling `chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/reader.html') })` — the same path `openDocumentReader()` already uses — or focusing an already-open Reader tab. This button only opens/focuses the tab; it does not itself invoke a file picker, so it is unaffected by the Popup's close-on-blur behavior.

### Reader empty state

When no `document-reader` session is attached, the empty state shows:

- **"Open book"** (primary) — invokes `window.showOpenFilePicker({ types: [{ description: 'Books', accept: { 'application/pdf': ['.pdf'], 'application/epub+zip': ['.epub'] } }] })` from within the click handler (the API requires a user gesture), then branches on the returned handle's file extension/MIME.
- **"Continue reading: `<title>` — Chapter X/Y"** (secondary, only rendered if a saved EPUB progress record and file handle both exist) — see Resume below.

### Returning to the file picker after Stop

Existing Document Reader behavior (unchanged) keeps a tab-attached PDF/Google Docs session's rendered text visible after Stop — the Reader "may retain its in-memory text" per the original document-reader design, with no file-picker affordance to return to. Local sessions need the opposite: after Stop (or after the last chapter of a book finishes), the empty state must become reachable again so the same Reader tab can load a different book without opening a new tab.

Detecting "the user stopped" from session state alone is not reliable: the background broadcasts a null session *before* it broadcasts `DOCUMENT_READER_COMPLETED`, so a null session is indistinguishable from the gap between two chapters. Rather than race that ordering, the Reader offers the picker through two deterministic paths:

- **Always reachable:** while a book is rendered, the Reader header shows **"Open book"**, so another book can be picked at any time — including mid-book, without stopping first.
- **End of book:** when `advance()` reports no further chapter, the Reader clears its snapshot directly in that branch and returns to the empty state with the picker and any resume action.

Stop mid-book leaves the current chapter rendered, matching existing Document Reader behavior; the header action remains available.

### EPUB parsing (`src/shared/epub_extractor.ts`)

Runs inside the Reader page (a normal document context with `DOMParser`/`Blob`), not the background service worker, which has neither. Uses `jszip` (new production dependency, matching the precedent of bundling `pdfjs-dist` for PDF).

Parsing steps:

1. Read `META-INF/container.xml` to locate the root `.opf` file.
2. Parse the `.opf` manifest (id → href/media-type) and spine (ordered list of manifest ids) with `DOMParser`.
3. Reject the book with `epubDrmProtected` if `META-INF/encryption.xml` is present.
4. Read `dc:title` and `dc:language` from the OPF metadata for the book title and language, falling back to `detectContentLanguage()` as PDF does.
5. Expose `getChapterText(chapterIndex): Promise<string>` — decompresses **only the spine entries that chapter spans** (usually one), parses each as XHTML, walks block-level elements, and joins them with blank lines (same normalization style as `normalizeText()` in `pdf_extractor.ts`). Chapters with no extractable text are skipped by walking on to the next one.

**Memory profile (stated precisely).** JSZip requires the whole archive to be loaded to read its central directory, so the *compressed* `.epub` bytes stay resident for the reading session. What this design bounds is *decompressed* text: only the current chapter's (plus, briefly, the prefetched next chapter's) text exists at a time, instead of the entire book's. For a text-heavy long book that is the dominant cost — a multi-megabyte EPUB is mostly compressed markup and images, while its fully decompressed text would otherwise all be resident and additionally normalized/word-mapped by the TTS pipeline. The previous chapter's text is released by dropping the reference; normal GC reclaims it and no explicit cleanup path is needed.

### Local PDF parsing

`pdf_extractor.ts` is refactored to separate byte-fetching from parsing:

```ts
export async function extractPdfArticleFromBytes(
  bytes: Uint8Array,
  title: string,
  dependencies: { loadDocument(data: Uint8Array): Promise<PdfDocument> },
): Promise<PdfArticleResponse>
```

This is the existing page-by-page extraction logic (`normalizePageText`, `documentTitle`, error mapping) with the fetch step removed. `extractPdfArticle()` (URL-based, used by `requestCurrentTabArticle`) becomes a thin wrapper: fetch bytes, then delegate. The Reader's local-file path reads bytes via `(await handle.getFile()).arrayBuffer()` and calls `extractPdfArticleFromBytes()` directly — no network fetch, and no `file://*/*` host permission involved, since the bytes come from the File System Access API rather than `fetch`.

Local PDFs get **no** progress persistence: identical to today's URL-based PDF, the whole `Article` goes to `document-reader` in one `START_READER_CONTENT` call, entirely in memory, nothing written to `chrome.storage`.

### Chapter chaining (EPUB only)

A coordinator inside the Reader page (`src/reader/epub_session.ts`) owns the open archive/spine list, the current chapter index, and orchestration. It does not touch the offscreen synthesis engine — each chapter is dispatched as an independent playback session through the unchanged `startPlayback()` pipeline:

1. Parse chapter N's text.
2. Send `START_READER_CONTENT` to background with that text as content.
3. Background creates/replaces the tab-owned `document-reader` session (`source.tabId` = this Reader tab) and starts playback exactly as for any other `Article`. Session replacement reuses the existing Readable Surface lifecycle (`activate()` in `src/background/readable_surface.ts`), which discards the prior chapter's projection state automatically — no separate cleanup code is needed.
4. On natural completion of chapter N (see below), the coordinator loads chapter N+1 and repeats.
5. **Prefetch:** chapter N+1's text is parsed once chapter N's `progressPercentage` passes ~80%, removing decompression/parse latency from the boundary.

**Detecting natural completion.** `completedNaturally` currently exists only on the offscreen→background progress message and is consumed in place by `applyProgressMessage()` (`src/background/background.ts`) to drive playlist-queue auto-advance. It is **not** part of `PlaybackSessionSnapshot`, so a page observing `subscribePlaybackState()` sees `status: 'stopped'` for both a finished chapter and a user-pressed Stop. Chaining on `stopped` alone would wrongly auto-advance when the user stops.

Background therefore broadcasts a new runtime message at the point where it already computes the flag, when the completed session was a `document-reader` session:

```ts
{ action: 'DOCUMENT_READER_COMPLETED'; sessionId: string }
```

The coordinator advances to the next chapter **only** on this message, matching the session ID it started. An explicit Stop produces no such message and ends the book session, returning the Reader to its empty state.

**Chapter-boundary gap.** Each chapter is a new playback session, so after prefetching text the pipeline still has to normalize, segment, and synthesize the first audio segment before sound resumes. A short gap at each boundary is therefore inherent to this design; prefetch removes only the parse portion. Eliminating it entirely would require the offscreen engine to accept appended content mid-session, which is out of scope.

Because each chapter is its own session, `currentParagraphIndex`/`totalParagraphs`/`progressPercentage` are chapter-relative. The Reader additionally displays "Chapter X/Y" from the chapter list (see *Chapters come from the table of contents* below), since the true whole-book word count is unknown without pre-parsing every chapter, which would defeat the memory goal.

### Manual chapter navigation (EPUB only)

Chaining alone only ever moves forward, which leaves a chapter the reader has already heard — or resumed part-way into — unreachable. The Reader toolbar therefore carries a previous/next pair of icon buttons beside the transport controls, rendered only while a book session is open (`chapterState !== null`).

Both directions share one walk: `seek(from, step)` starts at `from` and moves by `step` until a chapter with extractable text plays, so the empty-spine-entry skipping already applied to `advance()` holds in reverse too. `advance()` is `seek(chapterIndex + 1, 1)`; `previous()` is `seek(chapterIndex - 1, -1)`.

A jump replays the target chapter from its beginning at once — the same `playChapter()` path natural completion takes, so it needs no additional "loaded but paused" state. Two behaviours distinguish an explicit jump from natural completion:

- **Running out of chapters is a no-op, not the end of the book.** `seek()` mutates nothing when it finds no readable chapter, so the chapter currently playing simply carries on. Only completion-driven `advance()` returns the tab to the picker.
- **The stale-session guard already covers the replaced chapter.** Starting the new chapter makes its session id the one `isPlaying()` accepts, and replacement is not a natural completion, so the outgoing chapter cannot chain anything behind the jump.

Both buttons are disabled at the ends of the chapter list (`chapterIndex === 0`, `chapterIndex >= chapterCount - 1`).

### Chapters come from the table of contents, not the spine

The spine is a file list, not a chapter list: covers, title pages, and the contents page each hold a slot. Numbering those slots names the first readable page of *Hoàng Tử Bé* "Chapter 2/12" and leaves a previous button that can never move. Deciding emptiness instead would mean decompressing every slot, which the memory goal above forbids — and would still count the title page as a chapter.

So the book's own navigation decides the chapter list. `openEpubBook()` reads whichever table of contents the book ships:

- **EPUB 3** — the manifest item carrying `properties="nav"`, whose `<nav epub:type="toc">` holds the destinations.
- **EPUB 2** — the NCX named by `<spine toc="...">`, where each `navPoint` names one destination.

`buildChapterList(spinePaths, tocEntries)` turns those destinations into chapters:

- A destination's fragment is dropped; the spine file it lands in is the target.
- Entries are ordered by **spine** position. The spine is the definitive reading order, so a navigation document that disagrees with it cannot reorder playback.
- A chapter spans every spine slot from its own target up to the next one. Books split a chapter across several files and name only the first, so dropping the unnamed continuations would silently lose text.
- Two entries landing in the same file are one chapter — the second is a sub-section, not a new chapter.
- Slots before the first destination are front matter the book itself declined to navigate to, and are not read.
- A missing, unreadable, or dangling table of contents falls back to one chapter per spine slot, which is the behaviour every book had before.

`EpubProgressRecord.chapterIndex` indexes this chapter list. A record written against a different `totalChapters` was numbered by a different list, so `resolveResumePoint()` in the Reader discards it and starts the book from its first chapter rather than resuming at a chapter that has moved.

### `START_READER_CONTENT` message

One new background message, shared by local PDF and EPUB chapters:

```ts
interface StartReaderContentMessage {
  action: 'START_READER_CONTENT';
  payload: { tabId: number; title: string; content: string; lang: string };
}
```

Background creates a `TabPlaybackSessionSnapshot` (`contentScope: 'article'`, `readableSurface: 'document-reader'`, `source: { kind: 'tab', tabId, title, url: <file name> }`) and calls the existing `startPlayback()`. Background does not need to know whether the content is a whole PDF or one EPUB chapter.

### Progress persistence & resume (EPUB only)

**Storage:**

- `chrome.storage.local[STORAGE_KEYS.EPUB_PROGRESS]` — `{ title, chapterIndex, charOffset, totalChapters, fileSize, fileLastModified, updatedAt }`. Small, no book content.
- IndexedDB database `readit-epub-library`, store `handles`, fixed key `'current-book'` — `{ handle: FileSystemFileHandle, fileName, fileSize, fileLastModified }`. `chrome.storage` cannot hold a `FileSystemFileHandle` (not JSON-serializable); IndexedDB can, via structured clone.

**Position is stored as a character offset, not a word index.** Resuming by word index would require mapping word N back to a character offset with `mapDocumentReaderWords(content, words)`, but its `words: ReadableSurfaceWord[]` argument is produced by the offscreen TTS pipeline and only exists inside a live `DocumentReaderSnapshot`. At resume time, before playback starts, the Reader has no such array, so that mapping is unavailable.

The Reader already computes the needed value while playing: `wordRanges[currentWordIndex].start` (`src/reader/App.tsx`), where `wordRanges = mapDocumentReaderWords(snapshot.content, snapshot.words)`. Saving that character offset makes resume a plain `chapterText.slice(charOffset)` with no dependency on the word list.

**Offsets must be rebased.** When a chapter was itself resumed mid-way, `snapshot.content` is already a slice, so its offsets are relative to that slice. The coordinator records the slice's base offset within the full chapter and persists `baseOffset + wordRanges[currentWordIndex].start`. Without this, repeated resumes would drift backwards toward the chapter start.

**Write cadence:** debounced to roughly once per 5s while a chapter is playing, plus immediate writes on chapter change, pause, stop, and the Reader tab's `beforeunload`.

**Resume flow:**

1. The Reader loads with no active session and checks `chrome.storage.local` and IndexedDB for a saved book.
2. If both exist, it shows "Continue reading: `<title>` — Chapter X/Y".
3. On click (the required user gesture): call `handle.queryPermission({ mode: 'read' })`; if not `'granted'`, call `requestPermission({ mode: 'read' })` within the same gesture. Chrome may re-grant silently if the browser has not restarted, or show its native prompt.
4. If denied, show `epubFileAccessDenied` and keep the saved progress so the user can retry.
5. Otherwise re-open the file, re-parse the spine (cheap — no chapter text yet), jump to `chapterIndex`, parse that chapter, slice at `charOffset`, and start playback as above.
6. If the file's current `size`/`lastModified` no longer match the saved record, treat it as a different edition and resume from chapter 0 rather than failing.

**Service-worker eviction.** The offscreen `DocumentReaderSnapshot` is memory-only, so an evicted worker/offscreen pair can leave a session that the Reader can no longer re-attach to — existing, documented Document Reader behavior. For EPUB this is recoverable rather than terminal: the persisted progress record plus the retained handle let the user restart the book at the saved position through the normal resume path.

## UX and Failure Contract

| Situation | Handling |
| --- | --- |
| Picked file is not a valid zip / missing `container.xml` or `.opf` | `epubParseFailed` |
| `META-INF/encryption.xml` present | `epubDrmProtected` |
| Permission denied on resume | `epubFileAccessDenied`, saved progress retained |
| A spine chapter has no extractable text | Skipped silently, in whichever direction the walk is going |
| Local PDF fails to parse | Reuses existing `pdfPasswordProtected` / `pdfTextUnavailable` / `pdfExtractionFailed` codes |
| `showOpenFilePicker` unavailable (Firefox) | Entry point not rendered at all |

New codes are added to `src/shared/constants.ts` as `EPUB_ERROR_CODES`, mirroring the existing `PDF_ERROR_CODES` pattern, and localized (EN/VI) through `getLocalizedPlaybackError()` in `src/shared/i18n.ts`.

## File Map

| File | Change |
| --- | --- |
| `package.json` | Add `jszip`. |
| `src/shared/epub_extractor.ts` | New. Container/OPF/spine parsing; nav/NCX table-of-contents parsing into the chapter list; per-chapter text extraction. |
| `src/reader/epub_session.ts` | New. Chapter-chaining coordinator: prefetch, completion-driven advance, manual previous/next jumps, progress writes, resume orchestration. |
| `src/shared/epub_progress_store.ts` | New. Reads/writes `chrome.storage.local` progress and the IndexedDB file handle. |
| `src/background/pdf_extractor.ts` | Split fetch from parse; add `extractPdfArticleFromBytes()`. |
| `src/background/background.ts` | Handle `START_READER_CONTENT`; broadcast `DOCUMENT_READER_COMPLETED` on natural completion of a document-reader session. |
| `src/reader/App.tsx` | Empty state: "Open book" file picker (PDF/EPUB branch) and conditional "Continue reading"; local-origin Stop returns to empty state; offset tracking for progress writes; previous/next chapter buttons in the toolbar. |
| `src/shared/components/PlaybackIcon.tsx` | Add `previous` / `next` skip glyphs. |
| `src/popup/App.tsx`, `src/sidepanel/App.tsx` | Add capability-gated "Open book" entry point; suppress "Open full reader" for local-book sessions. |
| `src/shared/constants.ts` | `EPUB_ERROR_CODES`, `STORAGE_KEYS.EPUB_PROGRESS`. |
| `src/shared/i18n.ts` | EN/VI strings for new errors and labels. |
| `tests/unit/epub_extractor.test.ts` | New. Valid/invalid/DRM fixtures; chapter extraction; offset slicing and rebasing. |
| `tests/unit/pdf_extractor.test.ts` | Extend for `extractPdfArticleFromBytes()`. |
| `tests/e2e/epub-reading.spec.ts` | New. Auto chapter advance; Stop does not advance; resume after simulated restart; permission-denied path. |

## Data and Privacy Boundaries

- No new manifest permission. The File System Access API is a page-level Web API gated by a native OS picker and a user gesture; it requires no extension permission declaration and does not use `file://*/*`.
- EPUB/PDF bytes and extracted text exist only in the Reader page's memory and the existing offscreen/background playback path — never logged, transmitted, or included in telemetry.
- The only persisted EPUB data is the small progress record (title, chapter index, character offset, file identity, timestamp) and the retained `FileSystemFileHandle` — never chapter text.
- Local PDF reading persists nothing, matching the existing PDF design's privacy boundary exactly.

## Testing and Verification

### Unit tests

- Parse a valid EPUB fixture's container/OPF/spine and extract chapter text in spine order.
- Reject malformed zips and missing `container.xml`/`.opf` with `epubParseFailed`.
- Reject a fixture containing `encryption.xml` with `epubDrmProtected`.
- Skip an image-only chapter and continue to the next, and to the previous one when walking back.
- Going back from the first chapter changes nothing and leaves the playing chapter free to keep chaining.
- The table of contents decides the chapter list: front matter before the first destination is not a chapter, an unnamed spine slot is read as part of the chapter before it, two destinations in one file are one chapter, nav order does not override spine order, and a book with no usable navigation falls back to one chapter per spine slot.
- Slicing a chapter at a saved character offset yields text starting at the expected word.
- Rebasing: saving a position inside an already-sliced chapter produces an absolute offset, and resuming twice in a row does not drift.
- `extractPdfArticleFromBytes()` produces the same `Article` as the existing URL-based path for an identical PDF fixture.

### End-to-end tests

- Open an EPUB fixture via the file picker (mocked), confirm chapter 1 plays with highlighting, and confirm advance to chapter 2 on `DOCUMENT_READER_COMPLETED`.
- Press Stop mid-chapter and confirm the Reader does **not** advance and returns to the empty state.
- Jump forward with the next-chapter button and back with the previous one; confirm each is disabled at its end of the chapter list.
- Resume a saved book at a later chapter and confirm the previous button still reaches the chapter before it.
- Open a fixture with front matter the navigation skips; confirm it is neither counted nor read, and that the previous button is disabled on the opening chapter.
- Open a fixture with a spine slot the navigation never names; confirm its text is read as part of the chapter before it.
- Pre-seed `chrome.storage.local`/IndexedDB, reload the Reader, and confirm "Continue reading" resumes at the correct chapter and offset.
- Simulate `requestPermission()` denial on resume; confirm `epubFileAccessDenied` is shown, progress is retained, and no crash occurs.
- Open a local PDF via the same picker; confirm it reaches `document-reader` with no `chrome.storage` writes and no "Continue reading" affordance.
- Confirm the Popup/Side Panel "Open book" button opens/focuses the Reader without requiring an active session, and is absent when `showOpenFilePicker` is undefined.

### Verification sequence

Run sequentially:

1. `CI=true pnpm test:unit`
2. `CI=true pnpm build`
3. `CI=true pnpm validate:manifest`
4. Targeted EPUB/PDF-local Playwright tests
5. `CI=true pnpm test:e2e`
6. `git diff --check`
7. `graphify update .`

## Acceptance Criteria

- A non-DRM EPUB opened via "Open book" plays through TTS with word highlighting in the Document Reader.
- At most one chapter's decompressed text (plus one prefetched chapter) is resident at a time; the whole book's text is never decompressed at once.
- Chapters advance automatically on natural completion, and only on natural completion — an explicit Stop does not advance.
- Any chapter already read can be reached again: the previous/next buttons jump one chapter at a time and play it from the start, and running past the end of the chapter list leaves the current chapter playing rather than ending the book.
- "Chapter X/Y" counts the chapters the book's own table of contents names, so the chapter a book opens on is chapter 1 and the previous button is disabled there — front matter is neither numbered nor read.
- Another book can be picked at any time from the Reader header, and finishing the last chapter returns the tab to the file-picker empty state.
- EPUB chapter and character offset survive closing and reopening the browser, modulo re-granting file access, without drift across repeated resumes.
- A locally picked PDF reuses the existing PDF parsing/highlighting path with no persistence and no "Continue reading" affordance.
- The entry point is absent on builds/browsers without `showOpenFilePicker`; the Firefox build is otherwise unaffected.
- No new manifest permission is introduced.
- Existing website, Google Docs, and tab-based PDF reading behavior is unchanged, including retaining rendered text after Stop.
