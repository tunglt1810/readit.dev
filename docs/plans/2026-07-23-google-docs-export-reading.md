# Google Docs Export Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let readit.dev read Google Docs that the active browser tab can access, while keeping Readability unchanged for every other webpage.

**Architecture:** A content-layer adapter recognizes only docs.google.com/document/d/<id> URLs and fetches that document's same-origin plain-text export. The adapter returns the existing Article contract or one shared failure code. Background keeps the whitelisted code in error sessions and command responses, while the React UI localizes it through the existing translation helper.

**Tech Stack:** TypeScript 6, Chrome Manifest V3, React 19, Mozilla Readability, Node test runner, Playwright.

## Global Constraints

- Support only https://docs.google.com/document/d/<id>/...; add no Sheets, Slides, Drive, OAuth, Google Drive API, backend request, or manifest permission.
- Fetch only the fixed export URL derived from the active Docs URL using credentials: same-origin.
- Do not scrape editor DOM, iframe, canvas, toolbar, or raw page UI. A Google Docs export failure never falls back to Readability.
- Keep export text in memory; never log its body or persist it.
- Add every new user-visible string to both English and Vietnamese THEME_TRANSLATIONS entries, rendered through t().
- Preserve manual playback if current-page extraction fails.
- Preserve user-owned untracked description_en.md and description_vi.md.
- After source changes run graphify update ..

---

## File Structure

| File | Responsibility |
| --- | --- |
| src/content/google_docs_extractor.ts | Parse supported Docs URLs, derive export URL, fetch and validate text, create Article or failure code. |
| src/content/content_script.ts | Select the adapter before the existing generic extractor and asynchronously respond to EXTRACT_ARTICLE. |
| src/shared/constants.ts | Export the shared code and its EN/VI text. |
| src/shared/i18n.ts | Localize only the shared code without changing unrelated errors. |
| src/background/background.ts | Whitelist, return, and session-persist the shared error code. |
| src/popup/App.tsx | Localize the code from command and session errors. |
| src/sidepanel/App.tsx | Localize the code while retaining manual checkpoint priority. |
| tests/unit/google_docs_extractor.test.ts | Deterministic URL, response, text, and failure contract coverage. |
| tests/e2e/reader.spec.ts | Real content-script tests using route-mocked Docs and export endpoints. |
| tests/e2e/themes.spec.ts | Popup localization tests. |
| tests/e2e/side-panel.spec.ts | Side Panel localization tests. |
| tests/e2e/reading-state.spec.ts | Coordinator regression proving manual playback survives export failure. |

### Task 1: Google Docs adapter and unit contract

**Files:**
- Create: src/content/google_docs_extractor.ts
- Create: tests/unit/google_docs_extractor.test.ts
- Modify: src/shared/constants.ts

**Interfaces:**
- Produces: GOOGLE_DOCS_EXPORT_UNAVAILABLE = 'googleDocsExportUnavailable'.
- Produces: parseGoogleDocsDocumentId(url: string): string | null.
- Produces: extractGoogleDocsArticle(input, fetcher): Promise<GoogleDocsExtractionResponse | null>.
- Null means the URL is not a supported Google Docs document; a non-null failure has the shared error code.
- Consumed by: src/content/content_script.ts in Task 2 and UI/background code in Task 3.

