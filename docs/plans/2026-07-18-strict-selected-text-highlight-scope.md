# Strict Selected-Text Highlight Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Specification:** [`docs/specs/2026-07-17-word-highlight-during-reading-design.md`](../specs/2026-07-17-word-highlight-during-reading-design.md#5-strict-selected-text-highlight-scope-addendum)

**Goal:** Make context-menu and floating-button selected-text playback highlight only inside the exact selected DOM `Range`, with no article-wide fallback.

**Architecture:** Capture a pending selection `Range` synchronously in the content script, bind it to the background-created playback `sessionId`, and carry a non-sensitive `contentScope` flag in the session and word-update contract. A selection-scoped cursor clips every DOM search to the range boundaries; missing or invalid scope disables highlighting for that session while audio continues.

**Tech Stack:** TypeScript 6 strict, Chrome Manifest V3 content/background messaging, CSS Custom Highlight API, Node test runner, Playwright 1.61.

## Global Constraints

- Selected-text highlighting must never search before or after the selected `Range`.
- Missing, mismatched, detached, or undeliverable selection scope disables highlighting instead of falling back to the article root.
- Full-article highlighting behavior must remain unchanged.
- Selection text and DOM ranges stay in memory and are not persisted.
- Existing TTS timing, normalization, extraction, popup settings, and highlight appearance remain unchanged.
- Use test-first red-green cycles and keep changes limited to the scope contract, selection capture, cursor bounds, and regression coverage.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | Add the non-sensitive playback `contentScope` discriminator. |
| `src/background/playback_state.ts` | Create and preserve the playback content scope. |
| `src/shared/word_highlight.ts` | Define scope activation and scoped word-update messages. |
| `src/background/background.ts` | Mark selected-text sessions, activate the tab scope before `PLAY`, and relay `contentScope`. |
| `src/content/reading_anchor.ts` | Own pending selection capture and session-bound active ranges. |
| `src/content/selection_button.ts` | Store the floating-button selection through the new pending-capture API. |
| `src/content/word_highlight.ts` | Capture context-menu ranges and enforce strict cursor boundaries. |
| `tests/unit/playback_state.test.ts` | Verify scope creation and progress preservation. |
| `tests/e2e/word-highlight.spec.ts` | Reproduce the duplicate-caption bug and prove strict range exhaustion. |

---

