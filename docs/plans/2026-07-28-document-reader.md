# Full Document Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one full-page, memory-only Clean Reader that highlights Google Docs and PDF playback through a shared `document-reader` Readable Surface.

**Architecture:** Google Docs and PDF remain independent Content Sources but both select `document-reader`. Offscreen owns the in-memory document snapshot and current canonical word index; the background Readable Surface coordinator owns one attached Reader port and routes snapshot/update/clear messages. A bundled React Reader page renders the immutable source text and projects precomputed source offsets with the CSS Highlight API.

**Tech Stack:** TypeScript 6, React 19, Chrome Manifest V3 runtime/tabs APIs, Rsbuild 2, Node test runner, Playwright.

## Global Constraints

- Use one shared `document-reader` Adapter for Google Docs and PDF.
- Open the Reader only after the user selects **Open full reader**.
- Reflow `Article.content`; do not implement Google Docs canvas or PDF page layout.
- Keep document text out of `chrome.storage.local`, `chrome.storage.session`, URLs, logs, metrics, backend requests, and telemetry.
- Reader projection failures never stop audio.
- Add no manifest permission or host permission.
- Preserve Website DOM and Manual Reader behavior.
- Preserve the unrelated staged `.github/workflows/release-extension.yml`.
- Use `/.tmp/` for temporary artifacts; it is already ignored.

---

### Task 1: Add the Document Reader Contract and Source-Offset Mapper

**Files:**
- Create: `src/shared/document_reader.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/background/playback_state.ts`
- Test: `tests/unit/document_reader.test.ts`
- Test: `tests/unit/playback_state.test.ts`

**Interfaces:**
- Produces: `DocumentReaderSnapshot`, `DocumentReaderPortMessage`, `mapDocumentReaderWords(content, words)`.
- Produces: `ReadableSurfaceKind` containing `'document-reader'`.
- Consumes: `ReadableSurfaceWord` from `src/shared/readable_surface.ts`.

- [ ] **Step 1: Write failing model and mapping tests**

Add tests that require:

```ts
const words = [
	{ text: 'cat', globalIndex: 0 },
	{ text: 'cat', globalIndex: 1 },
];
assert.deepEqual(mapDocumentReaderWords('cat saw cat', words), [
	{ start: 0, end: 3 },
	{ start: 8, end: 11 },
]);

assert.deepEqual(
	mapDocumentReaderWords('Cafe\u0301 costs 1.000 USD.', [
		{ text: 'café', globalIndex: 0 },
		{ text: '1.000 USD', globalIndex: 1 },
	]),
	[
		{ start: 0, end: 5 },
		{ start: 12, end: 21 },
	],
);
```

Extend playback-state tests so `document-reader` is valid only for tab-owned `article` sessions and remains invalid for selection/manual sessions.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
CI=true rtk pnpm exec node --experimental-strip-types --test tests/unit/document_reader.test.ts tests/unit/playback_state.test.ts
```

Expected: FAIL because the contract, mapper, and new union member do not exist.

- [ ] **Step 3: Implement the minimal shared contract**

Create `src/shared/document_reader.ts` with:

```ts
export type DocumentReaderRange = { start: number; end: number };

export interface DocumentReaderSnapshot {
	sessionId: string;
	title: string;
	content: string;
	words: readonly ReadableSurfaceWord[];
	currentWordIndex: number;
}

export type DocumentReaderPortMessage =
	| { action: 'DOCUMENT_READER_ATTACH'; sessionId: string }
	| { action: 'DOCUMENT_READER_SNAPSHOT'; snapshot: DocumentReaderSnapshot }
	| { action: 'DOCUMENT_READER_UPDATE'; sessionId: string; wordIndex: number }
	| { action: 'DOCUMENT_READER_CLEAR'; sessionId: string };