- [ ] **Step 1: Write the failing unit test**

    Create tests/unit/google_docs_extractor.test.ts:

        import assert from 'node:assert/strict';
        import test from 'node:test';

        import { GOOGLE_DOCS_EXPORT_UNAVAILABLE } from '../../src/shared/constants';
        import {
            extractGoogleDocsArticle,
            parseGoogleDocsDocumentId,
            type GoogleDocsFetch,
        } from '../../src/content/google_docs_extractor';

        test('parses only Docs document URLs', () => {
            assert.equal(
                parseGoogleDocsDocumentId('https://docs.google.com/document/d/google-doc-id/edit?tab=t.0'),
                'google-doc-id',
            );
            assert.equal(parseGoogleDocsDocumentId('https://docs.google.com/spreadsheets/d/google-doc-id/edit'), null);
            assert.equal(parseGoogleDocsDocumentId('https://example.com/document/d/google-doc-id/edit'), null);
            assert.equal(parseGoogleDocsDocumentId('https://docs.google.com/document/u/0/edit'), null);
        });

        test('creates an Article from same-origin plain text without collapsing paragraphs', async () => {
            const calls: Array<{ url: string; credentials: string | undefined }> = [];
            const fetcher: GoogleDocsFetch = async (url, init) => {
                calls.push({ url, credentials: init?.credentials });
                return {
                    ok: true,
                    headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
                    text: async () => 'Đoạn đầu.\\r\\n\\r\\nĐoạn sau.\\r\\n',
                };
            };

            const result = await extractGoogleDocsArticle(
                {
                    url: 'https://docs.google.com/document/d/google-doc-id/edit?tab=t.0',
                    title: 'Tài liệu thử nghiệm - Google Tài liệu',
                    lang: 'vi',
                },
                fetcher,
            );

            assert.deepEqual(result, {
                success: true,
                article: {
                    title: 'Tài liệu thử nghiệm - Google Tài liệu',
                    content: 'Đoạn đầu.\\n\\nĐoạn sau.',
                    url: 'https://docs.google.com/document/d/google-doc-id/edit?tab=t.0',
                    lang: 'vi',
                },
            });
            assert.deepEqual(calls, [
                {
                    url: 'https://docs.google.com/document/d/google-doc-id/export?format=txt',
                    credentials: 'same-origin',
                },
            ]);
        });

        test('returns the shared code for denied, non-text, empty, and rejected exports', async () => {
            const response = (ok: boolean, contentType: string, text: string): GoogleDocsFetch => async () => ({
                ok,
                headers: new Headers({ 'content-type': contentType }),
                text: async () => text,
            });
            const rejected: GoogleDocsFetch = async () => Promise.reject(new Error('network unavailable'));
            const page = { url: 'https://docs.google.com/document/d/google-doc-id/edit', title: 'Doc', lang: 'en' };

            for (const fetcher of [
                response(false, 'text/plain', ''),
                response(true, 'text/html', '<html></html>'),
                response(true, 'text/plain', ' \\r\\n '),
                rejected,
            ]) {
                assert.deepEqual(await extractGoogleDocsArticle(page, fetcher), {
                    success: false,
                    error: GOOGLE_DOCS_EXPORT_UNAVAILABLE,
                });
            }
        });

- [ ] **Step 2: Run the test to verify it fails**

Run: node --experimental-strip-types --test tests/unit/google_docs_extractor.test.ts

Expected: FAIL because the adapter module and shared code do not exist.

- [ ] **Step 3: Implement the adapter**

    Add near the shared constants in src/shared/constants.ts:

        export const GOOGLE_DOCS_EXPORT_UNAVAILABLE = 'googleDocsExportUnavailable';

    Create src/content/google_docs_extractor.ts:

        import { GOOGLE_DOCS_EXPORT_UNAVAILABLE } from '../shared/constants';
        import type { Article } from '../shared/types';

        export type GoogleDocsFetch = (
            url: string,
            init?: { credentials?: 'same-origin' },
        ) => Promise<Pick<Response, 'ok' | 'headers' | 'text'>>;

        export type GoogleDocsExtractionResponse =
            | { success: true; article: Article }
            | { success: false; error: typeof GOOGLE_DOCS_EXPORT_UNAVAILABLE };

        export function parseGoogleDocsDocumentId(url: string): string | null {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com') {
                    return null;
                }
                return parsed.pathname.match(/^\/document\/d\/([^/]+)(?:\/|$)/)?.[1] ?? null;
            } catch {
                return null;
            }
        }

        export async function extractGoogleDocsArticle(
            input: Pick<Article, 'url' | 'title' | 'lang'>,
            fetcher: GoogleDocsFetch,
        ): Promise<GoogleDocsExtractionResponse | null> {
            const documentId = parseGoogleDocsDocumentId(input.url);
            if (!documentId) {
                return null;
            }

            try {
                const exportUrl = new URL(
                    '/document/d/' + encodeURIComponent(documentId) + '/export?format=txt',
                    new URL(input.url).origin,
                ).href;
                const response = await fetcher(exportUrl, { credentials: 'same-origin' });
                const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
                const content = (await response.text()).replace(/\r\n?/g, '\n').trim();

                if (!response.ok || !contentType.startsWith('text/plain') || !content) {
                    return { success: false, error: GOOGLE_DOCS_EXPORT_UNAVAILABLE };
                }

                return { success: true, article: { ...input, content } };
            } catch {
                return { success: false, error: GOOGLE_DOCS_EXPORT_UNAVAILABLE };
            }
        }

Do not import Readability or inspect DOM in this adapter.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: node --experimental-strip-types --test tests/unit/google_docs_extractor.test.ts

Expected: PASS with three passing adapter tests.

- [ ] **Step 5: Commit the contract**

Run:

    git add src/shared/constants.ts src/content/google_docs_extractor.ts tests/unit/google_docs_extractor.test.ts
    git commit -m "feat: extract Google Docs exports"