### Task 1: Persist the playback content scope

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/background/playback_state.ts`
- Test: `tests/unit/playback_state.test.ts`

**Interfaces:**
- Produces: `PlaybackContentScope = 'article' | 'selection'`.
- Produces: `PlaybackSessionSnapshot.contentScope?: PlaybackContentScope` for backward-compatible hydration.
- Produces: `createPlaybackSession({ ..., contentScope? })`, defaulting new sessions to `article`.

- [ ] **Step 1: Write the failing scope-preservation test**

Add this test to `tests/unit/playback_state.test.ts`:

```ts
test('creates and preserves a selected-text content scope', () => {
	const session = createPlaybackSession({ ...input, contentScope: 'selection' });
	assert.equal(session.contentScope, 'selection');

	const updated = applyPlaybackProgress(
		session,
		session.sessionId,
		{ status: 'playing', currentParagraphIndex: 1, totalParagraphs: 2, progressPercentage: 50 },
		2000,
	);

	assert.equal(updated?.contentScope, 'selection');
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run: `node --experimental-strip-types --test tests/unit/playback_state.test.ts`

Expected: TypeScript stripping/runtime assertion failure because `createPlaybackSession` does not accept or return `contentScope`.

- [ ] **Step 3: Add the minimal session contract**

In `src/shared/types.ts` add:

```ts
export type PlaybackContentScope = 'article' | 'selection';
```

Add this backward-compatible field to `PlaybackSessionSnapshot`:

```ts
	contentScope?: PlaybackContentScope;
```

In `src/background/playback_state.ts`, accept the optional field:

```ts
	contentScope?: PlaybackContentScope;
```

Set it for new sessions:

```ts
		contentScope: input.contentScope ?? 'article',
```

Preserve it in `applyPlaybackProgress`:

```ts
		contentScope: session.contentScope,
```

Set `contentScope: 'article'` in `createPlaybackErrorSession` because extraction failures originate from full-page reading.

- [ ] **Step 4: Run the focused unit test and verify GREEN**

Run: `node --experimental-strip-types --test tests/unit/playback_state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the session contract**

```bash
git add src/shared/types.ts src/background/playback_state.ts tests/unit/playback_state.test.ts
git commit -m "feat: track playback content scope"
```

---

### Task 2: Bind selected-text sessions to strict DOM ranges

**Files:**
- Modify: `src/shared/word_highlight.ts`
- Modify: `src/background/background.ts`
- Modify: `src/content/reading_anchor.ts`
- Modify: `src/content/selection_button.ts`
- Modify: `src/content/word_highlight.ts`
- Test: `tests/e2e/word-highlight.spec.ts`

**Interfaces:**
- Consumes: `PlaybackContentScope` and `PlaybackSessionSnapshot.contentScope` from Task 1.
- Produces: `WordHighlightScopeMessage` with `action`, `sessionId`, and `selectionText`.
- Produces: `capturePendingSelectionRange(range)`, `activatePendingSelectionScope(sessionId, selectionText)`, `getActiveSelectionRange(sessionId)`, and `clearActiveSelectionScope(sessionId)`.
- Produces: range-bounded `WalkerCursor.scopeRange` used only for selection-scoped updates.

- [ ] **Step 1: Extend the E2E message helper for the wished-for contract**

Update the helper union in `tests/e2e/word-highlight.spec.ts`:

```ts
type TestWordHighlightMessage =
	| { action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE'; sessionId: string; selectionText: string }
	| { action: 'WORD_HIGHLIGHT_UPDATE'; sessionId: string; word: string; contentScope?: 'article' | 'selection' }
	| { action: 'WORD_HIGHLIGHT_CLEAR'; sessionId: string };
```

Use `TestWordHighlightMessage` as `sendWordHighlightMessage()`'s message parameter.

Add a helper that selects a real multi-node element and opens its context menu:

```ts
async function selectElementContentsAndOpenContextMenu(page: Page, selector: string): Promise<void> {
	await page.locator(selector).evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	});
}
```

- [ ] **Step 2: Write the failing duplicate-caption context-menu test**

Add an E2E case whose article contains an earlier duplicate phrase:

```ts
test('keeps context-menu selected-text highlights inside the exact selected range', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-context-menu-scope';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><body><article>
				<p id="caption">Ông Trần Minh Khoa xuất hiện trong chú thích ảnh.</p>
				<p id="selected"><span>Ông Trần Minh </span><strong>Khoa</strong> cho biết đơn vị hỗ trợ.</p>
			</article></body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	await selectElementContentsAndOpenContextMenu(page, '#selected');

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);
	const sessionId = 'e2e-context-selection';
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE',
		sessionId,
		selectionText: 'Ông Trần Minh Khoa cho biết đơn vị hỗ trợ.',
	});

	for (const word of ['Ông', 'Trần', 'Minh', 'Khoa']) {
		await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId, word, contentScope: 'selection' });
		await expect
			.poll(() =>
				page.evaluate((name) => {
					const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
					const [range] = highlight ? [...highlight] : [];
					return range?.startContainer.parentElement?.closest('[id]')?.id ?? null;
				}, highlightRegistryName),
			)
			.toBe('selected');
	}
});
```

- [ ] **Step 3: Write the failing strict-end-boundary test**

Add a second E2E case that selects only the first sentence, activates the scope, highlights its first word, then sends a word found only after the range:

```ts
test('clears instead of matching a word after the selected range', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-selection-end';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: '<!doctype html><html lang="en"><body><article><p id="content">Selected words. Outside only.</p></article></body></html>',
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	await selectSubstring(page, '#content', 'Selected words.');
	await page.locator('#content').dispatchEvent('contextmenu');

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker);
	const sessionId = 'e2e-selection-end';
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE',
		sessionId,
		selectionText: 'Selected words.',
	});
	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId, word: 'Selected', contentScope: 'selection' });
	await expect.poll(() => currentHighlightText(page)).toBe('Selected');

	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId, word: 'Outside', contentScope: 'selection' });
	await expect.poll(() => currentHighlightText(page)).toBeNull();
});
```

- [ ] **Step 4: Update the floating-button regression to assert the real session scope**

After clicking the selection button in the existing selected-passage test, obtain `GET_PLAYBACK_STATE` from the extension service worker, assert `session.contentScope === 'selection'`, and use its real `sessionId` for the manual word update with `contentScope: 'selection'`.

- [ ] **Step 5: Build and run the targeted E2E tests to verify RED**

Run: `CI=true pnpm build`

Run: `CI=true pnpm exec playwright test tests/e2e/word-highlight.spec.ts`

Expected failures:

- the context-menu test highlights `caption` because scope activation is not implemented;
- the end-boundary test leaves or moves the highlight outside the selection;
- the floating-button session reports no `selection` content scope.

- [ ] **Step 6: Implement the shared message and background scope routing**

In `src/shared/word_highlight.ts`, add:

```ts
import type { PlaybackContentScope } from './types';

export interface WordHighlightScopeMessage {
	action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE';
	sessionId: string;
	selectionText: string;
}
```

Add `contentScope?: PlaybackContentScope` to `WordHighlightUpdateMessage` for backward-compatible content messages.

In `src/background/background.ts`:

- accept `contentScope: PlaybackContentScope = 'article'` in `startArticlePlayback()`;
- pass `contentScope` into `createPlaybackSession()`;
- before `setupOffscreen()`, send `WORD_HIGHLIGHT_SET_SELECTION_SCOPE` with `sessionId` and `article.content` for selection sessions, catching delivery failure without failing audio;
- pass `'selection'` from both `START_SELECTED_TEXT` and the context-menu handler;
- relay `contentScope: activeSession.contentScope ?? 'article'` in every `WORD_HIGHLIGHT_UPDATE`;
- allow `isPlaybackSessionSnapshot()` to hydrate `undefined`, `article`, or `selection` scope values.

- [ ] **Step 7: Replace the anonymous last range with session-bound scope state**

Replace `src/content/reading_anchor.ts` with this focused API:

```ts
let pendingSelectionRange: Range | null = null;
let activeSelectionScope: { sessionId: string; range: Range | null } | null = null;