```

Implement `mapDocumentReaderWords()` as a monotonic, boundary-aware matcher. Compare lowercase NFC/NFD target variants against the untouched source string and return `null` for an unmatched word without advancing the successful cursor.

Extend the session unions and validators with this exact valid combination:

```ts
contentScope: 'article';
source: { kind: 'tab'; ... };
readableSurface: 'document-reader';
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/shared/document_reader.ts src/shared/types.ts src/background/playback_state.ts tests/unit/document_reader.test.ts tests/unit/playback_state.test.ts
rtk git commit -m "feat: add document reader contract"
```

---

### Task 2: Mark Google Docs and PDF as Document Reader Sources

**Files:**
- Modify: `src/content/google_docs_extractor.ts`
- Modify: `src/content/content_script.ts`
- Modify: `src/background/article_request.ts`
- Modify: `src/background/pdf_extractor.ts`
- Modify: `src/background/background.ts`
- Test: `tests/unit/google_docs_extractor.test.ts`
- Test: `tests/unit/article_request.test.ts`
- Test: `tests/unit/pdf_extractor.test.ts`
- Test: `tests/e2e/reader.spec.ts`
- Test: `tests/e2e/pdf-reading.spec.ts`

**Interfaces:**
- Consumes: `ReadableSurfaceKind = 'document-reader'`.
- Produces: successful Google Docs/PDF extraction responses with `readableSurface: 'document-reader'`.

- [ ] **Step 1: Change extraction expectations to RED**

Update only Google Docs and PDF success assertions:

```ts
assert.equal(result.readableSurface, 'document-reader');
```

Keep Website extraction expecting `website-dom` and all errors expecting `none`.

- [ ] **Step 2: Run focused extraction tests**

```bash
CI=true rtk pnpm exec node --experimental-strip-types --test \
	tests/unit/google_docs_extractor.test.ts \
	tests/unit/article_request.test.ts \
	tests/unit/pdf_extractor.test.ts
```

Expected: FAIL on the old `none` values and validators.

- [ ] **Step 3: Return and accept the new surface**

Change successful Google Docs and PDF results to `document-reader`. Update `ExtractedArticle`, `ArticleResponse`, `isArticleReadableSurface()`, and all request validators to accept it while leaving failure routing unchanged.

- [ ] **Step 4: Re-run focused extraction tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/content/google_docs_extractor.ts src/content/content_script.ts src/background/article_request.ts src/background/pdf_extractor.ts src/background/background.ts tests/unit/google_docs_extractor.test.ts tests/unit/article_request.test.ts tests/unit/pdf_extractor.test.ts tests/e2e/reader.spec.ts tests/e2e/pdf-reading.spec.ts
rtk git commit -m "feat: select document reader for document sources"
```

---

### Task 3: Retain and Serve the In-Memory Offscreen Snapshot

**Files:**
- Modify: `src/background/offscreen_transport.ts`
- Modify: `src/background/background.ts`
- Modify: `src/offscreen/offscreen.ts`
- Test: `tests/unit/offscreen_transport.test.ts`
- Test: `tests/e2e/word-highlight-runtime.spec.ts`

**Interfaces:**
- Consumes: `DocumentReaderSnapshot`.
- Produces: offscreen commands `GET_DOCUMENT_READER_SNAPSHOT` and `DETACH_DOCUMENT_READER`.
- Produces: `OffscreenCommandResponse.snapshot?: DocumentReaderSnapshot`.

- [ ] **Step 1: Add failing response-validation tests**

Require `sendOffscreenCommand()` to accept a strictly validated document snapshot and reject snapshots with missing fields, non-contiguous words, document content in unrelated response fields, or a non-integer current index.

- [ ] **Step 2: Run focused tests**

```bash
CI=true rtk pnpm exec node --experimental-strip-types --test tests/unit/offscreen_transport.test.ts
```

Expected: FAIL because snapshot responses are not modeled.

- [ ] **Step 3: Add snapshot lifecycle**

Add `documentTitle?: string` to `OffscreenPlayPayload`. Background sets it only when `readableSurface === 'document-reader'`.

In offscreen memory:

```ts
let currentDocumentReader: Omit<DocumentReaderSnapshot, 'currentWordIndex'> | null = null;
```

After playback preparation, build canonical words once and set the snapshot before `READABLE_SURFACE_INIT`. Move `currentWordIndex = wordIndex` before the `surfaceReady` delivery guard so late attachment observes real progress.

