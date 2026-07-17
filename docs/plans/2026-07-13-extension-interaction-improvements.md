# Extension Interaction Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (only with explicit delegation approval) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete selected-text reading, deterministic toolbar badges, accessible icon-only controls, and a privacy-safe Feedback/version footer with unit, E2E, and release verification.

**Architecture:** Keep `background.ts` as the single playback coordinator, but move selected-text shaping and badge mapping into focused testable modules. Keep popup rendering in `App.tsx`, with a pure Feedback URL helper and local inline-SVG icons. Both full-page and selected-text inputs converge on one background playback-start function after producing a valid `Article`.

**Tech Stack:** TypeScript 6, React 19, Chrome Manifest V3 APIs, Node test runner, Playwright, Rsbuild, GitHub Actions.

## Global Constraints

- Preserve the Free MVP local-only boundary: no backend/API calls, telemetry, crash reporting, or durable article/audio storage.
- Context-menu reading is available only for text selections on `http://*/*` and `https://*/*` documents.
- Do not add an icon library or any other runtime dependency.
- The footer version copy is exactly `v<manifest version>`, for example `v1.0.0`.
- Feedback may include extension version and neutral prompts, but never page URL, page title, selected text, article content, or browsing history.
- Read, Stop, Pause, and Resume are icon-only buttons with inline SVG, explicit `aria-label`, matching `title`, visible focus, and a 52-by-52-pixel target.
- Stop remains enabled during `loading`.
- Badge mapping is exactly: `loading -> …/yellow`, `playing -> ▶/green`, `paused -> Ⅱ/yellow`, `error -> !/red`, `stopped/null -> empty`.
- Preserve unrelated worktree content, especially `context_improvement.md`; stage and commit only files named by each task.
- Store any temporary test data under repository `.tmp/`; never use the operating-system temp directory.

---

## File Structure

- Create `src/background/selected_text.ts`: pure page-language normalization and selected-text `Article` construction.
- Create `src/background/badge.ts`: pure badge-state mapping and awaited Chrome action synchronization.
- Modify `src/background/background.ts`: shared article playback start, context-menu orchestration, badge integration, and hydration sync.
- Modify `public/manifest.json`: retain `contextMenus` as the only new permission.
- Create `src/popup/feedback.ts`: privacy-safe GitHub Feedback URL construction.
- Modify `src/popup/App.tsx`: inline SVG controls, accessible names, one Feedback link, and exact version display.
- Modify `src/popup/popup.css`: circular icon controls, SVG/focus styling, and compact footer/version styling.
- Create `tests/unit/selected_text.test.ts`: selected-text validation and language cases.
- Create `tests/unit/badge.test.ts`: badge mapping and asynchronous application order.
- Create `tests/unit/feedback.test.ts`: version inclusion and page-data exclusion.
- Modify `tests/e2e/tts-controls.spec.ts`: accessible icon-control behavior and loading cancellation.
- Modify `tests/e2e/support.spec.ts`: unambiguous footer links, exact version, and safe Feedback URL.
- Modify `tests/e2e/reading-state.spec.ts`: real toolbar badge lifecycle and hydration coverage.
- Create `scripts/validate-free-manifest.mjs`: built-manifest permission and host-boundary validation.
- Create `tests/unit/manifest_validation.test.ts`: validator acceptance/rejection cases.
- Modify `package.json`: expose the built-manifest validator command.
- Modify `.github/workflows/release-extension.yml`: run manifest validation after the production build.
- Modify `_docs/RELEASING.md`: document the manifest assertion and correct the local spec link.
- Modify `_docs/specs/2026-07-13-extension-interaction-improvements.md`: mark implemented after verification.
- Modify `_docs/specs/2026-07-12-free-mvp-design.md`: remove completed interaction items from the implementation delta while retaining product requirements.

---

### Task 1: Selected-text contract and shared playback pipeline

**Files:**
- Create: `src/background/selected_text.ts`
- Modify: `src/background/background.ts`
- Modify: `public/manifest.json`
- Test: `tests/unit/selected_text.test.ts`

**Interfaces:**
- Produces: `normalizePageLanguage(value: unknown): string`.
- Produces: `createSelectedTextArticle(input: SelectedTextInput): Article | null`.
- Produces inside `background.ts`: `startArticlePlayback(tabId: number, fallbackTitle: string, fallbackUrl: string, article: Article): Promise<CommandResponse>`.
- Consumes: existing `Article`, `createPlaybackSession`, `stopActiveSession`, offscreen lifecycle, and local voice/speed preferences.

