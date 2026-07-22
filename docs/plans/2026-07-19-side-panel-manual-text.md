# Side Panel and Manual Text Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Chrome Side Panel that reads the active page or locally pasted text through the existing single-session TTS coordinator while preserving the popup and all Free privacy boundaries.

**Architecture:** Build a dedicated `src/sidepanel/` React entry and keep the background service worker as the only playback coordinator. Model playback snapshots as a discriminated union between tab-owned Article/selection sessions and tab-independent manual sessions; prepare and detect manual text locally before replacing playback. Share runtime/i18n/theme adapters between popup and Side Panel without turning the popup into a surface-mode conditional.

**Tech Stack:** Chrome Manifest V3 (`sidePanel`, service worker, offscreen document), React 19, TypeScript 6, Rsbuild 2.1, Node test runner, Playwright 1.61, Biome 2.5.

## Global Constraints

- Keep `minimum_chrome_version` exactly `127`.
- Add only the `sidePanel` permission; add no `tabs`, identity, cookie, history, backend, telemetry, or extra host permission.
- Keep the popup as the quick-control surface; the Side Panel is optional and opens from a labeled secondary popup action.
- Side Panel order is current-page reading, then manual-text input, then a bottom playback dock.
- A valid manual-text request replaces the active session; there is no queue, history, saved draft, or cross-device sync.
- Manual sessions are independent of tab navigation, reload, and closure.
- Manual language starts at `auto`; explicit values are `en`, `vi`, and `zh`; uncertain Auto detection falls back to English.
- Manual drafts and playback text stay in memory and must never be written to `chrome.storage.local` or `chrome.storage.session`.
- Manual text never enters a content script and never creates a word-highlight scope.
- Popup and Side Panel share the stored Voice Style, speed, UI locale behavior, and active theme.
- Preserve the existing Default, Winamp, and WMP12 popup interactions and accessibility behavior.
- Use `.tmp/` for build caches, Playwright profiles, screenshots, and all other temporary artifacts.
- The canonical design is `docs/specs/2026-07-19-side-panel-manual-text-design.md`.

---

## File map

### New files

- `src/background/manual_text.ts` — validate manual payloads, preserve paragraphs, and resolve explicit or automatic language locally.
- `src/background/page_info.ts` — retrieve advisory current-page metadata through the already-installed content script with the existing one-time reinjection pattern.
- `src/popup/side_panel.ts` — resolve the current window and open the Chrome Side Panel behind an injectable API.
- `src/shared/i18n.ts` — shared EN/VI UI-language resolution and translation helper.
- `src/shared/playback_client.ts` — shared runtime request/subscription adapter used by both React surfaces.
- `src/shared/theme.css` — shared theme custom properties only; surface layout remains in its own stylesheet.
- `src/sidepanel/App.tsx` — Side Panel layout, in-memory draft, manual language, current-page card, and playback dock.
- `src/sidepanel/index.tsx` — Side Panel React root.
- `src/sidepanel/sidepanel.html` — Side Panel HTML template.
- `src/sidepanel/sidepanel.css` — Side Panel-specific responsive and themed layout.
- `tests/unit/manual_text.test.ts` — manual normalization and language detection contract.
- `tests/unit/page_info.test.ts` — current-page metadata request and reinjection behavior.
- `tests/unit/playback_client.test.ts` — shared runtime adapter behavior.
- `tests/unit/side_panel.test.ts` — popup-to-Side-Panel API behavior and failure propagation.
- `tests/e2e/side-panel.spec.ts` — Side Panel layout, input, commands, hydration, themes, accessibility, and privacy behavior.

### Existing files with focused changes

- `src/shared/types.ts` — `PlaybackContent`, manual language/message types, and discriminated playback snapshots.
- `src/shared/constants.ts` — localized Side Panel/manual-text labels.
- `src/background/playback_state.ts` — construct, validate, update, and ownership-check both session variants.
- `src/background/background.ts` — route manual starts and page-info requests through the serialized coordinator; guard all tab-only highlight work.
- `src/content/content_script.ts` — answer advisory `GET_PAGE_INFO` requests only.
- `src/popup/App.tsx` — consume shared adapters/session source and render the secondary Side Panel action.
- `src/popup/index.tsx` / `src/popup/popup.css` — import shared theme variables and remove duplicated variable blocks.
- `rsbuild.config.ts` — build the Side Panel entry and emit its HTML at the manifest path.
- `public/manifest.json` — declare `sidePanel` permission and `side_panel.default_path`.
- `scripts/validate-free-manifest.mjs` — require the exact Side Panel permission/path while retaining the exact Free boundary.
- `tests/unit/playback_state.test.ts`, `tests/unit/manifest_validation.test.ts`, `tests/unit/theme_i18n.test.ts` — unit regression coverage.
- `tests/e2e/fixtures.ts` — open the emitted Side Panel page and install popup/Side Panel runtime mocks.
- `tests/e2e/support.spec.ts`, `tests/e2e/themes.spec.ts`, `tests/e2e/tts-controls.spec.ts`, `tests/e2e/reading-state.spec.ts` — adopt the session-source contract and verify cross-surface behavior.
- `README.md`, `docs/PRD.md`, `docs/privacy-policy.md`, `docs/RELEASING.md`, `docs/specs/2026-07-19-side-panel-manual-text-design.md` — align shipping behavior after verification.

---

### Task 1: Manual text preparation and local language detection

**Files:**
- Create: `src/background/manual_text.ts`
- Create: `tests/unit/manual_text.test.ts`
- Modify: `src/shared/types.ts:1-6`

**Interfaces:**
- Consumes: untrusted `unknown` payload from `START_MANUAL_TEXT`.
- Produces: `PlaybackContent`, `ManualTextLanguage`, `ResolvedManualTextLanguage`, `StartManualTextMessage`, `detectManualTextLanguage(text)`, and `prepareManualText(payload)`.

- [ ] **Step 1: Define playback-content and manual-message types**

Add these declarations before `Article` in `src/shared/types.ts`, and make `Article` extend `PlaybackContent`:

```ts
export interface PlaybackContent {
	content: string;
	lang: string;
}

export interface Article extends PlaybackContent {
	title: string;
	url: string;
}

export type ManualTextLanguage = 'auto' | 'en' | 'vi' | 'zh';
export type ResolvedManualTextLanguage = Exclude<ManualTextLanguage, 'auto'>;

export interface StartManualTextMessage {
	action: 'START_MANUAL_TEXT';
	payload: {
		text: string;
		language: ManualTextLanguage;
	};
}

export interface CommandResponse {
	success: boolean;
	error?: string;
}
```

- [ ] **Step 2: Write failing manual-text tests**

Create `tests/unit/manual_text.test.ts` with these cases:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectManualTextLanguage, prepareManualText } from '../../src/background/manual_text.ts';

test('normalizes line endings while preserving paragraph boundaries', () => {
	assert.deepEqual(prepareManualText({ text: '  First line\r\n\r\nSecond line  ', language: 'en' }), {
		content: 'First line\n\nSecond line',
		lang: 'en',
	});
});

test('rejects malformed, unsupported, and whitespace-only payloads', () => {
	assert.equal(prepareManualText(null), null);
	assert.equal(prepareManualText({ text: 42, language: 'auto' }), null);
	assert.equal(prepareManualText({ text: '   \n ', language: 'auto' }), null);
	assert.equal(prepareManualText({ text: 'Hello', language: 'fr' }), null);
});

test('explicit language bypasses automatic detection', () => {
	assert.deepEqual(prepareManualText({ text: 'Hello', language: 'vi' }), { content: 'Hello', lang: 'vi' });
	assert.deepEqual(prepareManualText({ text: 'Xin chào', language: 'zh' }), { content: 'Xin chào', lang: 'zh' });
});

test('detects dominant Han text as Chinese', () => {
	assert.equal(detectManualTextLanguage('Hello 中文內容，這是一段測試。'), 'zh');
});

test('detects Vietnamese-exclusive letters or two common function words', () => {
	assert.equal(detectManualTextLanguage('Tôi muốn đọc văn bản này.'), 'vi');
	assert.equal(detectManualTextLanguage('toi va ban khong can may chu'), 'vi');
});

test('falls back to English when automatic detection is uncertain', () => {
	assert.equal(detectManualTextLanguage('Plain text without a strong language signal.'), 'en');
	assert.equal(detectManualTextLanguage('123 😀 !!!'), 'en');
});
```

- [ ] **Step 3: Run the new test and verify the red state**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_text.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/background/manual_text.ts`.

