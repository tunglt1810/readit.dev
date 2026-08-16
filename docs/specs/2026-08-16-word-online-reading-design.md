# Word Online Reading via Same-Origin Download Design

**Date:** 2026-08-16

**Status:** Approved design; implementation pending

**Scope:** Reading Microsoft Word documents opened in the browser from OneDrive (`onedrive.live.com`) and SharePoint / OneDrive for Business (`*.sharepoint.com`), when the user has the document open and the tab holds a valid session.

## Summary

Word Online is a dynamic application. The document page hosts the editor inside an `word-edit.officeapps.live.com` iframe, so the top-level DOM contains no readable article for Mozilla Readability, exactly as with Google Docs.

The content script recognizes the document URL, derives the site path and the document GUID from it, and fetches the raw `.docx` bytes from the same-origin SharePoint Online endpoint:

    <sitePath>/_layouts/15/download.aspx?UniqueId=<guid>

The request uses the tab's existing session cookies. The bytes are handed to the background worker, parsed by the existing `extractDocxText()`, converted into an `Article`, and processed through the existing playback pipeline.

Microsoft Graph API is explicitly **not** used. See "Why not Microsoft Graph" below.

## Probe Evidence

Measured on 2026-08-16 against a real personal OneDrive document, executed in the page context of a logged-in tab:

| Request | Result |
| --- | --- |
| `/_layouts/15/download.aspx?UniqueId=<guid>` | `404` — the site path prefix is required |
| `/personal/<cid>/_layouts/15/download.aspx?UniqueId=<guid>` | `200`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, 253740 bytes, `redirected: false` |
| `/personal/<cid>/_api/web/GetFileById('<guid>')/$value` | `200`, `application/octet-stream`, 253740 bytes |
| `https://graph.microsoft.com/v1.0/shares/<u!token>/driveItem` (no bearer) | `401 InvalidAuthenticationToken` |

Both same-origin endpoints returned identical byte counts. The share link `1drv.ms/w/c/...` resolves through `onedrive.live.com/:w:/g/personal/<cid>/<token>` to `_layouts/15/doc.aspx?sourcedoc={guid}`, carrying `migratedtospo=true`: personal OneDrive now runs on the SharePoint Online stack while keeping the `onedrive.live.com` origin. That is why one code path serves both OneDrive and SharePoint.

Appending `&download=1` to a share URL redirects to a same-origin, server-relative `.docx` path, which is the behavior that first established this approach.

## Why not Microsoft Graph

Graph always requires an OAuth bearer token; it offers no cookie-based path. Adopting it would require an Azure app registration with the client ID shipped inside the extension, the `identity` permission, a `https://graph.microsoft.com/*` host permission, a hand-rolled PKCE flow through `chrome.identity.launchWebAuthFlow` (MSAL.js does not work inside an MV3 service worker), and admin consent on most work or school tenants.

It is also indirect. The `sourcedoc` GUID in the page URL is the SharePoint `UniqueId`, not a Graph `driveItem` id, so reaching the file requires resolving site, then drive, then `/drives/{driveId}/list/items/{guid}/driveItem` — and OneDrive personal items do not carry a `sharePointIds` facet. Two or three extra authenticated requests to obtain bytes that one same-origin request already returns.

Graph offers no plain-text conversion for Word documents either (`?format=` supports pdf, html, and image targets), so either path ends at `.docx` bytes.

`_api/web/GetFileById('<guid>')/$value` is recorded here as a documented fallback should `download.aspx` change, but it is not implemented. One verified endpoint is enough.

## Goals and Out of Scope

### Goals

- Read any Word document the active tab can download, on both OneDrive and SharePoint.
- Preserve Readability and all existing behavior for every other URL.
- Reuse the existing DOCX pipeline rather than adding a second text extractor.
- Keep `content_script.js` small: it is injected into every page on every site.
- Emit a clear error when download is denied, the session has expired, the file is not a Word document, or the response is invalid.

### Out of Scope