Handle:

```ts
GET_DOCUMENT_READER_SNAPSHOT
DETACH_DOCUMENT_READER
```

The first validates the active session, enables surface delivery, and returns the snapshot with the current index. The second disables delivery without stopping playback. `stopAudio()` clears the snapshot.

- [ ] **Step 4: Re-run transport and runtime tests**

```bash
CI=true rtk pnpm exec node --experimental-strip-types --test tests/unit/offscreen_transport.test.ts
CI=true rtk pnpm build
CI=true rtk pnpm exec playwright test tests/e2e/word-highlight-runtime.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/background/offscreen_transport.ts src/background/background.ts src/offscreen/offscreen.ts tests/unit/offscreen_transport.test.ts tests/e2e/word-highlight-runtime.spec.ts
rtk git commit -m "feat: retain document reader snapshot"
```

---

### Task 4: Add the Background Document Reader Adapter and Tab Ownership

**Files:**
- Modify: `src/background/readable_surface.ts`
- Modify: `src/background/background.ts`
- Test: `tests/unit/readable_surface.test.ts`
- Test: `tests/e2e/reading-state.spec.ts`

**Interfaces:**
- Consumes: offscreen snapshot/detach commands.
- Produces: `attachDocumentReader(owner)`, `detachDocumentReader(ownerId)`, and `documentReaderTabId()`.
- Produces: runtime action `OPEN_DOCUMENT_READER`.

- [ ] **Step 1: Add failing Adapter tests**

Cover:

- document initialization without an owner returns `{ success: false }`;
- a matching owner receives the snapshot and makes initialization ready;
- updates route only to the matching owner;
- replacement sessions reject stale owners;
- detach disables offscreen delivery;
- clear removes the highlight without failing audio cleanup.

- [ ] **Step 2: Run the focused coordinator test**

```bash
CI=true rtk pnpm exec node --experimental-strip-types --test tests/unit/readable_surface.test.ts
```

Expected: FAIL because the coordinator has no document Adapter.

- [ ] **Step 3: Implement the Adapter and port routing**

Extend `ReadableSurfaceDependencies` with:

```ts
requestDocumentReaderSnapshot(sessionId: string): Promise<DocumentReaderSnapshot | null>;
detachDocumentReader(sessionId: string): Promise<void>;
```

Track one owner:

```ts
type DocumentReaderOwner = {
	tabId: number;
	sessionId: string;
	deliver(message: DocumentReaderPortMessage): void;
};
```

Register `chrome.runtime.onConnect` for the exact port name `document-reader`. Validate `port.sender?.tab?.id`, attach only to the active session, and detach on disconnect.

Handle `OPEN_DOCUMENT_READER` by focusing the attached Reader tab or creating:

```ts
chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/reader.html') });
```

Opening/focusing failure returns `{ success: false, error: 'documentReaderOpenFailed' }` and never calls stop.

- [ ] **Step 4: Run coordinator and reading-state tests**

```bash
CI=true rtk pnpm exec node --experimental-strip-types --test tests/unit/readable_surface.test.ts
CI=true rtk pnpm build
CI=true rtk pnpm exec playwright test tests/e2e/reading-state.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/background/readable_surface.ts src/background/background.ts tests/unit/readable_surface.test.ts tests/e2e/reading-state.spec.ts
rtk git commit -m "feat: route document reader lifecycle"
```

---

### Task 5: Build the Full Reader Page

**Files:**
- Create: `src/reader/reader.html`
- Create: `src/reader/index.tsx`
- Create: `src/reader/App.tsx`
- Create: `src/reader/reader.css`
- Modify: `rsbuild.config.ts`
- Test: `tests/e2e/document-reader.spec.ts`

**Interfaces:**
- Consumes: `document-reader` port messages and shared playback client commands.
- Produces: bundled `dist/src/reader/reader.html`.

- [ ] **Step 1: Add a failing build/E2E shell test**

Require the built Reader page to load, expose `main[aria-label="readit.dev Document Reader"]`, and show the empty state without an active document.

- [ ] **Step 2: Run build and targeted test**