- [ ] **Step 4: Implement the minimal deterministic preparation module**

Create `src/background/manual_text.ts`:

```ts
import type { ManualTextLanguage, PlaybackContent, ResolvedManualTextLanguage } from '../shared/types.ts';

const MANUAL_LANGUAGES = new Set<ManualTextLanguage>(['auto', 'en', 'vi', 'zh']);
const VIETNAMESE_EXCLUSIVE = /[ăằắẳẵặđơờớởỡợưừứửữự]/iu;
const VIETNAMESE_FUNCTION_WORDS = new Set(['va', 'và', 'cua', 'của', 'mot', 'một', 'nhung', 'những', 'khong', 'không', 'duoc', 'được', 'trong', 'cho', 'voi', 'với', 'cac', 'các']);

function normalizeManualText(text: string): string {
	return text
		.normalize('NFKC')
		.replace(/\r\n?/gu, '\n')
		.split('\n')
		.map((line) => line.replace(/[\t ]+/gu, ' ').trimEnd())
		.join('\n')
		.trim();
}

export function detectManualTextLanguage(text: string): ResolvedManualTextLanguage {
	const normalized = text.normalize('NFKC').toLocaleLowerCase();
	const letters = normalized.match(/\p{L}/gu) ?? [];
	const hanCount = (normalized.match(/\p{Script=Han}/gu) ?? []).length;
	if (letters.length > 0 && hanCount / letters.length >= 0.2) {
		return 'zh';
	}
	const words = normalized.match(/\p{L}+/gu) ?? [];
	const functionWordCount = words.filter((word) => VIETNAMESE_FUNCTION_WORDS.has(word)).length;
	return VIETNAMESE_EXCLUSIVE.test(normalized) || functionWordCount >= 2 ? 'vi' : 'en';
}

export function prepareManualText(payload: unknown): PlaybackContent | null {
	if (!payload || typeof payload !== 'object') {
		return null;
	}
	const input = payload as Record<string, unknown>;
	if (typeof input.text !== 'string' || typeof input.language !== 'string' || !MANUAL_LANGUAGES.has(input.language as ManualTextLanguage)) {
		return null;
	}
	const content = normalizeManualText(input.text);
	if (!content) {
		return null;
	}
	const language = input.language as ManualTextLanguage;
	return { content, lang: language === 'auto' ? detectManualTextLanguage(content) : language };
}
```

- [ ] **Step 5: Run focused and full unit tests**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_text.test.ts
pnpm test:unit
```

Expected: the six focused tests PASS, then the full unit suite PASS.

- [ ] **Step 6: Commit the pure manual-text contract**

```bash
git add src/shared/types.ts src/background/manual_text.ts tests/unit/manual_text.test.ts
git commit -m "feat: prepare manual text locally"
```

---

### Task 2: Discriminated playback sessions and tab ownership

**Files:**
- Modify: `src/shared/types.ts:15-54`
- Modify: `src/shared/constants.ts:41-114`
- Modify: `src/background/playback_state.ts:1-93`
- Modify: `src/background/background.ts:44-100,136-200,268-335,470-509`
- Modify: `src/popup/App.tsx:12-18,129-154,427-441`
- Modify: `tests/unit/playback_state.test.ts`
- Modify: `tests/unit/theme_i18n.test.ts`
- Modify: `tests/e2e/support.spec.ts:15-32`
- Modify: `tests/e2e/themes.spec.ts:3-16`
- Modify: `tests/e2e/tts-controls.spec.ts:3-16`
- Modify: `tests/e2e/reading-state.spec.ts:6-32,73-107,184-279`

**Interfaces:**
- Consumes: `PlaybackContent` from Task 1 and all existing session progress messages.
- Produces: `TabPlaybackSessionSnapshot`, `ManualPlaybackSessionSnapshot`, `PlaybackSessionSnapshot`, `isPlaybackSessionSnapshot()`, `createPlaybackSession()`, and `ownsTab()` with explicit source semantics.

- [ ] **Step 1: Replace playback-state tests with the discriminated contract first**

Change the shared tab input in `tests/unit/playback_state.test.ts` to:

```ts
const tabInput = {
	sessionId: 'session-1',
	contentScope: 'article' as const,
	source: { kind: 'tab' as const, tabId: 42, title: 'An article', url: 'https://example.com/article' },
	lang: 'en',
	voiceStyleId: 'M1',
	speed: 1.05,
	now: 1000,
};
```

Add these assertions:

```ts
test('creates a tab-owned loading session', () => {
	assert.deepEqual(createPlaybackSession(tabInput), {
		sessionId: 'session-1',
		contentScope: 'article',
		source: { kind: 'tab', tabId: 42, title: 'An article', url: 'https://example.com/article' },
		lang: 'en',
		status: 'loading',
		currentParagraphIndex: 0,
		totalParagraphs: 0,
		progressPercentage: 0,
		voiceStyleId: 'M1',
		speed: 1.05,
		updatedAt: 1000,
	});
});

test('creates a manual loading session without tab metadata', () => {
	const session = createPlaybackSession({
		sessionId: 'manual-1',
		contentScope: 'manual',
		source: { kind: 'manual' },
		lang: 'vi',
		voiceStyleId: 'F1',
		speed: 1.1,
		now: 2000,
	});
	assert.deepEqual(session.source, { kind: 'manual' });
	assert.equal('tabId' in session.source, false);
	assert.equal(JSON.stringify(session).includes('manual content'), false);
});

test('validates only legal source and scope combinations', () => {
	assert.equal(isPlaybackSessionSnapshot(createPlaybackSession(tabInput)), true);
	assert.equal(
		isPlaybackSessionSnapshot(createPlaybackSession({ ...tabInput, sessionId: 'selection', contentScope: 'selection' })),
		true,
	);
	assert.equal(
		isPlaybackSessionSnapshot({ ...createPlaybackSession(tabInput), contentScope: 'manual' }),
		false,
	);
	assert.equal(isPlaybackSessionSnapshot({ ...createPlaybackSession(tabInput), source: { kind: 'manual' } }), false);
});

test('manual sessions never own browser tabs', () => {
	const manual = createPlaybackSession({
		sessionId: 'manual-1',
		contentScope: 'manual',
		source: { kind: 'manual' },
		lang: 'en',
		voiceStyleId: 'M1',
		speed: 1.05,
		now: 1000,
	});
	assert.equal(ownsTab(manual, 42), false);
});
```

- [ ] **Step 2: Run the focused test to verify it fails on the old shape**

Run:

```bash
node --experimental-strip-types --test tests/unit/playback_state.test.ts
```

Expected: FAIL because `source` and `isPlaybackSessionSnapshot` are not implemented.

- [ ] **Step 3: Introduce the discriminated snapshot types**

Replace the old `PlaybackContentScope` and `PlaybackSessionSnapshot` block in `src/shared/types.ts` with:

```ts
export type PlaybackStatus = 'stopped' | 'loading' | 'playing' | 'paused' | 'error';
export type PlaybackContentScope = 'article' | 'selection' | 'manual';

export interface PlaybackSessionBase {
	sessionId: string;
	lang: string;
	status: PlaybackStatus;
	currentParagraphIndex: number;
	totalParagraphs: number;
	progressPercentage: number;
	voiceStyleId: string;
	speed: number;
	error?: string;
	updatedAt: number;
}

export interface TabPlaybackSessionSnapshot extends PlaybackSessionBase {
	contentScope: 'article' | 'selection';
	source: { kind: 'tab'; tabId: number; title: string; url: string };
}

export interface ManualPlaybackSessionSnapshot extends PlaybackSessionBase {
	contentScope: 'manual';
	source: { kind: 'manual' };
}

export type PlaybackSessionSnapshot = TabPlaybackSessionSnapshot | ManualPlaybackSessionSnapshot;
```

Keep `PlaybackProgress`, `PlaybackProgressUpdateMessage`, and `PlaybackStateResponse` unchanged apart from their reference to the new union.

- [ ] **Step 4: Make playback-state helpers preserve and validate the union**

In `src/background/playback_state.ts`, define and construct the union explicitly:

```ts
type PlaybackSessionInputBase = {
	sessionId: string;
	lang: string;
	voiceStyleId: string;
	speed: number;
	now: number;
};

type CreatePlaybackSessionInput = PlaybackSessionInputBase & (
	| { contentScope: 'article' | 'selection'; source: { kind: 'tab'; tabId: number; title: string; url: string } }
	| { contentScope: 'manual'; source: { kind: 'manual' } }
);