Expected: one commit limited to the adapter, shared code, and unit test.

### Task 2: Call the adapter from the content script

**Files:**
- Modify: src/content/content_script.ts:1-40
- Modify: tests/e2e/reader.spec.ts:3-227

**Interfaces:**
- Consumes: extractGoogleDocsArticle() from Task 1.
- Produces: the existing EXTRACT_ARTICLE response shape asynchronously.
- Preserves: the current readable-article error for all non-Google URLs.
- Consumed by: requestArticleFromTab() and startCurrentPage() without a message-shape change.

- [ ] **Step 1: Add failing E2E reader cases**

    Append these tests inside the existing Reader Mode describe block:

        test('reads Google Docs from plain-text export instead of editor UI', async ({ context, extensionId }) => {
            await context.route('https://docs.google.com/document/d/google-doc-id/edit**', (route) =>
                route.fulfill({
                    contentType: 'text/html; charset=utf-8',
                    body: '<html lang="vi"><head><title>Google Doc</title></head><body><div role="application"><iframe></iframe></div></body></html>',
                }),
            );
            await context.route(/\/document\/d\/google-doc-id\/export\?format=txt$/, (route) =>
                route.fulfill({ contentType: 'text/plain; charset=utf-8', body: 'Đoạn export thứ nhất.\\n\\nĐoạn export thứ hai.' }),
            );

            const documentPage = await context.newPage();
            await documentPage.goto('https://docs.google.com/document/d/google-doc-id/edit?tab=t.0');
            const extPage = await context.newPage();
            await extPage.goto('chrome-extension://' + extensionId + '/src/popup/popup.html');
            await documentPage.bringToFront();

            const result = (await requestArticle(extPage)) as { success: boolean; article?: { content: string } };
            expect(result).toEqual({
                success: true,
                article: expect.objectContaining({ content: 'Đoạn export thứ nhất.\\n\\nĐoạn export thứ hai.' }),
            });
        });

        test('returns the shared code when Google Docs export is denied', async ({ context, extensionId }) => {
            await context.route('https://docs.google.com/document/d/denied-doc/edit**', (route) =>
                route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><div role="application"></div></body></html>' }),
            );
            await context.route(/\/document\/d\/denied-doc\/export\?format=txt$/, (route) =>
                route.fulfill({ status: 403, contentType: 'text/plain; charset=utf-8', body: '' }),
            );

            const documentPage = await context.newPage();
            await documentPage.goto('https://docs.google.com/document/d/denied-doc/edit');
            const extPage = await context.newPage();
            await extPage.goto('chrome-extension://' + extensionId + '/src/popup/popup.html');
            await documentPage.bringToFront();

            await expect(requestArticle(extPage)).resolves.toEqual({
                success: false,
                error: 'googleDocsExportUnavailable',
            });
        });

- [ ] **Step 2: Build and run the targeted test to verify failure**

Run:

    pnpm build
    CI=true pnpm test:e2e -- tests/e2e/reader.spec.ts

Expected: FAIL because EXTRACT_ARTICLE is still synchronous and only invokes Readability.

- [ ] **Step 3: Make only EXTRACT_ARTICLE asynchronous**

    In src/content/content_script.ts import the adapter and replace the synchronous helper with:

        type ArticleExtractionResponse =
            | { success: true; article: Article }
            | { success: false; error: string };

        function getDocumentLanguage(): string {
            return document.documentElement.lang.trim().toLowerCase().replace('_', '-').split('-')[0] || 'na';
        }

        async function extractArticle(): Promise<ArticleExtractionResponse> {
            const googleDocsResult = await extractGoogleDocsArticle(
                {
                    title: document.title || 'Untitled Article',
                    url: document.location.href,
                    lang: getDocumentLanguage(),
                },
                globalThis.fetch.bind(globalThis),
            );
            if (googleDocsResult) {
                return googleDocsResult;
            }

            const article = extractArticleFromDocument(document);
            return article
                ? { success: true, article }
                : { success: false, error: 'Could not find a readable article on this page.' };
        }

        if (msg.action === 'EXTRACT_ARTICLE') {
            void extractArticle().then(
                (response) => sendResponse(response),
                () => sendResponse({ success: false, error: 'Could not find a readable article on this page.' }),
            );
            return true;
        }

Keep GET_PAGE_INFO, the initialization guard, selection button, word highlighting, and extension-info test element unchanged.

- [ ] **Step 4: Rebuild and run the E2E test to verify success**

Run:

    pnpm build
    CI=true pnpm test:e2e -- tests/e2e/reader.spec.ts