- Microsoft Graph API, OAuth, Azure app registration, new host permissions, backend dependencies.
- Excel Online, PowerPoint Online, Visio, OneNote, or Loop components.
- Scraping the Word editor DOM, canvas, or the `officeapps.live.com` iframe.
- Anonymous share links opened without a signed-in session.
- Bypassing view permissions or download restrictions.
- Storing, synchronizing, summarizing, or editing documents.

## Architecture

### Where the bytes are parsed

`extractDocxText()` depends on JSZip, which currently ships only in `reader.js`. Neither `content_script.js` (66 KB) nor `background.js` (1.69 MB) bundles it.

Parsing in the content script would add roughly 150 KB to a bundle injected into every tab on every site, to serve a feature most users never invoke. Parsing in the background places that cost on a service worker that loads once and never touches page context.

The content script therefore fetches and validates bytes only; the background decodes and parses them. This follows the pattern already used for PDF bytes returned from the offscreen document (`background.ts`), where file content crosses a message boundary as base64.

### Word Online Adapter

`src/content/word_online_extractor.ts` is the single adapter. It recognizes the URL, fetches the download endpoint, validates the response, and returns base64 bytes with source metadata, or a structured failure code, or `null` when the URL is not a Word Online document — the same three-way contract as `extractGoogleDocsArticle`.

Recognition requires all of:

- `protocol === 'https:'`
- `hostname === 'onedrive.live.com'` or `hostname.endsWith('.sharepoint.com')`
- `pathname` matches `/^(.*)\/_layouts\/15\/doc2?\.aspx$/i`, whose first group is the site path
- a `sourcedoc` or `resid` query parameter that, with braces stripped, matches a strict GUID pattern

OneDrive reaches the same page under two parameter names, carrying the same GUID: `sourcedoc` when the document is opened from a share link, `resid` when it is opened from the file list. Manual testing on 2026-08-16 found the second form, which the first implementation did not recognize; the adapter reads either.

The site path is derived from `location.pathname` rather than hardcoded, which is what lets `/personal/<cid>`, `/sites/<name>`, and `/personal/<user>_tenant_com` share one implementation. The leading-dot form of the hostname check rejects `evilsharepoint.com`, and a suffixed host such as `foo.sharepoint.com.evil.com` fails it as well. The GUID is validated before it is interpolated into the endpoint URL, for the same reason the Google Docs adapter wraps its document ID in `encodeURIComponent`.

### Word vs other Office formats

`Doc.aspx` serves Word, Excel, and PowerPoint alike, and the observed URL carries neither a `file=` nor an `ithint=` parameter to discriminate on. The adapter therefore does not guess from the URL. It fetches, and lets the content identify itself: `extractDocxText()` already throws `DocxError(parseFailed)` when the archive contains no `word/document.xml`. Opening Excel Online yields a clear error rather than spoken garbage.

### No fallback to Readability or PDF

Once a URL is recognized as a Word Online document, a download failure is a final result. The background branch returns directly and must not fall through to `requestPdfFallback()` in `requestCurrentTabArticle`, which would otherwise fetch the OneDrive page as a PDF. This mirrors the rule the Google Docs design established.

## Data Flow

1. User clicks **Read current page** on a Word Online tab.
2. Background sends `EXTRACT_ARTICLE` to the content script as usual.
3. The content script tries the Google Docs adapter, then the Word Online adapter, then Readability.
4. The Word Online adapter parses the URL, builds the endpoint from the validated GUID and site path, and fetches with `credentials: 'same-origin'` under a 15 second timeout.
5. The adapter accepts only `200 OK`, a non-empty body, a leading ZIP signature `50 4B 03 04`, and a size at or below 25 MB. Size is checked against `content-length` when the header is present, and against the read `byteLength` otherwise, so a missing header cannot bypass the ceiling.
6. Bytes are encoded to base64 by `bytesToBase64`, and returned with the page URL, title, and language.
7. Background decodes the base64, calls `extractDocxText(bytes, source.title)`, and builds an `Article` from the returned title and content, the source URL, and `detectContentLanguage(content, source.lang)`.
8. Background starts the existing playback pipeline with `readableSurface: 'document-reader'`. No new TTS branches.
9. For every other URL the content script proceeds with `extractArticleFromDocument()` and Readability, unchanged.