export function createPlaybackSession(input: CreatePlaybackSessionInput): PlaybackSessionSnapshot {
	const base = {
		sessionId: input.sessionId,
		lang: input.lang,
		status: 'loading' as const,
		currentParagraphIndex: 0,
		totalParagraphs: 0,
		progressPercentage: 0,
		voiceStyleId: input.voiceStyleId,
		speed: input.speed,
		updatedAt: input.now,
	};
	return input.source.kind === 'manual'
		? { ...base, contentScope: 'manual', source: input.source }
		: { ...base, contentScope: input.contentScope, source: input.source };
}
```

Preserve metadata with object spread in `applyPlaybackProgress()`, and export this validator:

```ts
export function isPlaybackSessionSnapshot(value: unknown): value is PlaybackSessionSnapshot {
	if (!value || typeof value !== 'object') return false;
	const session = value as Record<string, unknown>;
	const source = session.source as Record<string, unknown> | undefined;
	const baseIsValid =
		typeof session.sessionId === 'string' &&
		typeof session.lang === 'string' &&
		isPlaybackStatus(session.status) &&
		isFiniteNumber(session.currentParagraphIndex) &&
		isFiniteNumber(session.totalParagraphs) &&
		isFiniteNumber(session.progressPercentage) &&
		typeof session.voiceStyleId === 'string' &&
		isFiniteNumber(session.speed) &&
		(session.error === undefined || typeof session.error === 'string') &&
		isFiniteNumber(session.updatedAt);
	if (!baseIsValid || !source) return false;
	if (source.kind === 'manual') return session.contentScope === 'manual' && Object.keys(source).length === 1;
	return (
		source.kind === 'tab' &&
		(session.contentScope === 'article' || session.contentScope === 'selection') &&
		Number.isInteger(source.tabId) &&
		typeof source.title === 'string' &&
		typeof source.url === 'string'
	);
}

export function ownsTab(session: PlaybackSessionSnapshot | null, tabId: number): boolean {
	return session?.source.kind === 'tab' && session.source.tabId === tabId;
}
```

Make `applyPlaybackProgress()` return `{ ...session, ...progress, updatedAt: now }` after the existing session-ID checks so TypeScript preserves either union member.

- [ ] **Step 5: Migrate background tab-only access without adding manual behavior yet**

Import shared `CommandResponse`, import `isPlaybackSessionSnapshot` from `playback_state.ts`, and delete both the local command-response alias and private snapshot validator from `background.ts`. Change every tab-only message to guard the source:

```ts
if (session?.source.kind === 'tab') {
	await chrome.tabs.sendMessage(session.source.tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: session.sessionId });
}
```

Construct Article/selection/error sessions with:

```ts
source: { kind: 'tab', tabId, title: article.title || fallbackTitle || fallbackUrl, url: article.url || fallbackUrl },
contentScope,
```

In both word-highlight relay functions, return immediately unless `activeSession?.source.kind === 'tab'`; send messages to `activeSession.source.tabId`.

- [ ] **Step 6: Add the manual-session labels before migrating popup rendering**

Add these exact entries to both languages in `THEME_TRANSLATIONS` and assert them in `theme_i18n.test.ts`:

```ts
// vi
pastedText: 'Văn bản đã dán',
manualSession: 'Phiên đọc văn bản',

// en
pastedText: 'Pasted text',
manualSession: 'Manual text session',
```

- [ ] **Step 7: Migrate popup rendering to the source discriminator**

Import shared `CommandResponse`, delete the popup's local command-response alias, and replace direct `session.tabId/title/url` reads in `src/popup/App.tsx` with:

```ts
const tabSource = session?.source.kind === 'tab' ? session.source : null;
const isSessionOnAnotherTab = tabSource !== null && tabSource.tabId !== currentTabId;
const sessionTitle = session?.contentScope === 'manual' ? t('pastedText') : (tabSource?.title ?? '');
const sessionHost = tabSource ? getHost(tabSource.url) : '';
```

Render `sessionTitle`, hide the host when empty, and render `t('manualSession')` instead of the this-tab/other-tab label for manual sessions.

- [ ] **Step 8: Migrate every typed E2E session fixture explicitly**

Use these exact source values in the three fixture files:

```ts
// tests/e2e/support.spec.ts
contentScope: 'article' as const,
source: { kind: 'tab' as const, tabId: 7, title: 'Private page title', url: 'https://private.example.test/article' },

// tests/e2e/themes.spec.ts
contentScope: 'article' as const,
source: { kind: 'tab' as const, tabId: 7, title: 'Theme article', url: 'https://example.com/theme-article' },

// tests/e2e/tts-controls.spec.ts
contentScope: 'article' as const,
source: { kind: 'tab' as const, tabId: 7, title: 'An article', url: 'https://example.com/article' },
```

In `reading-state.spec.ts`:

- define `activeSession.source` with tab ID `11` and its existing title/URL;
- define `replacementSession.source` with tab ID `22` and its existing title/URL;
- seed with `source: { ...activeSession.source, tabId }`;
- assert `source: { kind: 'tab', tabId: targetTabId }` for real starts;
- read `session.source.title` in hydration assertions.

- [ ] **Step 9: Run focused tests, full unit tests, and a production build**

Run:

```bash
node --experimental-strip-types --test tests/unit/playback_state.test.ts
pnpm test:unit
pnpm build
```

Expected: all commands PASS; TypeScript reports no stale top-level session metadata access.

- [ ] **Step 10: Commit the session-source migration**

```bash
git add src/shared/types.ts src/shared/constants.ts src/background/playback_state.ts src/background/background.ts src/popup/App.tsx tests/unit/playback_state.test.ts tests/unit/theme_i18n.test.ts tests/e2e/support.spec.ts tests/e2e/themes.spec.ts tests/e2e/tts-controls.spec.ts tests/e2e/reading-state.spec.ts
git commit -m "refactor: distinguish manual playback sessions"
```

---

### Task 3: Route manual starts through the single coordinator

**Files:**
- Modify: `src/background/background.ts:1-10,287-335,519-589`
- Modify: `tests/e2e/reading-state.spec.ts`
- Test: `tests/unit/manual_text.test.ts`

**Interfaces:**
- Consumes: `prepareManualText(payload)` and the discriminated session constructors from Tasks 1-2.
- Produces: runtime handling for `START_MANUAL_TEXT`; a valid request creates `contentScope: 'manual'`, `source: { kind: 'manual' }`, and the existing offscreen `PLAY` payload without persisting text.

- [ ] **Step 1: Add failing real-coordinator tests for manual replacement and privacy**

Append to `tests/e2e/reading-state.spec.ts`:

```ts
test('manual text starts a tab-independent loading session without persisting content', async ({ context, extensionId }) => {
	const controlPage = await context.newPage();
	await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	const response = await sendCoordinatorCommand(controlPage, {
		action: 'START_MANUAL_TEXT',
		payload: { text: 'Nội dung thủ công chỉ nằm trong bộ nhớ.', language: 'auto' },
	});
	expect(response).toEqual({ success: true });
	const state = await getBackgroundState(controlPage);
	expect(state.session).toMatchObject({ contentScope: 'manual', source: { kind: 'manual' }, lang: 'vi', status: 'loading' });
	const stored = await controlPage.evaluate(() => chrome.storage.session.get('readit_playback_session'));
	expect(JSON.stringify(stored)).not.toContain('Nội dung thủ công');
});

test('invalid manual text preserves the active session', async ({ context, extensionId }) => {
	const controlPage = await context.newPage();
	await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	expect(await sendCoordinatorCommand(controlPage, {
		action: 'START_MANUAL_TEXT',
		payload: { text: 'Existing manual session', language: 'en' },
	})).toEqual({ success: true });
	const before = await getBackgroundState(controlPage);
	expect(await sendCoordinatorCommand(controlPage, {
		action: 'START_MANUAL_TEXT',
		payload: { text: '   ', language: 'auto' },
	})).toEqual({ success: false, error: 'invalidManualText' });
	expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(before.session?.sessionId);
});
```

- [ ] **Step 2: Add failing lifecycle coverage for tab independence**

Add one test that opens a routed HTTP page, starts manual playback from an extension control page, reloads and closes the HTTP page, and asserts the same session survives:

```ts
test('manual playback survives unrelated tab navigation and closure', async ({ context, extensionId }) => {
	const targetPage = await createTargetPage(context);
	const controlPage = await context.newPage();
	await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	expect(await sendCoordinatorCommand(controlPage, {
		action: 'START_MANUAL_TEXT',
		payload: { text: 'Manual playback must survive.', language: 'en' },
	})).toEqual({ success: true });
	const sessionId = (await getBackgroundState(controlPage)).session?.sessionId;
	await targetPage.reload({ waitUntil: 'domcontentloaded' });
	expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(sessionId);
	await targetPage.close();
	expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(sessionId);
});
```

- [ ] **Step 3: Build and run the targeted E2E file to verify red state**

Run:

```bash
pnpm build
CI=true pnpm exec playwright test tests/e2e/reading-state.spec.ts
```

Expected: the new tests FAIL because `START_MANUAL_TEXT` has no route.

- [ ] **Step 4: Generalize the session-start function around source and content**

Replace the tab-parameter-only function with this input union:

```ts
type StartPlaybackInput =
	| { contentScope: 'article' | 'selection'; source: { kind: 'tab'; tabId: number; title: string; url: string }; content: PlaybackContent }
	| { contentScope: 'manual'; source: { kind: 'manual' }; content: PlaybackContent };