Expected: PASS; the successful case uses only export text and the denied case returns googleDocsExportUnavailable.

- [ ] **Step 5: Commit the content integration**

Run:

    git add src/content/content_script.ts tests/e2e/reader.spec.ts
    git commit -m "feat: read Google Docs exports"

Expected: one commit limited to content-script integration and Reader Mode coverage.

### Task 3: Propagate and localize the export failure

**Files:**
- Modify: src/background/background.ts:36-43, 200-213, 450-488
- Modify: src/shared/constants.ts:41-168
- Modify: src/shared/i18n.ts:1-5
- Modify: src/popup/App.tsx:3-5, 140, 233-241
- Modify: src/sidepanel/App.tsx:3-5, 200-211
- Modify: tests/e2e/themes.spec.ts
- Modify: tests/e2e/side-panel.spec.ts
- Modify: tests/e2e/reading-state.spec.ts

**Interfaces:**
- Consumes: GOOGLE_DOCS_EXPORT_UNAVAILABLE from Task 1.
- Produces: getLocalizedPlaybackError(error?: string): string | undefined.
- Produces: the code in both CommandResponse.error and PlaybackSessionSnapshot.error only for this whitelisted content-script response.
- Preserves: generic ERROR_MESSAGES.extraction for all other extraction failures and the manual-session early return.

- [ ] **Step 1: Add failing Popup, Side Panel, and coordinator tests**

    Add this test to tests/e2e/themes.spec.ts:

        test('localizes Google Docs export errors from command and session state', async ({ page, openPopup }) => {
            await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
            await openPopup(page);
            await page.evaluate(() => {
                (window as any).commandResponses = {
                    START_CURRENT_PAGE: { success: false, error: 'googleDocsExportUnavailable' },
                };
            });

            await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
            await expect(page.locator('.alert-danger')).toHaveText(
                'Không thể đọc Google Docs này. Hãy kiểm tra quyền xem hoặc tải xuống, hoặc đọc văn bản đã chọn/dán.',
            );

            await page.evaluate((session) => {
                (window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session });
            }, { ...playingSession, status: 'error', error: 'googleDocsExportUnavailable' });
            await expect(page.locator('.alert-danger')).toHaveText(
                'Không thể đọc Google Docs này. Hãy kiểm tra quyền xem hoặc tải xuống, hoặc đọc văn bản đã chọn/dán.',
            );
        });

    Add this test to tests/e2e/side-panel.spec.ts:

        test('localizes Google Docs current-page export failures', async ({ page, openSidePanel }) => {
            await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
            await openSidePanel(page);
            await page.evaluate(() => {
                (window as any).commandResponses = {
                    START_CURRENT_PAGE: { success: false, error: 'googleDocsExportUnavailable' },
                };
            });

            await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
            await expect(page.getByText('Không thể đọc Google Docs này. Hãy kiểm tra quyền xem hoặc tải xuống, hoặc đọc văn bản đã chọn/dán.')).toBeVisible();
        });

    Add this complete coordinator regression to tests/e2e/reading-state.spec.ts:

        test('a denied Google Docs export preserves the active manual session', async ({ context, extensionId }) => {
            await context.route('https://docs.google.com/document/d/denied-manual-doc/edit**', (route) =>
                route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><div role="application"></div></body></html>' }),
            );
            await context.route(/\/document\/d\/denied-manual-doc\/export\?format=txt$/, (route) =>
                route.fulfill({ status: 403, contentType: 'text/plain; charset=utf-8', body: '' }),
            );

            const targetPage = await context.newPage();
            await targetPage.goto('https://docs.google.com/document/d/denied-manual-doc/edit');
            const controlPage = await context.newPage();
            await controlPage.goto('chrome-extension://' + extensionId + '/src/popup/popup.html');
            await expect(
                sendCoordinatorCommand(controlPage, {
                    action: 'START_MANUAL_TEXT',
                    payload: { text: 'Manual playback must survive.', language: 'en', panelInstanceId: manualPanelInstanceId },
                }),
            ).resolves.toEqual({ success: true });
            const manualSessionId = (await getBackgroundState(controlPage)).session?.sessionId;
            expect(manualSessionId).toEqual(expect.any(String));

            await targetPage.bringToFront();
            await expect(sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' })).resolves.toEqual({
                success: false,
                error: 'googleDocsExportUnavailable',
            });
            expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(manualSessionId);
        });

- [ ] **Step 2: Build and run the targeted tests to verify failure**

Run:

    pnpm build
    CI=true pnpm test:e2e -- tests/e2e/themes.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts

Expected: FAIL because the code is shown literally or replaced by the generic error, and the coordinator does not propagate it.