- [ ] **Step 1: Write failing selected-text unit tests**

Create `tests/unit/selected_text.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectedTextArticle, normalizePageLanguage } from '../../src/background/selected_text.ts';

test('normalizes regional page languages and falls back when missing', () => {
	assert.equal(normalizePageLanguage('vi-VN'), 'vi');
	assert.equal(normalizePageLanguage(' EN_us '), 'en');
	assert.equal(normalizePageLanguage(''), 'na');
	assert.equal(normalizePageLanguage(undefined), 'na');
});

test('creates an Article from trimmed selected text and tab metadata', () => {
	assert.deepEqual(
		createSelectedTextArticle({
			selectionText: '  Nội dung đã chọn  ',
			title: 'Bài viết',
			url: 'https://example.com/article',
			pageLanguage: 'vi-VN',
		}),
		{
			title: 'Bài viết',
			content: 'Nội dung đã chọn',
			url: 'https://example.com/article',
			lang: 'vi',
		},
	);
});

test('uses the URL as title fallback and rejects whitespace-only text', () => {
	assert.deepEqual(
		createSelectedTextArticle({
			selectionText: 'Readable selection',
			title: '',
			url: 'https://example.com/article',
			pageLanguage: null,
		}),
		{
			title: 'https://example.com/article',
			content: 'Readable selection',
			url: 'https://example.com/article',
			lang: 'na',
		},
	);
	assert.equal(
		createSelectedTextArticle({ selectionText: ' \n\t ', title: 'Keep playing', url: 'https://example.com', pageLanguage: 'en' }),
		null,
	);
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/selected_text.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/background/selected_text.ts`.

- [ ] **Step 3: Implement the minimal selected-text module**

Create `src/background/selected_text.ts`:

```ts
import type { Article } from '../shared/types';

export interface SelectedTextInput {
	selectionText: unknown;
	title: string;
	url: string;
	pageLanguage: unknown;
}

export function normalizePageLanguage(value: unknown): string {
	if (typeof value !== 'string') {
		return 'na';
	}

	const normalized = value.trim().toLowerCase().replace('_', '-').split('-')[0];
	return normalized || 'na';
}

export function createSelectedTextArticle(input: SelectedTextInput): Article | null {
	if (typeof input.selectionText !== 'string') {
		return null;
	}

	const content = input.selectionText.trim();
	if (!content) {
		return null;
	}

	return {
		title: input.title || input.url,
		content,
		url: input.url,
		lang: normalizePageLanguage(input.pageLanguage),
	};
}
```

- [ ] **Step 4: Run the selected-text tests and verify GREEN**

Run the Step 2 command.

Expected: 3 tests PASS.

- [ ] **Step 5: Refactor background playback into one shared start function**

In `src/background/background.ts`:

1. Import `createSelectedTextArticle`.
2. Extract the code that loads voice/speed, creates a session, publishes it,
   sets up offscreen playback, and handles setup failure into:

```ts
async function startArticlePlayback(
	tabId: number,
	fallbackTitle: string,
	fallbackUrl: string,
	article: Article,
): Promise<CommandResponse> {
	await stopActiveSession('session-replaced');

	const preferences = (await chrome.storage.local.get([
		STORAGE_KEYS.ACTIVE_VOICE,
		STORAGE_KEYS.SPEED,
	])) as Record<string, unknown>;
	const storedVoiceStyleId = preferences[STORAGE_KEYS.ACTIVE_VOICE];
	const storedSpeed = preferences[STORAGE_KEYS.SPEED];
	const voiceStyleId = typeof storedVoiceStyleId === 'string' ? storedVoiceStyleId : DEFAULT_VOICE_STYLE_ID;
	const speed = isFiniteNumber(storedSpeed) ? storedSpeed : DEFAULT_SPEED;
	const session = createPlaybackSession({
		sessionId: crypto.randomUUID(),
		tabId,
		title: article.title || fallbackTitle || fallbackUrl,
		url: article.url || fallbackUrl,
		lang: article.lang,
		voiceStyleId,
		speed,
		now: Date.now(),
	});

	activeSession = session;
	await publishSession(session);

	try {
		await setupOffscreen();
		observeOffscreenPlay(session.sessionId, {
			action: 'PLAY',
			payload: { sessionId: session.sessionId, article, voiceStyleId, speed },
		});
		return { success: true };
	} catch (_error) {
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreen();
		return { success: false, error: ERROR_MESSAGES.setup };
	}
}
```