```

Rename `startArticlePlayback()` to `startPlayback(input)`. After `ensureHydrated()` and `stopActiveSession('session-replaced')`, create the snapshot from `input.source`, `input.contentScope`, and `input.content.lang`. Dispatch the existing offscreen payload as:

```ts
payload: { sessionId: session.sessionId, article: input.content, voiceStyleId, speed }
```

Only run `WORD_HIGHLIGHT_SET_SELECTION_SCOPE` when `input.contentScope === 'selection' && input.source.kind === 'tab'`; pass `input.content.content` as `selectionText`.

- [ ] **Step 5: Route all three start sources through the generalized function**

Full Article and selection callers pass their existing `Article` as `content` and tab metadata as `source`. Add:

```ts
async function startManualText(payload: unknown): Promise<CommandResponse> {
	const content = prepareManualText(payload);
	if (!content) {
		return { success: false, error: 'invalidManualText' };
	}
	return startPlayback({ contentScope: 'manual', source: { kind: 'manual' }, content });
}
```

Add the message route before playback controls:

```ts
case 'START_MANUAL_TEXT':
	return respondFromQueue(() => startManualText(msg.payload), sendResponse);
```

Validation occurs inside the queued operation before `startPlayback()` calls `stopActiveSession()`, preserving an existing session for invalid input.

- [ ] **Step 6: Run targeted lifecycle, unit, and build verification**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_text.test.ts tests/unit/playback_state.test.ts
pnpm build
CI=true pnpm exec playwright test tests/e2e/reading-state.spec.ts
```

Expected: all commands PASS, including manual session survival and storage privacy.

- [ ] **Step 7: Commit coordinator integration**

```bash
git add src/background/background.ts tests/e2e/reading-state.spec.ts
git commit -m "feat: coordinate manual text playback"
```

---

### Task 4: Emit and validate the Side Panel extension page

**Files:**
- Create: `src/sidepanel/sidepanel.html`
- Create: `src/sidepanel/index.tsx`
- Create: `src/sidepanel/App.tsx`
- Create: `src/sidepanel/sidepanel.css`
- Modify: `rsbuild.config.ts:46-59,101-119`
- Modify: `public/manifest.json:13-14,29-39`
- Modify: `scripts/validate-free-manifest.mjs:5-17,47-60`
- Modify: `tests/unit/manifest_validation.test.ts`
- Modify: `tests/e2e/fixtures.ts:51-56,123-131`
- Create: `tests/e2e/side-panel.spec.ts`

**Interfaces:**
- Consumes: Chrome 127 MV3 build and existing extension-page CSP.
- Produces: emitted `src/sidepanel/sidepanel.html`, exact manifest declaration, and Playwright `openSidePanel(page)` fixture.

- [ ] **Step 1: Make manifest validation fail on the missing Side Panel contract**

Update `validManifest` in `tests/unit/manifest_validation.test.ts`:

```ts
permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'contextMenus', 'sidePanel'],
side_panel: { default_path: 'src/sidepanel/sidepanel.html' },
```

Add:

```ts
test('rejects a missing or remote Side Panel path', () => {
	assert.throws(() => validateFreeManifest({ ...validManifest, side_panel: undefined }), /side_panel/);
	assert.throws(
		() => validateFreeManifest({ ...validManifest, side_panel: { default_path: 'https://example.com/panel' } }),
		/src\/sidepanel\/sidepanel\.html/,
	);
});
```

- [ ] **Step 2: Run the manifest test and verify red state**

Run:

```bash
node --experimental-strip-types --test tests/unit/manifest_validation.test.ts
```

Expected: FAIL because `sidePanel` and `side_panel.default_path` are not required yet.

- [ ] **Step 3: Add the exact manifest and validator entries**

Add `"sidePanel"` to `public/manifest.json` permissions and:

```json
"side_panel": {
	"default_path": "src/sidepanel/sidepanel.html"
},
```

In `validate-free-manifest.mjs`, add `sidePanel` to `REQUIRED_PERMISSIONS`, define:

```js
const REQUIRED_SIDE_PANEL_PATH = 'src/sidepanel/sidepanel.html';
```

and reject any other value:

```js
if (manifest.side_panel?.default_path !== REQUIRED_SIDE_PANEL_PATH) {
	throw new Error(`Expected side_panel.default_path ${REQUIRED_SIDE_PANEL_PATH}`);
}
```

- [ ] **Step 4: Create the minimal React Side Panel shell**

Create `src/sidepanel/sidepanel.html`:

```html
<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>readit.dev Side Panel</title>
	</head>
	<body>
		<div id="root"></div>
	</body>
</html>
```

Create `App.tsx`:

```tsx
export default function App() {
	return <main className="side-panel" data-theme="default" aria-label="readit.dev Side Panel" />;
}
```

Create `src/sidepanel/index.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './sidepanel.css';

const container = document.getElementById('root');
if (!container) throw new Error('Failed to find the Side Panel root element');
createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);
```

Create `sidepanel.css` with:

```css
* { box-sizing: border-box; }
html, body, #root { min-height: 100%; }
body { margin: 0; background: #09090b; }
.side-panel { min-height: 100vh; color: #f4f4f5; }
```

- [ ] **Step 5: Add the Rsbuild entry and exact output path**

Add `sidepanel: './src/sidepanel/index.tsx'` beside `popup`. Return `./src/sidepanel/sidepanel.html` from `html.template()` for `entryName === 'sidepanel'`, and set `config.filename = 'src/sidepanel/sidepanel.html'` in `htmlPlugin()`.

- [ ] **Step 6: Add an E2E fixture and emitted-page smoke test**

Extend the fixture type with `openSidePanel: (page: Page) => Promise<void>` and implement navigation to:

```ts
const sidePanelUrl = `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`;
```

Create the first test in `side-panel.spec.ts`:

```ts
import { expect, test } from './fixtures';

test('build emits the manifest Side Panel page', async ({ page, openSidePanel }) => {
	await openSidePanel(page);
	await expect(page.getByRole('main', { name: 'readit.dev Side Panel' })).toBeVisible();
});
```

- [ ] **Step 7: Verify manifest, build output, and Side Panel smoke test**

Run:

```bash
node --experimental-strip-types --test tests/unit/manifest_validation.test.ts
pnpm build
pnpm validate:manifest
CI=true pnpm exec playwright test tests/e2e/side-panel.spec.ts
```

Expected: all commands PASS and `dist/src/sidepanel/sidepanel.html` exists.

- [ ] **Step 8: Commit the platform shell**

```bash
git add public/manifest.json scripts/validate-free-manifest.mjs rsbuild.config.ts src/sidepanel tests/unit/manifest_validation.test.ts tests/e2e/fixtures.ts tests/e2e/side-panel.spec.ts
git commit -m "feat: add Side Panel extension entry"
```

---

### Task 5: Add the popup Side Panel action and shared theme/i18n adapters

**Files:**
- Create: `src/popup/side_panel.ts`
- Create: `tests/unit/side_panel.test.ts`
- Create: `src/shared/i18n.ts`
- Create: `src/shared/theme.css`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts:41-114`
- Modify: `src/popup/App.tsx:1-43,129-154,460-531`
- Modify: `src/popup/index.tsx:4-7`
- Modify: `src/popup/popup.css:1-29,680-691,818-829`
- Modify: `tests/unit/theme_i18n.test.ts`
- Modify: `tests/e2e/fixtures.ts:7-49`
- Modify: `tests/e2e/tts-controls.spec.ts`

**Interfaces:**
- Consumes: `chrome.tabs.query({ active: true, currentWindow: true })`, `chrome.sidePanel.open({ windowId })`, stored theme key, and the existing translation map.
- Produces: `openSidePanelForCurrentWindow()`, `ThemeName`, shared `uiLang`/`t()`, shared theme variables, and a localized popup secondary action.

- [ ] **Step 1: Write failing Side Panel opener unit tests**

Create `tests/unit/side_panel.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { openSidePanelForCurrentWindow } from '../../src/popup/side_panel.ts';