Content type is deliberately not used for validation: `download.aspx` returns the Word MIME type, `GetFileById` returns `application/octet-stream`, and error pages return `text/plain`. The ZIP signature is the reliable check, and it also catches an expired session redirected to an `Authenticate.aspx` HTML body.

Base64 encoding walks the buffer in 32 KB chunks rather than calling `btoa(String.fromCharCode(...new Uint8Array(buffer)))`; spreading a quarter-million arguments overflows the call stack, and the failure would appear only with real documents, not with small test fixtures. Chunked `btoa` is chosen over `FileReader` because it stays synchronous and runs under `node --test`, where `FileReader` is not a global — the encoder has to be unit-testable outside a browser.

The 25 MB ceiling exists because base64 inflates payloads by roughly a third, and a message of that size would likely fail silently in `chrome.runtime.sendMessage`. The ceiling converts a silent hang into a stated error.

## Failure Contract and UX

The feature emits one stable error code, `wordOnlineDownloadUnavailable`, defined in `src/shared/constants.ts`.

| Condition | Detected by |
| --- | --- |
| Download denied on a view-only document (`403`) | `!response.ok` |
| Expired session serving an `Authenticate.aspx` HTML body | ZIP signature check |
| Document no longer exists (`404`) | `!response.ok` |
| Excel or PowerPoint opened through `Doc.aspx` | `DocxError(parseFailed)` |
| Empty document | `DocxError(textUnavailable)` |
| Oversized file, timeout, or network error | explicit checks in the adapter |

A single code is deliberate: the useful advice is the same in every case — check view or download permission, or read selected or pasted text instead. Additional codes would add translated strings without changing what the user can do, which is why the Google Docs design also settled on one.

The code travels through three existing seams:

- `getExtractionError()` in `background.ts` must preserve it. Omitting this collapses the code into the generic `ERROR_MESSAGES.extraction` string — a silent failure.
- `getPlaybackErrorTranslationKey()` in `src/shared/i18n.ts` maps it to a translation key.
- `en.json` and `vi.json` carry one string each.

Popup and Side Panel need no changes; both already resolve error codes through `getPlaybackErrorTranslationKey`.

Download failures produce no TTS audio. A failed page extraction does not interrupt or replace an active manual text session. Document bytes are never persisted to storage, the base64 string is discarded immediately after decoding, and response bodies, document GUIDs, and document text are never logged.

## File Map

| File | Changes |
| --- | --- |
| `src/content/word_online_extractor.ts` | New. URL recognition, endpoint construction, fetch, response validation, base64 encoding. Accepts an injected `fetch` for unit testing. |
| `src/background/word_online_article.ts` | New. Decodes base64, calls `extractDocxText`, builds the `Article`, maps `DocxError` to the failure code. Isolated so it is unit-testable without `background.ts`. |
| `src/shared/base64.ts` | New. `bytesToBase64` and `base64ToBytes`, both chunk-safe and framework-free. `base64ToBytes` also replaces the loop inlined in the existing PDF offscreen branch. |
| `src/content/content_script.ts` | Calls the adapter after Google Docs and before Readability; extends `ArticleExtractionResponse`. |
| `src/background/background.ts` | Adds the branch to `requestCurrentTabArticle` before the `isArticle` check and before the PDF fallback; adds the code to `getExtractionError`. |
| `src/background/article_request.ts` | Extends `ArticleResponse` with the docx variant. |
| `src/shared/constants.ts` | Adds `WORD_ONLINE_DOWNLOAD_UNAVAILABLE`. |
| `src/shared/i18n.ts` | Adds the translation key case. |
| `src/shared/locales/en.json`, `src/shared/locales/vi.json` | Add the localized message. |
| `tests/unit/word_online_extractor.test.ts` | New. URL matching, endpoint construction, response validation, failure mapping. |
| `tests/unit/word_online_article.test.ts` | New. Base64 decode, DOCX parsing, error mapping. |
| `tests/e2e/reader.spec.ts` | Adds a success case and a `403` case using `tests/e2e/docx_fixture.ts`. |

## Verification Plan

### Unit Tests