Replace the duplicate successful-start block in `startCurrentPage()` with:

```ts
return startArticlePlayback(activeTab.id, activeTab.title || url, url, articleResponse.article);
```

Remove the old unconditional `await stopActiveSession('session-replaced')`
that runs before extraction. In both extraction-failure branches, stop the
prior session immediately before publishing the extraction error:

```ts
await stopActiveSession('session-replaced');
await publishExtractionFailure(activeTab.id, activeTab.title, url);
return { success: false, error: ERROR_MESSAGES.extraction };
```

This makes each path stop exactly once: failures stop before publishing the
error, while successful full-page and selected-text starts stop inside
`startArticlePlayback()`. Offscreen audio therefore cannot become orphaned.

- [ ] **Step 6: Wire the context menu to page language and the shared pipeline**

Replace `startSelectedText()` with a function that receives the `Article` and
delegates to `startArticlePlayback`. In the click listener:

```ts
chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId !== 'read-selected-text' || typeof tab?.id !== 'number') {
		return;
	}

	void enqueue(async () => {
		const [{ result: pageLanguage } = { result: undefined }] = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: () => document.documentElement.lang,
		}).catch(() => []);
		const url = info.pageUrl || tab.url || '';
		const article = createSelectedTextArticle({
			selectionText: info.selectionText,
			title: tab.title || url,
			url,
			pageLanguage,
		});
		if (!article) {
			return { success: true };
		}
		return startArticlePlayback(tab.id, tab.title || url, url, article);
	});
});
```

Register the menu with:

```ts
chrome.contextMenus.create({
	id: 'read-selected-text',
	title: 'Đọc phần văn bản đã chọn',
	contexts: ['selection'],
	documentUrlPatterns: ['http://*/*', 'https://*/*'],
});
```

Keep `contextMenus` in `public/manifest.json`; add no other permission.

- [ ] **Step 7: Run unit tests and build**

Run:

```bash
pnpm test:unit
pnpm build
```

Expected: all unit tests PASS; TypeScript and Rsbuild complete successfully.

- [ ] **Step 8: Commit Task 1 only**

```bash
git add public/manifest.json src/background/background.ts src/background/selected_text.ts tests/unit/selected_text.test.ts
git commit -m "Add selected text playback pipeline"
```

Do not stage `context_improvement.md` or popup/badge files.

---

### Task 2: Deterministic toolbar badge

**Files:**
- Create: `src/background/badge.ts`
- Modify: `src/background/background.ts`
- Test: `tests/unit/badge.test.ts`
- Test: `tests/e2e/reading-state.spec.ts`

**Interfaces:**
- Produces: `getBadgeAppearance(status: PlaybackStatus | null): BadgeAppearance`.
- Produces: `syncPlaybackBadge(status: PlaybackStatus | null, action: BadgeAction): Promise<void>`.
- Consumes: the background coordinator's serialized publish/hydration flow.

- [ ] **Step 1: Write failing badge unit tests**

Create `tests/unit/badge.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { getBadgeAppearance, syncPlaybackBadge } from '../../src/background/badge.ts';

test('maps every playback state to the specified badge', () => {
	assert.deepEqual(getBadgeAppearance('loading'), { text: '…', color: '#f59e0b' });
	assert.deepEqual(getBadgeAppearance('playing'), { text: '▶', color: '#10b981' });
	assert.deepEqual(getBadgeAppearance('paused'), { text: 'Ⅱ', color: '#f59e0b' });
	assert.deepEqual(getBadgeAppearance('error'), { text: '!', color: '#ef4444' });
	assert.deepEqual(getBadgeAppearance('stopped'), { text: '' });
	assert.deepEqual(getBadgeAppearance(null), { text: '' });
});

test('awaits background color before showing badge text', async () => {
	const calls: string[] = [];
	await syncPlaybackBadge('playing', {
		setBadgeBackgroundColor: async ({ color }) => {
			calls.push(`color:${color}`);
		},
		setBadgeText: async ({ text }) => {
			calls.push(`text:${text}`);
		},
	});
	assert.deepEqual(calls, ['color:#10b981', 'text:▶']);
});

test('clears text without applying a color', async () => {
	const calls: string[] = [];
	await syncPlaybackBadge(null, {
		setBadgeBackgroundColor: async () => {
			calls.push('color');
		},
		setBadgeText: async ({ text }) => {
			calls.push(`text:${text}`);
		},
	});
	assert.deepEqual(calls, ['text:']);
});
```