```bash
CI=true rtk pnpm build
CI=true rtk pnpm exec playwright test tests/e2e/document-reader.spec.ts
```

Expected: FAIL because the Reader entry does not exist.

- [ ] **Step 3: Add the Rsbuild entry and React page**

Add:

```ts
reader: './src/reader/index.tsx'
```

and map its template/output to `src/reader/reader.html`.

The React application:

- subscribes to playback state;
- connects through `chrome.runtime.connect({ name: 'document-reader' })`;
- sends `DOCUMENT_READER_ATTACH` for the active document session;
- renders title and paragraph blocks with global source starts;
- precomputes ranges with `mapDocumentReaderWords()`;
- projects one DOM Range through `CSS.highlights`;
- exposes Back to source, pause/resume, stop, Voice, speed, and progress;
- keeps rendered text after clear but removes the active highlight; and
- renders loading, empty, and inactive states without throwing.

- [ ] **Step 4: Style and verify**

Use a centered 720–800px reading column, sticky header/control bar, responsive spacing, visible focus styles, reduced-motion media query, and existing theme tokens. Do not add a theme selector or document editor.

Run the command from Step 2.

Expected: PASS and `dist/src/reader/reader.html` exists.

- [ ] **Step 5: Commit**

```bash
rtk git add src/reader rsbuild.config.ts tests/e2e/document-reader.spec.ts
rtk git commit -m "feat: add full document reader page"
```

---

### Task 6: Add the Side Panel Entry Point, Localization, and Privacy Regressions

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/sidepanel.css`
- Modify: `src/shared/locales/en.json`
- Modify: `src/shared/locales/vi.json`
- Modify: `tests/e2e/side-panel.spec.ts`
- Modify: `tests/e2e/free-tier.spec.ts`
- Modify: `tests/e2e/document-reader.spec.ts`

**Interfaces:**
- Consumes: runtime action `OPEN_DOCUMENT_READER`.
- Produces: localized **Open full reader** button and open-failure message.

- [ ] **Step 1: Add failing Side Panel tests**

Assert:

- the button is absent for Website, Manual, `none`, and no session;
- it is visible for a Google Docs/PDF `document-reader` session;
- click sends `OPEN_DOCUMENT_READER`;
- a failed command renders the localized projection-only error;
- current permissions remain exactly `activeTab`, `contextMenus`, `offscreen`, `scripting`, `sidePanel`, and `storage`; and
- extracted document text is absent from local/session storage.

- [ ] **Step 2: Run targeted tests**

```bash
CI=true rtk pnpm build
CI=true rtk pnpm exec playwright test tests/e2e/side-panel.spec.ts tests/e2e/free-tier.spec.ts tests/e2e/document-reader.spec.ts
```

Expected: FAIL on the missing button/copy and document flow.

- [ ] **Step 3: Implement the Side Panel action**

Add English/Vietnamese keys:

```json
"openDocumentReader": "Open full reader",
"documentReaderOpenFailed": "Unable to open the full reader. Audio will continue."
```

and the equivalent Vietnamese copy.

Render the button only when:

```ts
session?.readableSurface === 'document-reader'
```

Call `sendPlaybackCommand({ action: 'OPEN_DOCUMENT_READER' })`; show only the localized error on failure.

- [ ] **Step 4: Run targeted and full checks**

Run the command from Step 2, then:

```bash
CI=true rtk pnpm test:unit
CI=true rtk pnpm build
CI=true rtk pnpm validate:manifest
CI=true rtk pnpm test:e2e
rtk git diff --check
```

Expected: all PASS; manifest permissions unchanged.

- [ ] **Step 5: Refresh graph and commit**

```bash
rtk graphify update .
rtk git add src/sidepanel/App.tsx src/sidepanel/sidepanel.css src/shared/locales/en.json src/shared/locales/vi.json tests/e2e/side-panel.spec.ts tests/e2e/free-tier.spec.ts tests/e2e/document-reader.spec.ts
rtk git commit -m "feat: open document reader from side panel"
```

Do not stage `.github/workflows/release-extension.yml`.