test('opens the Side Panel in the active tab window', async () => {
	const calls: unknown[] = [];
	await openSidePanelForCurrentWindow({
		queryTabs: async () => [{ windowId: 9 }],
		open: async (options) => calls.push(options),
	});
	assert.deepEqual(calls, [{ windowId: 9 }]);
});

test('rejects when the current window cannot be resolved', async () => {
	await assert.rejects(
		openSidePanelForCurrentWindow({ queryTabs: async () => [], open: async () => undefined }),
		/current window/,
	);
});

test('propagates the Chrome Side Panel rejection', async () => {
	const error = new Error('Side Panel unavailable');
	await assert.rejects(
		openSidePanelForCurrentWindow({ queryTabs: async () => [{ windowId: 9 }], open: async () => { throw error; } }),
		error,
	);
});
```

- [ ] **Step 2: Run the opener test and verify red state**

Run:

```bash
node --experimental-strip-types --test tests/unit/side_panel.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the injected opener**

Create `src/popup/side_panel.ts`:

```ts
export interface SidePanelDependencies {
	queryTabs(): Promise<Array<{ windowId?: number }>>;
	open(options: { windowId: number }): Promise<void>;
}

export async function openSidePanelForCurrentWindow(dependencies: SidePanelDependencies): Promise<void> {
	const [tab] = await dependencies.queryTabs();
	if (!Number.isInteger(tab?.windowId)) {
		throw new Error('Could not resolve the current window.');
	}
	await dependencies.open({ windowId: tab.windowId as number });
}
```

The popup passes `queryTabs: () => chrome.tabs.query({ active: true, currentWindow: true })` and `open: (options) => chrome.sidePanel.open(options)`.

- [ ] **Step 4: Extract shared UI language and theme types/tokens**

Add `export type ThemeName = 'default' | 'winamp' | 'wmp12'` to `src/shared/types.ts`. Create `src/shared/i18n.ts`:

```ts
import { THEME_TRANSLATIONS } from './constants.ts';

export type UiLanguage = keyof typeof THEME_TRANSLATIONS;
export const uiLang: UiLanguage = chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en';
export const t = (key: keyof typeof THEME_TRANSLATIONS.en): string => THEME_TRANSLATIONS[uiLang][key];
```

Move only `:root`, `[data-theme="winamp"]`, and `[data-theme="wmp12"]` variable declarations from `popup.css` into `src/shared/theme.css`. Import `../shared/theme.css` before `./popup.css` in `popup/index.tsx`. Keep all popup layout and component selectors in `popup.css`.

- [ ] **Step 5: Add exact EN/VI translation keys and tests**

Add these keys to both languages in `THEME_TRANSLATIONS`:

```ts
openSidePanel: 'Mở Side Panel',
openSidePanelFailed: 'Không thể mở Side Panel. Vui lòng thử lại.',
```

```ts
openSidePanel: 'Open Side Panel',
openSidePanelFailed: 'Unable to open the Side Panel. Please try again.',
```

Add exact-value assertions for all four strings in `theme_i18n.test.ts`.

- [ ] **Step 6: Add the secondary popup action and localized failure state**

Import shared `ThemeName`, `uiLang`, `t`, and `openSidePanelForCurrentWindow`; remove the local type and translation helper. Add:

```ts
const handleOpenSidePanel = async () => {
	setCommandError('');
	try {
		await openSidePanelForCurrentWindow({
			queryTabs: () => chrome.tabs.query({ active: true, currentWindow: true }),
			open: (options) => chrome.sidePanel.open(options),
		});
	} catch {
		setCommandError(t('openSidePanelFailed'));
	}
};
```

Render this button inside `.controls-group` after the playback controls and before `.privacy-disclosure`:

```tsx
<button className="btn btn-secondary open-side-panel" type="button" onClick={handleOpenSidePanel}>
	<span aria-hidden="true">▱</span>
	{t('openSidePanel')}
</button>
```

Add a full-width CSS rule without changing existing transport sizes:

```css
.open-side-panel { align-self: stretch; justify-content: center; gap: var(--space-2); }
```

- [ ] **Step 7: Extend the popup runtime mock and add E2E assertions**

In `installPopupRuntimeMock()`, initialize `window.sidePanelOpenCalls = []`, override `chrome.tabs.query` to return `[{ windowId: 7 }]`, and override `chrome.sidePanel.open` to push its argument. Add to `tts-controls.spec.ts`:

```ts
test('opens the Side Panel from a labeled secondary action', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
	await openPopup(page);
	const button = page.getByRole('button', { name: 'Mở Side Panel' });
	await expect(button).toBeVisible();
	await expect(page.locator('.playback-controls + .open-side-panel')).toHaveCount(1);
	await button.click();
	expect(await page.evaluate(() => (window as any).sidePanelOpenCalls)).toEqual([{ windowId: 7 }]);
});
```

Add an English-locale assertion for `Open Side Panel` in the existing English popup test.

- [ ] **Step 8: Run focused verification**

Run:

```bash
node --experimental-strip-types --test tests/unit/side_panel.test.ts tests/unit/theme_i18n.test.ts
pnpm build
CI=true pnpm exec playwright test tests/e2e/tts-controls.spec.ts tests/e2e/themes.spec.ts
```

Expected: all commands PASS; existing theme tests remain unchanged apart from the new visible secondary action.

- [ ] **Step 9: Commit the popup entry point and shared tokens**

```bash
git add src/popup/side_panel.ts src/shared/i18n.ts src/shared/theme.css src/shared/types.ts src/shared/constants.ts src/popup/App.tsx src/popup/index.tsx src/popup/popup.css tests/unit/side_panel.test.ts tests/unit/theme_i18n.test.ts tests/e2e/fixtures.ts tests/e2e/tts-controls.spec.ts
git commit -m "feat: open Side Panel from popup"
```

---

### Task 6: Build the complete Side Panel UI and current-page metadata path

**Files:**
- Create: `src/background/page_info.ts`
- Create: `tests/unit/page_info.test.ts`
- Create: `src/shared/playback_client.ts`
- Create: `tests/unit/playback_client.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`
- Modify: `src/content/content_script.ts:7-33`
- Modify: `src/background/background.ts:1-10,340-390,519-589`
- Modify: `src/popup/App.tsx:156-232,234-310`
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/index.tsx`
- Modify: `src/sidepanel/sidepanel.css`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/side-panel.spec.ts`

**Interfaces:**
- Consumes: all previous task contracts plus `GET_CURRENT_PAGE_INFO`, `GET_PLAYBACK_STATE`, playback broadcasts, and stored Voice Style/speed/theme.
- Produces: `PageInfoResponse`, `requestPageInfoFromTab()`, shared playback runtime adapters, and the approved current-page/manual-text/player Side Panel.

- [ ] **Step 1: Write failing page-info request tests**

Create `tests/unit/page_info.test.ts` using the article-request dependency pattern:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { requestPageInfoFromTab } from '../../src/background/page_info.ts';

const info = { available: true as const, title: 'Article', url: 'https://example.com/a', lang: 'en' };

test('requests current-page metadata from the content script', async () => {
	assert.deepEqual(await requestPageInfoFromTab(42, {
		sendMessage: async (tabId, message) => {
			assert.equal(tabId, 42);
			assert.deepEqual(message, { action: 'GET_PAGE_INFO' });
			return info;
		},
		executeScript: async () => assert.fail('must not inject'),
	}), info);
});

test('injects content_script.js and retries once for a missing receiver', async () => {
	let attempts = 0;
	let injections = 0;
	assert.deepEqual(await requestPageInfoFromTab(42, {
		sendMessage: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('Receiving end does not exist');
			return info;
		},
		executeScript: async () => { injections += 1; },
	}), info);
	assert.equal(injections, 1);
});
```

- [ ] **Step 2: Write failing runtime-adapter tests**

Create `tests/unit/playback_client.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	requestPlaybackState,
	sendPlaybackCommand,
	sendRuntimeRequest,
	subscribePlaybackState,
	type RuntimeLike,
} from '../../src/shared/playback_client.ts';