- Accept `onedrive.live.com` with `doc.aspx`, `Doc.aspx`, and `doc2.aspx`; accept `*.sharepoint.com` under both `/sites/<name>` and `/personal/<user>_tenant_com`.
- Reject `http:`, `evilsharepoint.com`, `foo.sharepoint.com.evil.com`, a missing `sourcedoc`, and a malformed GUID.
- Derive the site path correctly from the pathname.
- Build the endpoint only from the validated GUID, never from an arbitrary URL.
- `200` with a ZIP signature returns base64 bytes and source metadata.
- `403`, an HTML body, an empty body, an oversized `content-length`, a thrown fetch, and a timeout each return `wordOnlineDownloadUnavailable`.
- Non-Word-Online URLs return `null` so Readability still runs.
- Background: base64 decodes to an `Article` with title from `docProps/core.xml`; `DocxError` maps to the failure code.

### End-to-End Tests

- Route a mock `onedrive.live.com/personal/x/_layouts/15/doc.aspx?sourcedoc={guid}` page with no readable article DOM, and route `download.aspx?UniqueId=` to a generated DOCX. `EXTRACT_ARTICLE` returns the docx variant carrying real ZIP bytes.
- Route `download.aspx` to `403`. `EXTRACT_ARTICLE` returns `wordOnlineDownloadUnavailable`.
- Existing Google Docs, standard article, and navigation tests continue to pass.

Coverage boundary: the end-to-end tests exercise the content script layer, because `reader.spec.ts` sends `EXTRACT_ARTICLE` straight to the tab and never reaches the background worker. The background half — base64 decode, `extractDocxText`, `Article` construction, `DocxError` mapping — is covered by unit tests instead. A full playback assertion would require the real TTS path, which in this suite means model download and a 240 second timeout; the downstream pipeline is unchanged by this feature and is already covered by existing tests, so that cost is not taken on.

### Post-Implementation Verification

1. `pnpm test`.
2. `pnpm build`, then confirm `dist/chrome/content_script.js` stays under 80 KB and record the `background.js` size. This is the direct test of the architecture decision: growth in the content script means JSZip reached the wrong bundle. `docx_extractor.ts` imports `normalizeChapterText` from `epub_extractor.ts`, which imports JSZip at module scope, so tree-shaking behavior here is measured rather than assumed.
3. Run Playwright **after** rebuilding; the suite loads `dist/chrome`, so a stale build reports a false pass.
4. `git diff --check`.

Playwright uses route mocks and depends on no Microsoft account or external network access.

## Acceptance Criteria

- Word documents on OneDrive and SharePoint read successfully when the tab can download them.
- Spoken content is the document text, free of menus, toolbars, and editor UI.
- Download failure shows clear localized guidance, produces no audio, triggers no PDF fallback, and leaks no document content.
- Standard web pages continue to use Readability, and Google Docs continues to use its own adapter.
- `dist/chrome/content_script.js` stays under 80 KB, against a 66 KB baseline.
- No new manifest permissions, no OAuth, no backend dependency, no persisted document text, no telemetry.

## Known Gaps

These were not verified during the probe and are handled by the failure contract rather than by dedicated logic:

- Only personal OneDrive migrated to SharePoint Online was measured. The `*.sharepoint.com` branch is expected to behave identically because it is the same stack, but it is unconfirmed against a real tenant.
- Documents opened from the `office.com` or `m365.cloud.microsoft` launcher may present a different address-bar origin, in which case the adapter does not match and Readability runs as before.
- Microsoft is gradually migrating Office web endpoints to `cloud.microsoft`. The document address bar was still `onedrive.live.com` on 2026-08-16. If the document page origin moves, the adapter's host matching must follow.
- Anonymous share links opened without a session redirect to `Authenticate.aspx` and surface as a download failure.
- `resid` also appears in a composite `<CID>!s<guid>` form on share URLs such as `/:w:/g/personal/...`. Those paths do not match the adapter's `_layouts/15/doc.aspx` shape, so the composite form has never been observed where the adapter runs and is not parsed. Should it appear on a document page, recognition returns `null` and Readability runs as before.
