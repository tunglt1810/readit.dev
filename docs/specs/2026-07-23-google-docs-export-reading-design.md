# Google Docs Reading via Tab Access Permissions Design

**Date:** 2026-07-23

**Status:** Approved design; implementation pending

**Scope:** Reading Google Docs matching `https://docs.google.com/document/d/<id>/...` when the user has opened the document and the browser has view permissions, including public and logged-in documents.

## Summary

Google Docs is a dynamic application. Document pages contain no `article`, `main`, `heading`, or `paragraph` DOM elements for Mozilla Readability to extract; the editor resides inside internal iframes and UI layers. The current extractor therefore returns `null`, causing the background worker to emit a generic extraction error.

The content script will accurately recognize the document URL and fetch that document's plain-text export from the same-origin endpoint:

    /document/d/<document-id>/export?format=txt

The request utilizes the tab's existing view permissions and cookies. The exported text is converted into an `Article` and processed through the existing playback pipeline.

## Goals and Out of Scope

### Goals

- Read any Google Docs document that the active tab has permission to view.
- Preserve Readability and existing behavior for all non-Google Docs URLs.
- Do not scrape internal editor DOM, raw page UI, toolbars, menus, or iframes.
- Do not transmit content to readit.dev, Google Drive API, or third-party services; do not persist exported text in extension storage.
- Emit clear errors when Google denies export access, document view permissions are lost, responses are invalid, or exported text is empty.

### Out of Scope

- Google Sheets, Slides, Drive files, or Docs URLs not matching `/document/d/<id>`.
- Google Drive API, OAuth, custom tokens, new host permissions, or backend dependencies.
- Scraping internal Google Docs DOM, canvas, or iframes.
- Bypassing view permissions, download/copy/print restrictions, or document owner access controls.
- Storing, synchronizing, summarizing, or editing documents.

## Architecture

### Google Docs Adapter

`src/content/google_docs_extractor.ts` serves as the single adapter for Google Docs. It receives valid document URLs, fetches and validates the plain-text export, and returns an `Article` or a structured failure code.

The adapter uses `fetch` with `credentials: 'same-origin'`. The content script initiates requests under the origin of the page into which it was injected; requests to `docs.google.com` share the origin of the active tab requested by the user. No new `host_permissions` are added: the export endpoint shares the same origin as the active tab.

### No Fallback to Editor DOM or Readability

Inspected real-world documents show that the top-level document has zero `article`, `main`, `heading`, or `paragraph` elements; the editor is inside an iframe. The current content script configuration also injects into the top frame only. Using `all_frames` or `match_about_blank` to scrape the editor would rely on unannounced DOM structures and risk reading toolbars or text out of order.

When a URL is recognized as a Google Docs document, an export failure is a final result. No subsequent attempts are made with Readability or raw UI scraping. `src/content/article_extractor.ts` remains a synchronous, independent Readability extractor for standard websites.

## Data Flow

1. User clicks **Read current page** on a Google Docs tab.
2. Background sends `EXTRACT_ARTICLE` to the content script as usual.
3. Content script parses the `docs.google.com` hostname and `/document/d/<document-id>/...` path using `URL`.
4. For valid Google Docs, the adapter constructs the export endpoint from the parsed document ID and fetches text with `credentials: 'same-origin'`.
5. The adapter accepts only `200 OK` responses, `plain/text` content types, and non-empty trimmed text; it normalizes `CRLF`/`CR` to `LF` while preserving paragraph breaks.
6. The adapter creates an `Article` from the existing page title, exported text, source URL, and document language.
7. Content script returns success; background initiates the existing playback pipeline, offscreen TTS, badge updates, and session management with no new TTS branches.
8. For non-Google Docs URLs, the content script proceeds with standard `extractArticleFromDocument()` and Readability processing.

Google Docs text only requires non-empty content rather than meeting the standard 120-character article threshold, as it is a specialized document source where short documents remain valid for reading.

## Failure Contract and UX

The adapter returns a stable error code `googleDocsExportUnavailable` when Google returns an error status, non-plain-text content, network failure, or empty text.

Background preserves this code in both error sessions and `CommandResponse`. `src/shared/constants.ts` defines localized EN/VI messages advising users to check view/download permissions or use selected/pasted text. Popup and Side Panel map the code from sessions and command responses via existing translation helpers without adding literal UI strings.

- Export failures do not trigger TTS audio.
- If a manual text session is playing, a failed page extraction returns an error without interrupting or replacing the active manual session.
- Response bodies, exported text, and document IDs are never logged.

## File Map

| File | Changes |
| --- | --- |
| `src/content/google_docs_extractor.ts` | Parses document URL, constructs export endpoint, fetches/validates text, and returns `Article` or failure code. Accepts injected `fetch` for unit testing. |
| `src/content/content_script.ts` | Selects Google Docs adapter for `EXTRACT_ARTICLE`, awaits result, and maintains response contract. |
| `src/background/background.ts` | Preserves Google Docs failure code when creating error sessions and returning command responses. |
| `src/shared/constants.ts` | Adds localized EN/VI translation keys for Google Docs export failure. |
| `src/popup/App.tsx` | Maps failure code to localized user message. |
| `src/sidepanel/App.tsx` | Applies identical error mapping for current-page playback start. |
| `tests/unit/google_docs_extractor.test.ts` | Tests URL parsing, endpoint construction, response validation, and text normalization. |
| `tests/e2e/reader.spec.ts` | Tests Google Docs export mocking and failure handling. |

## Verification Plan

### Unit Tests

- Parse `docs.google.com/document/d/<id>/edit`; reject invalid hostnames, paths, and document IDs.
- Export endpoint constructs exclusively from parsed ID without accepting arbitrary URLs.
- `200 text/plain` creates an `Article` and preserves paragraph breaks.
- `403`, request errors, non-plain-text content, and empty text return `googleDocsExportUnavailable`.
- Short but non-empty documents remain valid.

### End-to-End Tests

- Route mock top-level Google Docs page without article/main elements; route export endpoint returning plain text. `EXTRACT_ARTICLE` succeeds using exported text.
- Export `403` returns Google Docs failure without creating an `Article` or starting TTS.
- Popup and Side Panel display localized EN/VI messages; active manual sessions remain uninterrupted.
- Existing standard article and navigation tests continue to pass.

### Post-Deployment Verification

Run sequentially: unit tests, `pnpm build`, targeted Playwright, related E2E tests, and `git diff --check`. Playwright uses route mocks, independent of real Google Docs, Google accounts, or external network access.

## Acceptance Criteria

- Supported Google Docs URLs read successfully when tab has text export permission.
- Spoken content contains document text export, excluding menus, toolbars, or raw UI.
- Export failure presents clear user guidance, produces no audio, and leaks no text content.
- Standard web pages continue to use Readability.
- No new manifest permissions, backend/OAuth dependencies, persisted document text, or telemetry.
