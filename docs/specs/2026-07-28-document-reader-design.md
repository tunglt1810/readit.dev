# Full Document Reader Design

**Date:** 2026-07-28

**Status:** Approved design

**Scope:** Add one extension-owned, full-page Clean Reader as the Readable Surface for Google Docs export and PDF playback. The first version reflows extracted text and does not reproduce Google Docs canvas rendering or PDF page geometry.

## Summary

Google Docs and PDF are existing Content Sources, but both currently use `readableSurface: 'none'`. Their extracted text is spoken through the shared playback pipeline without a visual projection target.

This design adds `document-reader` as a shared Readable Surface. Google Docs export and PDF extraction remain independent Content Sources and both select that surface after successful extraction. A full extension page displays the immutable text snapshot, projects the canonical spoken-word index into an exact source range, and exposes the existing playback controls.

The Side Panel does not embed the document. It starts playback as it does today and offers **Open full reader** for the active document session. Opening the Reader is always explicit and never steals the active tab automatically.

## Goals

- Give Google Docs and PDF playback one stable, extension-owned visual surface.
- Display extracted text in a readable full-page layout.
- Highlight the source-equivalent word being spoken and keep it in view.
- Allow the Reader to attach after playback has started and recover the current word.
- Keep audio independent from Reader availability.
- Keep document text and projection data memory-only.
- Reuse the canonical Readable Surface lifecycle instead of adding Content Source branches to normalization or playback.
- Add no permission, host access, backend request, telemetry, or document persistence.

## Out of Scope

- Highlighting inside Google Docs or Chrome's built-in PDF Viewer.
- Reproducing Google Docs formatting, comments, suggestions, canvas layout, or live edits.
- Rendering PDF pages, columns, figures, links, annotations, text layers, zoom, printing, or downloads.
- Editing, search, selection reading, annotations, or multiple simultaneously active documents in the Reader.
- OCR, scanned PDFs, password-protected PDFs, or a MIME handler.
- Transferring playback ownership from the source tab to the Reader tab.
- Persisting document text so it survives Reader refresh, extension restart, or completed-session recovery.

## Domain Model

Extend the closed Readable Surface union:

```ts
type ReadableSurfaceKind = 'website-dom' | 'manual-reader' | 'document-reader' | 'none';
```

The source/surface matrix becomes:

| Content Source | Readable Surface |
| --- | --- |
| Website Article | `website-dom` |
| Website Selection | `website-dom` |
| Manual pasted text | `manual-reader` |
| Google Docs export | `document-reader` |
| PDF text extraction | `document-reader` |
| Error or unsupported source | `none` |

`document-reader` is valid only for a tab-owned article session. Manual sessions remain owned by their Side Panel instance, and Website DOM sessions remain owned by their source tab.

## Architecture

### Document Reader page

Add a bundled extension page, `reader.html`, with a React application dedicated to:

- rendering the current immutable document snapshot;
- mapping canonical word indexes to source offsets;
- drawing the active highlight and scrolling it into view;
- displaying playback state and controls; and
- attaching and detaching from the active document session.

The page is an extension UI, not a hosted web application. It receives no document content in the URL and makes no network request for the document.

### Document Reader Adapter

Add a Document Reader Adapter inside the background Readable Surface Module. It:

- accepts only the active `document-reader` session;
- owns the connected Reader instance;
- rejects stale session IDs;
- routes attach, update, and clear lifecycle events;
- opens or focuses at most one Reader tab for the active session; and
- treats every Reader delivery failure as projection-only failure.

Callers continue to use the Readable Surface coordinator. They do not branch on Google Docs or PDF.

### Offscreen projection snapshot

The offscreen document already owns playback preparation, canonical source-equivalent word maps, timing, and the current spoken-word index. For `document-reader`, it additionally retains an in-memory projection snapshot for the lifetime of the active playback:

```ts
interface DocumentReaderSnapshot {
	sessionId: string;
	title: string;
	content: string;
	words: readonly ReadableSurfaceWord[];
	currentWordIndex: number;
}
```

The snapshot is not written to `chrome.storage`. A late Reader attachment requests it through the background and therefore does not depend on the Manifest V3 service worker remaining alive.

The current word index continues advancing internally even while no Reader is attached. Visual update messages are routed only while a valid Reader connection exists.

## Data Flow

### Start playback

1. Google Docs export or PDF extraction returns an `Article` with `readableSurface: 'document-reader'`.
2. The background creates the existing tab-owned Playback Session and persists only its metadata.
3. The background passes the playback content plus a document presentation descriptor to offscreen memory.
4. Offscreen prepares speech units and the canonical source-equivalent word list.
5. Audio begins whether or not a Reader is open.

### Open and attach Reader

1. The Side Panel shows **Open full reader** only for the active `document-reader` session.
2. The background opens a new bundled Reader tab or focuses the existing one.
3. The Reader connects with an owner-scoped runtime port and requests the active snapshot.
4. The background validates the session and obtains the snapshot from offscreen.
5. The Reader renders the source content, precomputes source ranges, applies the current highlight, and subscribes to future updates.

### Update and clear