function createRuntime(responses: unknown[]) {
	const sent: unknown[] = [];
	let listener: ((message: unknown) => void) | undefined;
	let removedListener: ((message: unknown) => void) | undefined;
	const runtime: RuntimeLike = {
		sendMessage(message, callback) {
			sent.push(message);
			callback(responses.shift());
		},
		onMessage: {
			addListener(value) { listener = value; },
			removeListener(value) { removedListener = value; },
		},
	};
	return { runtime, sent, getListener: () => listener, getRemovedListener: () => removedListener };
}

test('requests the current playback state', async () => {
	const fixture = createRuntime([{ session: null }]);
	assert.deepEqual(await requestPlaybackState(fixture.runtime), { session: null });
	assert.deepEqual(fixture.sent, [{ action: 'GET_PLAYBACK_STATE' }]);
});

test('returns command and generic request responses', async () => {
	const fixture = createRuntime([{ success: false, error: 'failed' }, { available: false }]);
	assert.deepEqual(await sendPlaybackCommand({ action: 'STOP_READING' }, fixture.runtime), { success: false, error: 'failed' });
	assert.deepEqual(await sendRuntimeRequest<{ available: false }>({ action: 'GET_CURRENT_PAGE_INFO' }, fixture.runtime), { available: false });
});

test('subscribes only to playback state updates and removes the same listener', () => {
	const fixture = createRuntime([]);
	const received: unknown[] = [];
	const unsubscribe = subscribePlaybackState(fixture.runtime, (session) => received.push(session));
	fixture.getListener()?.({ action: 'PLAYBACK_STATE_UPDATE', session: null });
	fixture.getListener()?.({ action: 'MODEL_LOADED' });
	assert.deepEqual(received, [null]);
	unsubscribe();
	assert.equal(fixture.getRemovedListener(), fixture.getListener());
});
```

- [ ] **Step 3: Run both new unit files and verify red state**

Run:

```bash
node --experimental-strip-types --test tests/unit/page_info.test.ts tests/unit/playback_client.test.ts
```

Expected: FAIL with both new modules missing.

- [ ] **Step 4: Implement page-info recovery and content-script response**

Add shared types:

```ts
export type PageInfoResponse =
	| { available: true; title: string; url: string; lang: string }
	| { available: false };
```

Create `src/background/page_info.ts`:

```ts
import type { PageInfoResponse } from '../shared/types.ts';

export interface PageInfoDependencies {
	sendMessage(tabId: number, message: { action: 'GET_PAGE_INFO' }): Promise<PageInfoResponse>;
	executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown>;
}

function isMissingReceiverError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('Could not establish connection') || message.includes('Receiving end does not exist');
}

export async function requestPageInfoFromTab(tabId: number, dependencies: PageInfoDependencies): Promise<PageInfoResponse> {
	try {
		return await dependencies.sendMessage(tabId, { action: 'GET_PAGE_INFO' });
	} catch (error) {
		if (!isMissingReceiverError(error)) throw error;
		try {
			await dependencies.executeScript({ target: { tabId }, files: ['content_script.js'] });
		} catch {
			throw error;
		}
		return dependencies.sendMessage(tabId, { action: 'GET_PAGE_INFO' });
	}
}
```

In `content_script.ts`, answer synchronously:

```ts
if (msg.action === 'GET_PAGE_INFO') {
	sendResponse({
		available: true,
		title: document.title,
		url: document.location.href,
		lang: document.documentElement.lang.trim().toLowerCase().replace('_', '-').split('-')[0] || 'na',
	});
	return true;
}
```

In `background.ts`, import `requestPageInfoFromTab` and `PageInfoResponse`, then add:

```ts
async function getCurrentPageInfo(): Promise<PageInfoResponse> {
	const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!activeTab || typeof activeTab.id !== 'number' || isRestrictedUrl(activeTab.url ?? '')) {
		return { available: false };
	}
	try {
		return await requestPageInfoFromTab(activeTab.id, {
			sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
	} catch {
		return { available: false };
	}
}
```

Route the read-only request through the same serialized message queue without changing playback:

```ts
case 'GET_CURRENT_PAGE_INFO':
	return respondFromQueue(getCurrentPageInfo, sendResponse);
```

- [ ] **Step 5: Implement the shared playback runtime adapter and adopt it in popup**

Create `src/shared/playback_client.ts`:

```ts
import type { CommandResponse, PlaybackSessionSnapshot, PlaybackStateResponse } from './types.ts';

type MessageListener = (message: unknown) => void;
export interface RuntimeLike {
	sendMessage(message: unknown, callback: (response: unknown) => void): unknown;
	onMessage: {
		addListener(listener: MessageListener): void;
		removeListener(listener: MessageListener): void;
	};
}

export function sendRuntimeRequest<T>(message: unknown, runtime: RuntimeLike = chrome.runtime): Promise<T> {
	return new Promise((resolve) => runtime.sendMessage(message, (response) => resolve(response as T)));
}

export function requestPlaybackState(runtime: RuntimeLike = chrome.runtime): Promise<PlaybackStateResponse> {
	return sendRuntimeRequest<PlaybackStateResponse | undefined>({ action: 'GET_PLAYBACK_STATE' }, runtime).then(
		(response) => response ?? { session: null },
	);
}

export function sendPlaybackCommand<T extends CommandResponse = CommandResponse>(
	message: unknown,
	runtime: RuntimeLike = chrome.runtime,
): Promise<T> {
	return sendRuntimeRequest<T | undefined>(message, runtime).then((response) => (response ?? { success: true }) as T);
}

export function subscribePlaybackState(
	runtime: RuntimeLike,
	listener: (session: PlaybackSessionSnapshot | null) => void,
): () => void {
	const messageListener: MessageListener = (message) => {
		if (!message || typeof message !== 'object') return;
		const value = message as { action?: string; session?: PlaybackSessionSnapshot | null };
		if (value.action === 'PLAYBACK_STATE_UPDATE') listener(value.session ?? null);
	};
	runtime.onMessage.addListener(messageListener);
	return () => runtime.onMessage.removeListener(messageListener);
}
```

Refactor popup hydration and playback commands to use these adapters; keep popup-only model-loading listeners in `App.tsx`.

- [ ] **Step 6: Add all Side Panel translation keys**

Add these exact entries and extend `theme_i18n.test.ts` with exact assertions for every key:

```ts
// vi
currentPage: 'Trang hiện tại',
orPasteText: 'Hoặc dán văn bản',
pasteTextPlaceholder: 'Dán hoặc nhập nội dung cần đọc',
readPastedText: 'Đọc văn bản đã dán',
clearText: 'Xóa',
characters: 'ký tự',
manualLanguage: 'Ngôn ngữ văn bản',
languageAuto: 'Tự động',
languageEnglish: 'English',
languageVietnamese: 'Tiếng Việt',
languageChinese: '中文',
textProcessedLocally: 'Nội dung chỉ được xử lý trên thiết bị.',
currentPageUnavailable: 'Không thể đọc trang hiện tại',
invalidManualText: 'Hãy nhập văn bản cần đọc.',

// en
currentPage: 'Current page',
orPasteText: 'Or paste text',
pasteTextPlaceholder: 'Paste or type text to read',
readPastedText: 'Read pasted text',
clearText: 'Clear',
characters: 'characters',
manualLanguage: 'Text language',
languageAuto: 'Auto',
languageEnglish: 'English',
languageVietnamese: 'Vietnamese',
languageChinese: 'Chinese',
textProcessedLocally: 'Text is processed only on this device.',
currentPageUnavailable: 'Current page unavailable',
invalidManualText: 'Enter text to read.',
```

- [ ] **Step 7: Write Side Panel E2E behavior before implementing the full component**

Expand `installPopupRuntimeMock()` into `installExtensionUiRuntimeMock()` (keep an exported alias named `installPopupRuntimeMock` for existing tests). It must return mocked responses for `GET_PLAYBACK_STATE` and `GET_CURRENT_PAGE_INFO`, record all other messages, and use real `chrome.storage.local` for theme/voice/speed.

Add tests in `side-panel.spec.ts` that assert:

```ts
const currentPageButton = page.getByRole('button', { name: 'Đọc trang hiện tại' });
const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
const currentPageBox = await currentPageButton.boundingBox();
const textboxBox = await textbox.boundingBox();
expect(currentPageBox?.y).toBeLessThan(textboxBox?.y ?? 0);
await expect(page.getByRole('combobox', { name: 'Ngôn ngữ văn bản' })).toHaveValue('auto');
await expect(page.getByRole('button', { name: 'Đọc văn bản đã dán' })).toBeDisabled();
await textbox.fill('Xin chào\n\nĐây là đoạn thứ hai.');
await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({
	action: 'START_MANUAL_TEXT',
	payload: { text: 'Xin chào\n\nĐây là đoạn thứ hai.', language: 'auto' },
});
await expect(textbox).toHaveValue('Xin chào\n\nĐây là đoạn thứ hai.');
```

Also assert Clear empties the draft without sending `STOP_READING`, reload discards the draft, a manual session renders localized `Văn bản đã dán`, current-page click sends `START_CURRENT_PAGE`, and pause/resume/stop controls send the existing coordinator actions.

- [ ] **Step 8: Implement the complete Side Panel component**

In `src/sidepanel/App.tsx`, import the shared constants, types, i18n helper, and playback client, then define document-local state and hydration exactly once:

```tsx
import { useEffect, useState, type ChangeEvent } from 'react';
import { STORAGE_KEYS, VOICE_STYLES, VOICE_STYLE_TRANSLATIONS } from '../shared/constants.ts';
import { t, uiLang } from '../shared/i18n.ts';
import {
	requestPlaybackState,
	sendPlaybackCommand,
	sendRuntimeRequest,
	subscribePlaybackState,
} from '../shared/playback_client.ts';
import type { ManualTextLanguage, PageInfoResponse, PlaybackSessionSnapshot, ThemeName } from '../shared/types.ts';

const EMPTY_PAGE_INFO: PageInfoResponse = { available: false };

function getHost(url: string): string {
	try { return new URL(url).host; } catch { return ''; }
}

function getStatusText(session: PlaybackSessionSnapshot | null): string {
	if (!session) return t('readyStatus');
	if (session.status === 'loading') return t('preparingState');
	if (session.status === 'playing') return `${t('playingStatus')} ${session.currentParagraphIndex + 1}/${session.totalParagraphs}`;
	if (session.status === 'paused') return t('pauseState');
	if (session.status === 'error') return t('errorState');
	return t('readyStatus');
}

export default function App() {
	const [draft, setDraft] = useState('');
	const [language, setLanguage] = useState<ManualTextLanguage>('auto');
	const [commandError, setCommandError] = useState('');
	const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
	const [activeVoice, setActiveVoice] = useState('M1');
	const [speed, setSpeed] = useState(1);
	const [theme, setTheme] = useState<ThemeName>('default');
	const [pageInfo, setPageInfo] = useState<PageInfoResponse>(EMPTY_PAGE_INFO);

	useEffect(() => {
		chrome.storage.local.get([STORAGE_KEYS.ACTIVE_VOICE, STORAGE_KEYS.SPEED, STORAGE_KEYS.THEME], (result) => {
			if (typeof result[STORAGE_KEYS.ACTIVE_VOICE] === 'string') setActiveVoice(result[STORAGE_KEYS.ACTIVE_VOICE]);
			if (typeof result[STORAGE_KEYS.SPEED] === 'number') setSpeed(result[STORAGE_KEYS.SPEED]);
			if (result[STORAGE_KEYS.THEME] === 'default' || result[STORAGE_KEYS.THEME] === 'winamp' || result[STORAGE_KEYS.THEME] === 'wmp12') {
				setTheme(result[STORAGE_KEYS.THEME]);
			}
		});
		void requestPlaybackState().then((response) => setSession(response.session));
		void sendRuntimeRequest<PageInfoResponse>({ action: 'GET_CURRENT_PAGE_INFO' }).then(setPageInfo);
		const unsubscribePlayback = subscribePlaybackState(chrome.runtime, setSession);
		const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
			if (areaName !== 'local') return;
			const nextTheme = changes[STORAGE_KEYS.THEME]?.newValue;
			if (nextTheme === 'default' || nextTheme === 'winamp' || nextTheme === 'wmp12') setTheme(nextTheme);
		};
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			unsubscribePlayback();
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, []);
```

This state has no draft storage key: neither the effect nor any handler may read or write `draft` through a Chrome storage API.

Define these handlers before rendering:

```tsx
const handleReadCurrentPage = async () => {
	setCommandError('');
	const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE' });
	if (!response.success) setCommandError(response.error ?? t('startReadingFailed'));
};

const handleReadManualText = async () => {
	if (!draft.trim()) return;
	setCommandError('');
	const response = await sendPlaybackCommand({ action: 'START_MANUAL_TEXT', payload: { text: draft, language } });
	if (!response.success) setCommandError(response.error === 'invalidManualText' ? t('invalidManualText') : t('startReadingFailed'));
};

const handlePlaybackCommand = (action: 'PAUSE_READING' | 'RESUME_READING' | 'STOP_READING') => {
	void sendPlaybackCommand({ action });
};

const handleVoiceChange = (event: ChangeEvent<HTMLSelectElement>) => {
	setActiveVoice(event.target.value);
	void chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_VOICE]: event.target.value });
};