- [ ] **Step 2: Run the badge tests and verify RED**

```bash
node --experimental-strip-types --test tests/unit/badge.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/background/badge.ts`.

- [ ] **Step 3: Write and run a failing real-extension badge lifecycle E2E test**

In `tests/e2e/reading-state.spec.ts`, add:

```ts
async function getBadgeText(page: Page): Promise<string> {
	return page.evaluate(() => chrome.action.getBadgeText({}));
}

test('toolbar badge follows hydrated playback state and clears on stop', async ({ context, extensionId }) => {
	const targetPage = await createTargetPage(context);
	const { controlPage, session } = await seedCoordinatorSession(context, extensionId, targetPage, {
		status: 'loading',
	});
	await expect.poll(() => getBadgeText(controlPage)).toBe('…');

	await sendBackgroundMessage(controlPage, {
		action: 'PLAYBACK_PROGRESS_UPDATE',
		sessionId: session.sessionId,
		progress: { status: 'playing', currentParagraphIndex: 0, totalParagraphs: 8, progressPercentage: 10 },
	});
	await expect.poll(() => getBadgeText(controlPage)).toBe('▶');

	await sendBackgroundMessage(controlPage, {
		action: 'PLAYBACK_PROGRESS_UPDATE',
		sessionId: session.sessionId,
		progress: { status: 'paused', currentParagraphIndex: 0, totalParagraphs: 8, progressPercentage: 10 },
	});
	await expect.poll(() => getBadgeText(controlPage)).toBe('Ⅱ');

	await sendBackgroundMessage(controlPage, {
		action: 'PLAYBACK_PROGRESS_UPDATE',
		sessionId: session.sessionId,
		progress: { status: 'error', currentParagraphIndex: 0, totalParagraphs: 8, progressPercentage: 10, error: 'Expected test error' },
	});
	await expect.poll(() => getBadgeText(controlPage)).toBe('!');

	await sendBackgroundMessage(controlPage, { action: 'STOP_READING' });
	await expect.poll(() => getBadgeText(controlPage)).toBe('');
});
```

Run:

```bash
pnpm build
pnpm test:e2e -- tests/e2e/reading-state.spec.ts
```

Expected: FAIL against the partial implementation because loading uses `...`
and paused uses `⏸` instead of the approved badge glyphs.

- [ ] **Step 4: Implement badge mapping and awaited application**

Create `src/background/badge.ts`:

```ts
import type { PlaybackStatus } from '../shared/types';

export interface BadgeAppearance {
	text: string;
	color?: string;
}

export interface BadgeAction {
	setBadgeBackgroundColor(details: { color: string }): Promise<void>;
	setBadgeText(details: { text: string }): Promise<void>;
}

export function getBadgeAppearance(status: PlaybackStatus | null): BadgeAppearance {
	switch (status) {
		case 'loading':
			return { text: '…', color: '#f59e0b' };
		case 'playing':
			return { text: '▶', color: '#10b981' };
		case 'paused':
			return { text: 'Ⅱ', color: '#f59e0b' };
		case 'error':
			return { text: '!', color: '#ef4444' };
		default:
			return { text: '' };
	}
}

export async function syncPlaybackBadge(status: PlaybackStatus | null, action: BadgeAction): Promise<void> {
	const appearance = getBadgeAppearance(status);
	if (appearance.color) {
		await action.setBadgeBackgroundColor({ color: appearance.color });
	}
	await action.setBadgeText({ text: appearance.text });
}
```

- [ ] **Step 5: Integrate badge sync without blocking state broadcasts**

In `src/background/background.ts`, delete the inline `updateBadge()` function,
import `syncPlaybackBadge`, and add:

```ts
async function updateBadge(session: PlaybackSessionSnapshot | null): Promise<void> {
	try {
		await syncPlaybackBadge(session?.status ?? null, chrome.action);
	} catch (_error) {
		// Badge rendering must not corrupt playback state or suppress popup updates.
	}
}
```

Then await it before the runtime broadcast:

```ts
async function broadcastSession(session: PlaybackSessionSnapshot | null): Promise<void> {
	await updateBadge(session);
	try {
		await chrome.runtime.sendMessage({ action: 'PLAYBACK_STATE_UPDATE', session });
	} catch (_error) {
		// The popup may be closed, so there may be no receiver for this broadcast.
	}
}
```

At the end of `ensureHydrated()`, call `await updateBadge(activeSession)` after
invalid storage cleanup so a restarted worker restores or clears the badge.

- [ ] **Step 6: Run badge unit tests and the full unit suite**

```bash
node --experimental-strip-types --test tests/unit/badge.test.ts
pnpm test:unit
```

Expected: badge tests PASS; full unit suite PASS.

- [ ] **Step 7: Run targeted badge E2E and build**

```bash
pnpm build
pnpm test:e2e -- tests/e2e/reading-state.spec.ts
```

Expected: reading-state suite PASS, including the new badge lifecycle test.

- [ ] **Step 8: Commit Task 2 only**

```bash
git add src/background/badge.ts src/background/background.ts tests/unit/badge.test.ts tests/e2e/reading-state.spec.ts
git commit -m "Synchronize playback toolbar badge"
```

---

### Task 3: Accessible icon controls and privacy-safe footer

**Files:**
- Create: `src/popup/feedback.ts`
- Modify: `src/popup/App.tsx`
- Modify: `src/popup/popup.css`
- Test: `tests/unit/feedback.test.ts`
- Test: `tests/e2e/tts-controls.spec.ts`
- Test: `tests/e2e/support.spec.ts`

**Interfaces:**
- Produces: `buildFeedbackUrl(version: string): string`.
- Consumes: `chrome.runtime.getManifest().version` and the existing popup message/storage APIs.

- [ ] **Step 1: Write failing Feedback URL unit tests**

Create `tests/unit/feedback.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFeedbackUrl } from '../../src/popup/feedback.ts';

test('builds one neutral GitHub Feedback URL with extension version', () => {
	const url = new URL(buildFeedbackUrl('1.0.0'));
	assert.equal(url.origin + url.pathname, 'https://github.com/tunglt1810/readit.dev/issues/new');
	assert.match(url.searchParams.get('body') || '', /Extension version: v1\.0\.0/);
	assert.match(url.searchParams.get('body') || '', /Bug|Feature request/);
});

test('does not accept or include page-derived data', () => {
	const feedbackUrl = decodeURIComponent(buildFeedbackUrl('1.0.0'));
	assert.doesNotMatch(feedbackUrl, /example\.com/);
	assert.doesNotMatch(feedbackUrl, /selected text/i);
	assert.doesNotMatch(feedbackUrl, /page title/i);
});
```

- [ ] **Step 2: Run Feedback tests and verify RED**

```bash
node --experimental-strip-types --test tests/unit/feedback.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/popup/feedback.ts`.

- [ ] **Step 3: Implement the Feedback URL helper**

Create `src/popup/feedback.ts`:

```ts
const GITHUB_NEW_ISSUE_URL = 'https://github.com/tunglt1810/readit.dev/issues/new';

export function buildFeedbackUrl(version: string): string {
	const url = new URL(GITHUB_NEW_ISSUE_URL);
	url.searchParams.set(
		'body',
		[
			'## Feedback type',
			'- [ ] Bug',
			'- [ ] Feature request',
			'',
			'## Description',
			'',
			'---',
			`Extension version: v${version}`,
		].join('\n'),
	);
	return url.toString();
}
```

- [ ] **Step 4: Update popup E2E expectations first**

In `tests/e2e/tts-controls.spec.ts`:

- locate Read, Pause, Resume, and Stop with `getByRole('button', { name: ... })`;
- assert each icon button has empty text content and contains one `svg[aria-hidden="true"]`;
- replace old emoji-plus-text assertions;
- after broadcasting a `loading` session, assert the Stop button is enabled and clicking it sends `STOP_READING`.

Use exact assertions such as:

```ts
const readButton = page.getByRole('button', { name: 'Đọc trang hiện tại' });
await expect(readButton).toHaveText('');
await expect(readButton.locator('svg[aria-hidden="true"]')).toHaveCount(1);

const pauseButton = page.getByRole('button', { name: 'Tạm dừng' });
await expect(pauseButton).toHaveText('');

const resumeButton = page.getByRole('button', { name: 'Tiếp tục' });
const stopButton = page.getByRole('button', { name: 'Dừng đọc bài' });
await expect(stopButton).toBeEnabled();
```

In `tests/e2e/support.spec.ts`, install a popup runtime mock containing a
session URL such as `https://private.example.test/article`, then assert:

```ts
await expect(page.getByRole('link', { name: 'Buy me a coffee' })).toHaveAttribute('target', '_blank');
const feedback = page.getByRole('link', { name: 'Feedback' });
await expect(feedback).toHaveAttribute('target', '_blank');
await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('target', '_blank');
await expect(page.locator('.extension-version')).toHaveText('v1.0.0');
const href = (await feedback.getAttribute('href')) || '';
expect(decodeURIComponent(href)).toContain('Extension version: v1.0.0');
expect(decodeURIComponent(href)).not.toContain('private.example.test');
```

Run targeted E2E against the current popup and verify failure on accessible
icon content, ambiguous support selectors, or old version/footer content.

- [ ] **Step 5: Render inline SVG controls and exact accessible labels**

In `src/popup/App.tsx`:

1. Import `buildFeedbackUrl`.
2. Remove `issueTitle`, `issueBody`, session URL interpolation, and `issueUrl`.
3. Add this local `PlaybackIcon` function with no new dependency:

```tsx
type PlaybackIconName = 'read' | 'stop' | 'pause' | 'resume';

function PlaybackIcon({ name }: { name: PlaybackIconName }) {
	const commonProps = {
		viewBox: '0 0 24 24',
		'aria-hidden': true,
		focusable: 'false',
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 2,
		strokeLinecap: 'round' as const,
		strokeLinejoin: 'round' as const,
	};

	switch (name) {
		case 'stop':
			return (
				<svg {...commonProps}>
					<rect x="7" y="7" width="10" height="10" rx="1" />
				</svg>
			);
		case 'pause':
			return (
				<svg {...commonProps}>
					<line x1="9" y1="6" x2="9" y2="18" />
					<line x1="15" y1="6" x2="15" y2="18" />
				</svg>
			);
		case 'resume':
			return (
				<svg {...commonProps}>
					<polygon points="8 5 19 12 8 19 8 5" />
				</svg>
			);
		default:
			return (
				<svg {...commonProps}>
					<path d="M5 9v6h4l5 4V5L9 9H5z" />
					<path d="M17 9a4 4 0 0 1 0 6" />
				</svg>
			);
	}
}
```

4. Render icon buttons with exact `aria-label` and matching `title`:

```tsx
<button
	className="btn btn-secondary btn-icon-only btn-playpause"
	onClick={handlePlayPause}
	aria-label={status === 'playing' ? 'Tạm dừng' : 'Tiếp tục'}
	title={status === 'playing' ? 'Tạm dừng' : 'Tiếp tục'}
>
	<PlaybackIcon name={status === 'playing' ? 'pause' : 'resume'} />
</button>
```

The primary button uses `read` for stopped/error and `stop` otherwise. Remove
the loading `disabled` condition so Stop remains available during loading.

- [ ] **Step 6: Replace footer content**

Use:

```tsx
const feedbackUrl = buildFeedbackUrl(manifestVersion);
```

Render the existing coffee/privacy links plus exactly one Feedback link, then:

```tsx
<footer className="app-footer">
	<div className="footer-links">
		<a className="support-link" href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noreferrer">
			<span aria-hidden="true">☕</span> Buy me a coffee
		</a>
		<a className="support-link feedback-link" href={feedbackUrl} target="_blank" rel="noreferrer">
			Feedback
		</a>
		<a className="privacy-link" href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
			Privacy Policy
		</a>
	</div>
	<span className="extension-version">v{manifestVersion}</span>
</footer>
```

Remove the copyright/readit.dev/on-device-audio string and do not pass session
metadata to `buildFeedbackUrl`.

- [ ] **Step 7: Update popup styles**

In `src/popup/popup.css`, retain the existing 52px circular button rule and add:

```css
.btn-icon-only svg {
	width: 22px;
	height: 22px;
}

.btn:focus-visible {
	outline: 2px solid #a78bfa;
	outline-offset: 3px;
}

.footer-links {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: 12px;
	align-items: center;
}

.extension-version {
	font-size: 10px;
	color: var(--color-text-secondary);
	letter-spacing: 0.2px;
}
```

Remove the obsolete `.copyright` rule.

Do not restyle unrelated popup sections.

- [ ] **Step 8: Run Feedback unit tests, targeted E2E, and build**

```bash
node --experimental-strip-types --test tests/unit/feedback.test.ts
pnpm build
pnpm test:e2e -- tests/e2e/tts-controls.spec.ts tests/e2e/support.spec.ts
```

Expected: Feedback tests PASS; build PASS; popup E2E tests PASS with no strict
locator violations.

- [ ] **Step 9: Commit Task 3 only**

```bash
git add src/popup/feedback.ts src/popup/App.tsx src/popup/popup.css tests/unit/feedback.test.ts tests/e2e/tts-controls.spec.ts tests/e2e/support.spec.ts
git commit -m "Polish popup controls and feedback footer"
```

---

### Task 4: Durable manifest and release assertions

**Files:**
- Create: `scripts/validate-free-manifest.mjs`
- Create: `tests/unit/manifest_validation.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/release-extension.yml`
- Modify: `_docs/RELEASING.md`

**Interfaces:**
- Produces: `validateFreeManifest(manifest: unknown): void`.
- Produces CLI: `node scripts/validate-free-manifest.mjs <manifest-path>`.
- Consumes: built `dist/manifest.json` after `pnpm build`.

- [ ] **Step 1: Write failing manifest-validator unit tests**

Create `tests/unit/manifest_validation.test.ts` with a valid minimal manifest
fixture and these cases:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFreeManifest } from '../../scripts/validate-free-manifest.mjs';

const validManifest = {
	manifest_version: 3,
	permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'contextMenus'],
	host_permissions: ['https://huggingface.co/*'],
};

test('accepts the exact Free extension permission boundary', () => {
	assert.doesNotThrow(() => validateFreeManifest(validManifest));
});

test('rejects a missing contextMenus permission', () => {
	assert.throws(
		() => validateFreeManifest({ ...validManifest, permissions: validManifest.permissions.filter((value) => value !== 'contextMenus') }),
		/contextMenus/,
	);
});

test('rejects unexpected permissions and host access', () => {
	assert.throws(() => validateFreeManifest({ ...validManifest, permissions: [...validManifest.permissions, 'tabs'] }), /tabs/);
	assert.throws(() => validateFreeManifest({ ...validManifest, host_permissions: ['<all_urls>'] }), /<all_urls>/);
});
```

- [ ] **Step 2: Run validator tests and verify RED**

```bash
node --experimental-strip-types --test tests/unit/manifest_validation.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`scripts/validate-free-manifest.mjs`.

- [ ] **Step 3: Implement exact Free-manifest validation**

Create `scripts/validate-free-manifest.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PERMISSIONS = ['activeTab', 'contextMenus', 'offscreen', 'scripting', 'storage'];
const REQUIRED_HOST_PERMISSIONS = ['https://huggingface.co/*'];

function compareExact(actual, expected, label) {
	const actualValues = Array.isArray(actual) ? actual.map(String).sort() : [];
	const expectedValues = [...expected].sort();
	const missing = expectedValues.filter((value) => !actualValues.includes(value));
	const unexpected = actualValues.filter((value) => !expectedValues.includes(value));
	if (missing.length || unexpected.length) {
		throw new Error(`${label} mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
	}
}