- Offscreen emits canonical word indexes from real playback timing.
- The Document Reader Adapter routes updates only to the attached Reader for the same session.
- Closing the Reader detaches the projection without stopping audio.
- Explicit stop and natural completion clear the active highlight but leave the already rendered document in Reader-tab memory.
- A new document session replaces the rendered snapshot.
- A Website or Manual playback replacement makes the existing Reader inactive and blocks stale updates.
- Source-tab closure or navigation keeps the existing tab-owned stop behavior.

## Reader UX

The Reader uses a full viewport with:

- a fixed header containing the document title and **Back to source**;
- a centered reading column approximately 720–800px wide;
- source paragraphs and page breaks preserved from `Article.content`;
- a fixed playback control area for pause/resume, stop, progress, Voice, and speed; and
- a clear inactive or empty state when no attachable document session exists.

The Reader reuses the shared playback client and command contract used by Popup and Side Panel. It does not introduce an independent playback state.

The active word uses the CSS Highlight API. Auto-scroll occurs only when the active range leaves the central viewport band. Reduced-motion preferences disable smooth motion. Word changes are not placed in an `aria-live` region, avoiding screen-reader announcements on every token.

## Source-Offset Mapping

The Reader precomputes:

```ts
globalWordIndex -> { start: number; end: number } | null
```

against the original `Article.content`.

The mapper:

- consumes canonical `ReadableSurfaceWord` entries in ascending index order;
- searches monotonically from the previous successful range;
- handles repeated words without returning to an earlier occurrence;
- enforces Unicode word boundaries so short words do not match inside longer words;
- compares NFC and NFD target variants without normalizing the full source string;
- preserves source string offsets exactly;
- supports multi-token source-equivalent entries such as `1.000 USD`; and
- leaves the search cursor unchanged when one word cannot be mapped so later words can still succeed.

The rendered paragraph model records each paragraph's global source start. An update resolves one precomputed source range into a DOM `Range` and replaces one named CSS highlight. The Reader does not render one span per word and does not re-render the complete document for each update.

## Lifecycle and Failure Contract

- A Reader attach without an active `document-reader` session returns an empty state.
- An attach, update, or clear for a stale session ID is ignored.
- An unmapped current word clears or preserves no active highlight; audio and later mappings continue.
- Reader close, crash, disconnect, render error, or focus failure never pauses or stops playback.
- Failure to open or focus the Reader produces a localized Side Panel error while audio continues.
- Reader refresh can reattach only while the document playback is still active.
- After playback ends, an already open Reader may retain its in-memory text, but refreshing or reopening cannot recover it.
- Document content never enters `chrome.storage.local`, `chrome.storage.session`, logs, metrics, URL parameters, backend requests, or telemetry.

## Permissions and Privacy

The current user-triggered extraction boundary remains unchanged:

- HTTPS Google Docs export uses the existing content-script/export path.
- HTTPS and local PDFs use the existing background PDF.js extraction path.
- Local files still require the user-controlled **Allow access to file URLs** setting.
- Opening a bundled extension page through `chrome.tabs.create()` requires no `tabs` permission.

No new manifest permission, host permission, debugger access, MIME handler, or Web Store warning is introduced.

## Testing

### Unit tests

- Accept valid `document-reader` tab sessions and reject invalid source/surface combinations.
- Validate the document snapshot and attach protocol.
- Map repeated words monotonically.
- Match NFC speech words against NFD source text while preserving source offsets.
- Map multi-token source entries and reject substring matches inside longer words.
- Recover after an unmatched word and reject stale indexes.
- Preserve paragraph boundaries and handle representative long content.
- Attach late at the current word, detach safely, replay the current snapshot, reject stale sessions, and clear ownership.
- Confirm offscreen advances the current document word index without a connected Reader.

### End-to-end tests

- Read a deterministic Google Docs export, observe `document-reader`, open the Reader, and verify its content.
- Read a deterministic PDF fixture through the real extractor and verify the same Reader surface.
- Drive highlighting through the real playback producer and assert repeated-word and Unicode ranges.
- Open the Reader after playback has advanced and assert the current word is projected.
- Close and reopen the Reader without stopping audio.
- Verify pause, resume, stop, natural completion, document replacement, Website/Manual replacement, and source navigation.
- Assert document text is absent from `chrome.storage.local` and `chrome.storage.session`.
- Assert the extension permission set is unchanged.
- Retain Website DOM and Manual Reader projection regressions.

## Verification Sequence

Run sequentially:

1. `CI=true pnpm test:unit`
2. `CI=true pnpm build`
3. `CI=true pnpm validate:manifest`
4. Targeted Document Reader Playwright tests
5. `CI=true pnpm test:e2e`
6. `git diff --check`
7. `graphify update .` when an existing graph is available

## Acceptance Criteria

- Google Docs and PDF playback expose `readableSurface: 'document-reader'`.
- Side Panel offers an explicit **Open full reader** action and never opens the Reader automatically.
- The full Reader renders the extracted text and highlights the real spoken source-equivalent word.
- Repeated words, Unicode normalization, multi-token spans, late attachment, scrolling, and stale-session rejection behave deterministically.
- Reader availability never controls audio success.
- Website DOM and Manual Reader behavior remain unchanged.
- No source-view integration, PDF layout viewer, new permission, backend traffic, telemetry, or document persistence is added.
