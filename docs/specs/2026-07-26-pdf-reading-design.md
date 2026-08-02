# PDF Reading Design

**Date:** 2026-07-26

**Status:** Approved design

**Scope:** Let readit.dev read text-layer PDFs opened in the active Chrome tab from an HTTPS URL or a local `file://` URL. The provided Anthropic PDF is a representative HTTPS source.

## Summary

Chrome's built-in PDF Viewer does not expose its extracted or decrypted text to extensions. readit.dev will therefore keep that viewer intact and add a background-owned PDF adapter using bundled PDF.js. The adapter fetches the source PDF after the user invokes **Read current page**, extracts text in page order, constructs the existing `Article` contract, and delegates to the established playback coordinator.

This keeps PDF content in memory, uses the existing TTS, Popup, Side Panel, playback state, and manual-reader preemption behavior, and avoids a custom PDF viewer.

## Goals

- Read text-layer PDFs from the active HTTPS or `file://` tab.
- Preserve the existing reading pipeline after content becomes an `Article`.
- Keep PDF bytes and extracted text in memory only; do not log, persist, transmit, or render them in a new viewer.
- Give clear, localized errors for missing local-file permission, password-protected PDFs, PDFs without usable text, and extraction failures.
- Preserve an active manual reader when PDF extraction fails.

## Out of Scope

- Password-protected PDFs, including reuse of a password entered into Chrome's PDF Viewer.
- OCR, scanned/image-only PDFs, handwriting recognition, or image descriptions.
- Word highlighting, selection reading, annotations, search, download, or rendering inside PDFs.
- Replacing Chrome's PDF Viewer, using Chrome's MIME handler API, requiring Chrome 151+, or adding a custom document UI.
- New backend services, telemetry, PDF/text storage, broad host permissions, or file handling outside the active tab. The local-file path explicitly uses the narrow `file://*/*` host permission required by Chrome to expose the user-controlled file-access toggle; it does not add `<all_urls>` or any other broad network host.
- Guaranteed support for PDFs delivered by POST, single-use URLs, or sessions that cannot be fetched again after the user invokes the extension.

## Architecture

### PDF adapter

Add `src/background/pdf_extractor.ts`, a focused adapter that accepts the active tab URL and title plus injected dependencies for fetching, local-file access checks, and PDF.js loading. It returns one of:

- a valid `Article`;
- a stable PDF failure code; or
- `null` when the fallback response is not a PDF.

The adapter does not use Readability, content scripts, the PDF Viewer DOM, or an offscreen document. It validates a PDF from its `application/pdf` response type or `%PDF-` header before parsing. It uses bundled `pdfjs-dist` to read document metadata and text items in page order, preserves page breaks as paragraph boundaries, trims the result, and accepts only non-empty text.

The title preference is PDF metadata title, then the active-tab title, then a filename derived from the source URL. PDFs use `lang: 'na'`, matching the current automatic-language path when a document has no usable language declaration.

### Current-page routing

`startCurrentPage()` continues to request the existing content-script extraction first. This retains Google Docs and Readability behavior without an unnecessary PDF fetch for normal pages.

When the content-script receiver is unavailable or returns an unsuccessful extraction, as can happen for Chrome's PDF Viewer, the background invokes the PDF adapter:

1. Reject existing restricted URLs exactly as today.
2. For `file://`, call `chrome.extension.isAllowedFileSchemeAccess()` before fetching. A false, unavailable, throwing, or timed-out result returns a local-file-permission failure and no file fetch is attempted.
3. Fetch the current tab URL into memory, with the user-triggered active-tab access and a 30-second timeout.
4. If the response is not a PDF, preserve the current generic page-extraction failure.
5. Parse text-layer PDF content. Map password errors, empty text, and parser/fetch errors to their distinct PDF failure codes.
6. On success, call the existing `startPlayback()` with `contentScope: 'article'` and the existing tab source shape.

Only successful extraction reaches `startPlayback()`. As a result, existing `preemptManualForWeb()` behavior remains intact: manual audio is checkpointed only after PDF extraction has succeeded, and it is never interrupted by a PDF error.

### Dependencies and permissions

Add `pdfjs-dist` as a bundled production dependency. The worker module is statically initialized in the background bundle so PDF.js's fake-worker path does not use dynamic `import()`, which Chrome disallows in a Manifest V3 service worker. PDF.js is always loaded locally from the extension package.

The feature uses the existing `activeTab` permission for a user-invoked current tab and declares the narrow `file://*/*` host permission for local PDFs. Local PDFs still require the user-controlled Chrome setting **Allow access to file URLs**; no setting is changed programmatically. The permission check is fail-closed: a denied, unavailable, throwing, or timed-out API callback returns `pdfFileAccessRequired` and the PDF is not fetched.

## UX and Failure Contract

The Popup and Side Panel keep their existing **Read current page** controls. No PDF-specific button, viewer, or password prompt is added.