- [ ] **Step 3: Implement whitelisting and localization**

    Add these THEME_TRANSLATIONS entries in src/shared/constants.ts:

        googleDocsExportUnavailable: 'Không thể đọc Google Docs này. Hãy kiểm tra quyền xem hoặc tải xuống, hoặc đọc văn bản đã chọn/dán.'

        googleDocsExportUnavailable: 'Unable to read this Google Doc. Check view or download permission, or read selected/pasted text instead.'

    In src/shared/i18n.ts import GOOGLE_DOCS_EXPORT_UNAVAILABLE and add:

        export function getLocalizedPlaybackError(error: string | undefined): string | undefined {
            return error === GOOGLE_DOCS_EXPORT_UNAVAILABLE ? t('googleDocsExportUnavailable') : error;
        }

    In src/background/background.ts import the code, add a whitelist, and extend the failure publisher:

        function getExtractionError(error: string | undefined): string {
            return error === GOOGLE_DOCS_EXPORT_UNAVAILABLE ? GOOGLE_DOCS_EXPORT_UNAVAILABLE : ERROR_MESSAGES.extraction;
        }

        async function publishExtractionFailure(
            tabId: number,
            title: string | undefined,
            url: string,
            error: string = ERROR_MESSAGES.extraction,
        ): Promise<void> {
            await publishSession(
                createPlaybackErrorSession({
                    sessionId: crypto.randomUUID(),
                    source: { kind: 'tab', tabId, title: title || url, url },
                    voiceStyleId: DEFAULT_VOICE_STYLE_ID,
                    speed: DEFAULT_SPEED,
                    error,
                    now: Date.now(),
                }),
            );
            activeSession = null;
            await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
        }

In the non-success article-response branch, derive extractionError with
getExtractionError(articleResponse.error), return it directly when manual
playback is active, and otherwise pass it to both publishExtractionFailure and
the returned CommandResponse. Keep the catch branch generic because it has no
trusted content-script code.

    In src/popup/App.tsx import getLocalizedPlaybackError and use:

        const errorMsg = getLocalizedPlaybackError(commandError || session?.error || modelError);

        setCommandError(
            response.transportError
                ? t('startReadingFailed')
                : (getLocalizedPlaybackError(response.error) ?? t('startReadingFailed')),
        );

    In src/sidepanel/App.tsx import getLocalizedPlaybackError. Keep
manualCheckpointFailed as the first response-code branch, then use:

        : (getLocalizedPlaybackError(response.error) ?? t('startReadingFailed')),

Do not alter invalidManualText or manual-checkpoint handling.

- [ ] **Step 4: Rebuild and run the targeted tests to verify success**

Run:

    pnpm build
    CI=true pnpm test:e2e -- tests/e2e/themes.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts

Expected: PASS; both UI surfaces translate the code and manual playback survives the failed web start.

- [ ] **Step 5: Commit failure propagation and UI localization**

Run:

    git add src/background/background.ts src/shared/constants.ts src/shared/i18n.ts src/popup/App.tsx src/sidepanel/App.tsx tests/e2e/themes.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts
    git commit -m "fix: explain Google Docs export failures"

Expected: one commit limited to error propagation, translations, UI mapping, and focused regressions.

### Task 4: Verify the extension boundary and update graphify

**Files:**
- Verify: all files in Tasks 1-3
- Modify: graphify-out/ through graphify update .

**Interfaces:**
- Consumes: all completed tasks.
- Produces: a verified feature, clean diff, and updated local code graph.
- Preserves: user-owned untracked description files.

- [ ] **Step 1: Run the full unit suite**

Run: pnpm test:unit

Expected: PASS, including tests/unit/google_docs_extractor.test.ts.

- [ ] **Step 2: Build and validate the extension**

Run:

    pnpm build
    pnpm validate:manifest

Expected: both commands exit 0; manifest content and permissions have not changed.

- [ ] **Step 3: Run the focused browser suite**

Run:

    CI=true pnpm test:e2e -- tests/e2e/reader.spec.ts tests/e2e/themes.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts

Expected: PASS using route mocks only; no real Google account, Google Docs, backend, or telemetry request is required.

- [ ] **Step 4: Refresh the project graph**

Run: graphify update .

Expected: graphify records the adapter and its callers without changing source behavior.

- [ ] **Step 5: Inspect final repository state**

Run:

    git diff --check
    git status --short

Expected: no whitespace error, and description_en.md plus description_vi.md remain untracked and untouched. Do not create a verification-only commit: Tasks 1-3 already commit every source, test, and translation change.