export function validateFreeManifest(manifest) {
	if (!manifest || typeof manifest !== 'object') {
		throw new Error('Manifest must be an object');
	}
	if (manifest.manifest_version !== 3) {
		throw new Error(`Expected manifest_version 3, got ${String(manifest.manifest_version)}`);
	}
	compareExact(manifest.permissions, REQUIRED_PERMISSIONS, 'permissions');
	compareExact(manifest.host_permissions, REQUIRED_HOST_PERMISSIONS, 'host_permissions');
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (scriptPath && fileURLToPath(import.meta.url) === scriptPath) {
	const manifestPath = process.argv[2];
	if (!manifestPath) {
		throw new Error('Usage: node scripts/validate-free-manifest.mjs <manifest-path>');
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	validateFreeManifest(manifest);
	console.log(`Validated Free manifest: ${manifestPath}`);
}
```

- [ ] **Step 4: Add the validation script and CI step**

Add to `package.json`:

```json
"validate:manifest": "node scripts/validate-free-manifest.mjs dist/manifest.json"
```

Add immediately after `Build extension` in
`.github/workflows/release-extension.yml`:

```yaml
      - name: Validate Free extension manifest
        run: pnpm validate:manifest
```

Update `_docs/RELEASING.md` to state that the workflow enforces the exact Free
permission/host boundary including `contextMenus`. Correct its canonical spec
link from `./superpowers/specs/...` to `./specs/...`.

- [ ] **Step 5: Run validator tests and built-manifest validation**

```bash
node --experimental-strip-types --test tests/unit/manifest_validation.test.ts
pnpm build
pnpm validate:manifest
pnpm test:unit
```

Expected: validator tests PASS; output includes
`Validated Free manifest: dist/manifest.json`; full unit suite PASS.

- [ ] **Step 6: Commit Task 4 only**

```bash
git add scripts/validate-free-manifest.mjs tests/unit/manifest_validation.test.ts package.json .github/workflows/release-extension.yml _docs/RELEASING.md
git commit -m "Validate Free extension manifest"
```

---

### Task 5: Full verification and documentation closure

**Files:**
- Modify: `_docs/specs/2026-07-13-extension-interaction-improvements.md`
- Modify: `_docs/specs/2026-07-12-free-mvp-design.md`

**Interfaces:**
- Consumes: all production and test outputs from Tasks 1-4.
- Produces: verified implementation status and a canonical implementation delta that lists only unfinished work.

- [ ] **Step 1: Run formatting and source checks**

```bash
git diff --check
pnpm test:unit
pnpm build
pnpm validate:manifest
```

Expected: no whitespace errors; all unit tests PASS; build succeeds; manifest
validation succeeds.

- [ ] **Step 2: Run targeted E2E suites**

```bash
pnpm test:e2e -- tests/e2e/tts-controls.spec.ts tests/e2e/support.spec.ts tests/e2e/reading-state.spec.ts
```

Expected: all targeted popup, lifecycle, and badge tests PASS.

- [ ] **Step 3: Run the complete E2E suite**

```bash
pnpm test:e2e
```

Expected: every Playwright test PASS with one worker and no stale text-based
icon assertions.

- [ ] **Step 4: Inspect the built privacy and permission boundary**

Run:

```bash
rg -n "api\.readit\.dev|session\?\.url|private\.example|selected text" dist public/manifest.json src/popup src/background
```

Expected: no runtime backend endpoint; no Feedback URL interpolation from
session/page data. Test/template text may appear only where intentionally
asserted and must be reviewed manually.

- [ ] **Step 5: Close the specs after successful verification**

In `_docs/specs/2026-07-13-extension-interaction-improvements.md`, change:

```markdown
**Status:** Implemented
```

In `_docs/specs/2026-07-12-free-mvp-design.md`, remove the four completed
interaction bullets from section 10 while retaining the still-pending EN/VI,
language fallback, error mapping, and Free-boundary work.

- [ ] **Step 6: Re-run documentation consistency checks**

```bash
rg -n "TBD|TODO|PLACEHOLDER|implementation pending|readit\.dev v" _docs/specs/2026-07-13-extension-interaction-improvements.md _docs/specs/2026-07-12-free-mvp-design.md
git diff --check
```

Expected: no placeholders, no stale pending status in the focused spec, no
`readit.dev v<version>` footer requirement, and no whitespace errors.

- [ ] **Step 7: Commit verified documentation status**

```bash
git add _docs/specs/2026-07-13-extension-interaction-improvements.md _docs/specs/2026-07-12-free-mvp-design.md
git commit -m "Mark interaction improvements implemented"
```

- [ ] **Step 8: Final review evidence**

Capture for handoff:

```bash
git status --short
git log --oneline -6
git show --check --stat HEAD
```

Expected: only unrelated user-owned files remain uncommitted; recent commits
map one-to-one to Tasks 1-5; the final commit has no whitespace errors.