Add the following stable error codes in shared constants and map them through `getLocalizedPlaybackError()` to both English and Vietnamese UI text:

| Code | User-facing outcome |
| --- | --- |
| `pdfFileAccessRequired` | Explain how to enable **Allow access to file URLs** for the extension. |
| `pdfPasswordProtected` | State that password-protected PDFs are not currently supported. |
| `pdfTextUnavailable` | State that no readable text was found and that scanned PDFs are not supported. |
| `pdfExtractionFailed` | State that the PDF could not be read and invite the user to retry or paste text. |

Failures return no `Article`, start no TTS audio, and do not persist or log PDF data. A successful session uses the normal title, progress, badge, pause, resume, stop, and Side Panel behavior. The current PDF UI remains unmodified and receives no word-highlighting messages.

No new artificial file-size limit is introduced. Downloads and parsing remain best-effort and memory-only, consistent with the current current-page extraction model; timeout, fetch, and parser failures return `pdfExtractionFailed`.

## File Map

| File | Change |
| --- | --- |
| `package.json`, `pnpm-lock.yaml` | Add and lock bundled `pdfjs-dist`. |
| `src/background/pdfjs_loader.ts` | Statically initialize PDF.js's worker handler in the background bundle before loading documents. |
| `src/background/pdf_extractor.ts` | Fetch, validate, parse, and convert a PDF into `Article`; expose testable dependency seams. |
| `src/background/background.ts` | Invoke PDF fallback after unavailable or unsuccessful content-script extraction; preserve PDF error codes and reuse `startPlayback()`. |
| `src/shared/constants.ts` | Define PDF failure codes and EN/VI translations. |
| `src/shared/i18n.ts` | Map PDF error codes to localized text. |
| `tests/unit/pdf_extractor.test.ts` | Cover PDF adapter behavior with fake fetcher and PDF loader. |
| `tests/e2e/pdf-reading.spec.ts` | Assert successful coordinator state and Popup/Side Panel error outcomes using deterministic PDF routes. |

## Data and Privacy Boundaries

- PDF bytes, metadata, and extracted text exist only in the fetch/parser/playback memory path.
- The adapter makes one user-triggered fetch to the PDF source origin. It does not upload PDF content, extracted text, URL, title, or metadata to readit.dev or another third party.
- PDF.js worker code is statically packaged with the background bundle; it makes no network request.
- The source is fetched only after a user invokes **Read current page** in its active tab.
- The extension neither bypasses view controls nor reuses Chrome PDF Viewer's password-unlock state.

## Testing and Verification

### Unit tests

- Recognize PDF responses by MIME type or file signature and return `null` for a non-PDF fallback response.
- Extract page-ordered text, page boundaries, metadata title, and title fallback with a fake PDF.js loader.
- Return `pdfFileAccessRequired` before any local-file fetch when Chrome file access is disabled, unavailable, or the permission check times out.
- Return `pdfPasswordProtected` for PDF.js password failures.
- Return `pdfTextUnavailable` for valid PDFs with no non-whitespace text.
- Return `pdfExtractionFailed` for timeout, HTTP, malformed input, and parser failures without exposing response bodies.
- Assert `getLocalizedPlaybackError()` returns the correct EN/VI string for every PDF code.

### End-to-end tests

- Route a deterministic text-layer PDF fixture in a top-level tab, invoke **Read current page**, and assert that the background publishes a normal tab playback session with PDF title/text.
- Assert Popup and Side Panel show the localized missing-local-file-permission, password-protected, no-text, and generic extraction errors, including when a persisted playback session contains a PDF error code.
- Start a manual reader, force each PDF extraction failure, and assert that the manual session continues unmodified.
- Retain standard web-page and Google Docs extraction coverage to prove the PDF fallback does not replace those paths.

### Verification sequence

Run sequentially:

1. `CI=true pnpm test:unit`
2. `CI=true pnpm build`
3. `CI=true pnpm validate:manifest`
4. Targeted PDF Playwright tests
5. `CI=true pnpm test:e2e`
6. `git diff --check`
7. `graphify update .`

Use deterministic local/route fixtures for automated tests. The supplied Anthropic PDF is suitable only for manual smoke testing, not an automated network dependency.

## Acceptance Criteria

- A text-layer HTTPS PDF, including the supplied representative URL when reachable, is spoken through the normal reading controls.
- A text-layer local PDF is spoken after the user enables Chrome's file-URL extension access.
- PDF text reaches the existing article playback path in source page order, with page boundaries preserved.
- Standard pages and Google Docs retain their existing extraction behavior.
- Password-protected and textless/scanned PDFs display their respective localized failures, create no audio session, and leave manual playback intact.
- No PDF viewer replacement, PDF word highlighting, OCR, password entry, stored content, backend request, telemetry, or new broad host permission is introduced.