const handleSpeedChange = (event: ChangeEvent<HTMLInputElement>) => {
	const nextSpeed = Number(event.target.value);
	setSpeed(nextSpeed);
	void chrome.storage.local.set({ [STORAGE_KEYS.SPEED]: nextSpeed });
	void sendPlaybackCommand({ action: 'CHANGE_SPEED', payload: { speed: nextSpeed } });
};
```

Render this stable structure without adding a second coordinator or draft persistence:

```tsx
<main className="side-panel" data-theme={theme} aria-label="readit.dev Side Panel">
	<header className="side-panel-header">
		<h1>readit<span>.dev</span></h1>
		<span>v{chrome.runtime.getManifest().version}</span>
	</header>
	{commandError && <div className="alert alert-danger">{commandError}</div>}
	<section className="current-page-card" aria-labelledby="current-page-title">
		<h2 id="current-page-title">{t('currentPage')}</h2>
		{pageInfo.available ? (
			<div className="page-info"><strong>{pageInfo.title}</strong><span>{getHost(pageInfo.url)} · {pageInfo.lang}</span></div>
		) : <p>{t('currentPageUnavailable')}</p>}
		<button type="button" onClick={handleReadCurrentPage}>{t('readPage')}</button>
	</section>
	<div className="paste-divider">{t('orPasteText')}</div>
	<section className="manual-text-card" aria-labelledby="manual-text-title">
		<h2 id="manual-text-title">{t('orPasteText')}</h2>
		<textarea aria-label={t('pasteTextPlaceholder')} placeholder={t('pasteTextPlaceholder')} value={draft} onChange={(event) => setDraft(event.target.value)} />
		<div className="manual-meta"><span>{t('textProcessedLocally')}</span><span>{draft.length} {t('characters')}</span></div>
		<label>{t('manualLanguage')}<select value={language} onChange={(event) => setLanguage(event.target.value as ManualTextLanguage)}>
			<option value="auto">{t('languageAuto')}</option><option value="en">{t('languageEnglish')}</option>
			<option value="vi">{t('languageVietnamese')}</option><option value="zh">{t('languageChinese')}</option>
		</select></label>
		<div className="manual-actions"><button type="button" onClick={() => setDraft('')}>{t('clearText')}</button><button type="button" disabled={!draft.trim()} onClick={handleReadManualText}>{t('readPastedText')}</button></div>
	</section>
	<section className="side-panel-player" aria-label={t('nowPlaying')}>
		<div className="status-display" data-status={session?.status ?? 'stopped'} role="status">{getStatusText(session)}</div>
		{session && <div className="session-title">{session.source.kind === 'manual' ? t('pastedText') : session.source.title}</div>}
		<div className="player-controls">
			{session?.status === 'playing' && <button type="button" aria-label={t('pauseState')} onClick={() => handlePlaybackCommand('PAUSE_READING')}>Ⅱ</button>}
			{session?.status === 'paused' && <button type="button" aria-label={t('resumeStatus')} onClick={() => handlePlaybackCommand('RESUME_READING')}>▶</button>}
			{session && <button type="button" aria-label={t('stopReading')} onClick={() => handlePlaybackCommand('STOP_READING')}>■</button>}
		</div>
		<label>{t('selectVoice')}<select value={activeVoice} disabled={session?.status === 'playing' || session?.status === 'loading'} onChange={handleVoiceChange}>{VOICE_STYLES.map((voice) => <option key={voice.id} value={voice.id}>{VOICE_STYLE_TRANSLATIONS[uiLang][voice.id as keyof typeof VOICE_STYLE_TRANSLATIONS.en]}</option>)}</select></label>
		<label>{t('readingSpeed')}<input type="range" min="0.7" max="1.8" step="0.05" value={speed} onChange={handleSpeedChange} /></label>
	</section>