function normalizeSelectionText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

export function capturePendingSelectionRange(range: Range | null): void {
	pendingSelectionRange = range;
}

export function activatePendingSelectionScope(sessionId: string, selectionText: string): Range | null {
	const range = pendingSelectionRange;
	pendingSelectionRange = null;
	const validRange =
		range?.commonAncestorContainer.isConnected === true &&
		normalizeSelectionText(range.toString()) === normalizeSelectionText(selectionText)
			? range
			: null;
	activeSelectionScope = { sessionId, range: validRange };
	return validRange;
}

export function getActiveSelectionRange(sessionId: string): Range | null | undefined {
	return activeSelectionScope?.sessionId === sessionId ? activeSelectionScope.range : undefined;
}

export function clearActiveSelectionScope(sessionId: string): void {
	if (activeSelectionScope?.sessionId === sessionId) {
		activeSelectionScope = null;
	}
}
```

Update the floating button to call `capturePendingSelectionRange(activeSelection.getRangeAt(0).cloneRange())`.

- [ ] **Step 8: Implement context-menu capture and a strict range-bounded cursor**

In `src/content/word_highlight.ts`:

- capture the live selection on top-level `contextmenu` before the native menu opens;
- activate pending scope on `WORD_HIGHLIGHT_SET_SELECTION_SCOPE`;
- include `scopeRange: Range | null` in `WalkerCursor`;
- use `Range.comparePoint()` to skip nodes before the selection and stop nodes or matches after it;
- when `contentScope === 'selection'`, use only `getActiveSelectionRange(sessionId)` and disable highlighting when it returns `null` or `undefined`;
- clear the visible highlight when a selection-scoped search misses;
- clear only the matching active session on `WORD_HIGHLIGHT_CLEAR`, preserving a newer pending capture.

Use this helper to clip each text node:

```ts
function selectionSearchBounds(range: Range, node: Text, cursorOffset: number): { start: number; end: number } | 'after' | null {
	const length = node.textContent?.length ?? 0;
	try {
		if (range.comparePoint(node, 0) > 0) {
			return 'after';
		}
		if (range.comparePoint(node, length) < 0) {
			return null;
		}
		const start = node === range.startContainer ? Math.max(cursorOffset, range.startOffset) : cursorOffset;
		const end = node === range.endContainer ? Math.min(length, range.endOffset) : length;
		return start < end ? { start, end } : 'after';
	} catch {
		return 'after';
	}
}
```

Accept a match only when `matchIndex + variant.length <= bounds.end`. If the helper returns `'after'`, roll the cursor back to its pre-search position and return `null`.

- [ ] **Step 9: Build and run the targeted E2E suite to verify GREEN**

Run: `CI=true pnpm build`

Run: `CI=true pnpm exec playwright test tests/e2e/word-highlight.spec.ts`

Expected: PASS, including duplicate-caption, end-boundary, floating-button, and existing full-article cases.

- [ ] **Step 10: Commit the strict selection scope**

```bash
git add src/shared/word_highlight.ts src/background/background.ts src/content/reading_anchor.ts src/content/selection_button.ts src/content/word_highlight.ts tests/e2e/word-highlight.spec.ts
git commit -m "fix: constrain selected-text word highlights"
```

---

### Task 3: Full verification

**Files:** No production changes unless verification exposes a regression.

**Interfaces:** Verifies every requirement in the linked specification.

- [ ] **Step 1: Run all unit tests**

Run: `CI=true pnpm test:unit`

Expected: PASS.

- [ ] **Step 2: Build and validate the extension artifact**

Run: `CI=true pnpm build`

Run: `pnpm validate:manifest`

Expected: both commands exit successfully.

- [ ] **Step 3: Run the complete E2E suite**

Run: `CI=true pnpm test:e2e`

Expected: PASS.

- [ ] **Step 4: Check formatting and whitespace**

Run: `pnpm exec biome check src/shared/types.ts src/shared/word_highlight.ts src/background/playback_state.ts src/background/background.ts src/content/reading_anchor.ts src/content/selection_button.ts src/content/word_highlight.ts tests/unit/playback_state.test.ts tests/e2e/word-highlight.spec.ts`

Run: `git diff --check`

Expected: no errors.

- [ ] **Step 5: Re-read the specification and inspect the final diff**

Confirm each strict-scope requirement maps to code and regression coverage, and confirm unrelated files are untouched.