</main>
}
```

Map response error key `invalidManualText` to `t('invalidManualText')`. Keep the draft after successful starts. For manual sessions derive the localized title from `contentScope`; do not expect tab metadata. Persist Voice Style and speed using existing storage keys, and send `CHANGE_SPEED` exactly as popup does.

- [ ] **Step 9: Implement Side Panel layout and shared theme behavior**

Import `../shared/theme.css` before `sidepanel.css`. Implement a flexible column with `min-height: 100vh`, scrollable content, and `.side-panel-player { position: sticky; bottom: 0; }`. Use theme variables for text, background, borders, buttons, and inputs. Add only surface-specific selectors for Winamp square borders/fonts and WMP12 blue/dark controls; do not copy popup geometry, fake titlebars, or artwork.

Add E2E theme checks that seed `readit_active_theme` with `default`, `winamp`, and `wmp12`, reload the Side Panel, and assert `data-theme`, readable input, visible focus, and unchanged section order for each.

- [ ] **Step 10: Run the complete focused UI verification**

Run:

```bash
node --experimental-strip-types --test tests/unit/page_info.test.ts tests/unit/playback_client.test.ts tests/unit/theme_i18n.test.ts
pnpm build
CI=true pnpm exec playwright test tests/e2e/side-panel.spec.ts tests/e2e/tts-controls.spec.ts tests/e2e/themes.spec.ts
```

Expected: all commands PASS; Side Panel tests cover draft privacy, command payloads, hydration, themes, order, and accessibility.

- [ ] **Step 11: Commit the complete Side Panel UI**

```bash
git add src/background/page_info.ts src/shared/playback_client.ts src/shared/types.ts src/shared/constants.ts src/content/content_script.ts src/background/background.ts src/popup/App.tsx src/sidepanel tests/unit/page_info.test.ts tests/unit/playback_client.test.ts tests/unit/theme_i18n.test.ts tests/e2e/fixtures.ts tests/e2e/side-panel.spec.ts
git commit -m "feat: add Side Panel reading workspace"
```

---

### Task 7: Integration regressions, documentation, and release verification

**Files:**
- Modify: `tests/e2e/reading-state.spec.ts`
- Modify: `tests/e2e/free-tier.spec.ts`
- Modify: `README.md:10-27`
- Modify: `docs/PRD.md:5-40`
- Modify: `docs/privacy-policy.md:9-63`
- Modify: `docs/RELEASING.md:10-26,45-79`
- Modify: `docs/specs/2026-07-19-side-panel-manual-text-design.md:5`

**Interfaces:**
- Consumes: the complete feature from Tasks 1-6.
- Produces: regression proof for cross-surface state, restricted-page manual use, exact Free release boundary, and shipping documentation.

- [ ] **Step 1: Add final real-extension regression scenarios**

In `reading-state.spec.ts`, add a test that opens both the popup page and Side Panel page, starts manual playback from the Side Panel, sends a `PLAYBACK_PROGRESS_UPDATE` through the real background, and asserts both surfaces plus `chrome.action.getBadgeText({})` show the same playing/paused/stopped transitions.

The key assertions are:

```ts
await expect(sidePanel.locator('.status-display')).toHaveAttribute('data-status', 'playing');
await expect(popup.locator('.status-display')).toHaveAttribute('data-status', 'playing');
await expect.poll(() => getBadgeText(controlPage)).toBe('▶');
await expect(sidePanel.locator('.session-title')).toHaveText('Văn bản đã dán');
await expect(popup.locator('.session-title')).toHaveText('Văn bản đã dán');
```

Add a restricted-page test that opens `chrome://extensions/`, verifies current-page reading returns the restricted-page error, then starts manual text successfully and observes a manual loading snapshot.

In the manual cross-surface test, keep an HTTP article tab open, send a manual `WORD_HIGHLIGHT_UPDATE` progress event through the background, and prove the page never receives a highlight:

```ts
await expect.poll(() => articlePage.evaluate(() => CSS.highlights?.has('readit-dev-word-highlight') ?? false)).toBe(false);
```

- [ ] **Step 2: Extend the Free boundary E2E assertions**

In `free-tier.spec.ts`, assert Side Panel has no tier badge, license UI, backend request, or persisted draft key. Inspect `chrome.storage.local` and `chrome.storage.session`; only approved settings and the metadata-only playback snapshot may exist. Assert sent messages never contain `CHECK_LICENSE` or `ACTIVATE_LICENSE`.

- [ ] **Step 3: Run targeted integration tests before changing docs**

Run:

```bash
pnpm build
pnpm validate:manifest
CI=true pnpm exec playwright test tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts tests/e2e/free-tier.spec.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 4: Align README and product requirements with shipping behavior**

Update the README Mermaid flow so `Popup` opens `Side Panel`, both current-page and pasted-text inputs reach the background, only current-page/selection inputs reach the content script, and session state broadcasts to popup, Side Panel, and badge. State explicitly that pasted text remains local and is not persisted.

In `docs/PRD.md`, add Free requirements for the optional Side Panel, manual Auto/EN/VI/ZH selection, tab-independent manual sessions, and non-persistence of pasted text. Keep backend/Pro items explicitly future.

- [ ] **Step 5: Align privacy and release documentation**

Change the privacy-policy date to July 19, 2026 and state:

- users may explicitly paste text into the Side Panel;
- pasted text is passed only between extension contexts and is not persisted;
- manual snapshots contain playback metadata and resolved language but no page URL, tab ID, text-derived title, or pasted content;
- closing the Side Panel discards its draft; and
- article and pasted text are never sent to the backend, telemetry, or crash reporting.

In `docs/RELEASING.md`, add `sidePanel` to the exact permission list and `src/sidepanel/sidepanel.html` to manifest validation requirements. Add a release checklist item that verifies the built Side Panel page exists and the store disclosure covers user-pasted local text.

- [ ] **Step 6: Mark the feature design implemented only after verification**

Change the design status line to:

```markdown
**Status:** Implemented and verified
```

Do not change the already approved decisions or scope.

- [ ] **Step 7: Run the full release-proportional verification chain**

Run in this order:

```bash
pnpm test:unit
pnpm build
pnpm validate:manifest
pnpm validate:vi-assets:release
CI=true pnpm test:e2e
git diff --check
```

Expected: every command exits `0`; Playwright reports no skipped or focused Side Panel tests; `git diff --check` prints nothing.

- [ ] **Step 8: Review the final diff for scope and privacy**

Run:

```bash
git status --short
git diff --stat
git diff -- public/manifest.json scripts/validate-free-manifest.mjs src/background src/shared src/popup src/sidepanel tests docs README.md
```

Confirm there is no `tabs` permission, remote Side Panel URL, draft storage key, manual content in session snapshots, second offscreen coordinator, or unrelated formatting churn.

- [ ] **Step 9: Commit integration evidence and docs**

```bash
git add tests/e2e/reading-state.spec.ts tests/e2e/free-tier.spec.ts README.md docs/PRD.md docs/privacy-policy.md docs/RELEASING.md docs/specs/2026-07-19-side-panel-manual-text-design.md
git commit -m "docs: finalize Side Panel release behavior"
```

---

## Final acceptance checklist

- [ ] Popup keeps all existing controls/themes and opens Side Panel through a labeled secondary action.
- [ ] Side Panel order is current page, pasted text, bottom player.
- [ ] Manual language defaults to Auto and supports explicit EN/VI/ZH.
- [ ] Empty or invalid manual input never replaces active playback.
- [ ] Valid manual input replaces playback through the existing serialized coordinator.
- [ ] Manual sessions survive active-tab switches, navigation, reload, and closure.
- [ ] Manual drafts disappear on Side Panel reload/close but active audio continues.
- [ ] Popup, Side Panel, session snapshot, and toolbar badge remain synchronized.
- [ ] Manual snapshots contain no pasted text, source URL, tab ID, or text-derived title.
- [ ] Manual playback sends no word-highlight messages to a webpage.
- [ ] Manifest contains exactly the approved Free permissions plus `sidePanel` and the local Side Panel path.
- [ ] EN/VI labels, keyboard focus, accessible names, all three themes, restricted pages, and failure states are covered.
- [ ] Unit, build, manifest, Vietnamese asset, full Playwright, and whitespace checks pass.
