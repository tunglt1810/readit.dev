# Word Highlight Pre-computed Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace live DOM word searching during tab playback with a session-scoped, precomputed `wordIndex → Range` map that correctly handles duplicates, speech-unit boundaries, selection scope, visibility, and cleanup.

**Architecture:** Offscreen flattens the same `wordMap` entries used by word timing, then waits for background to relay `WORD_HIGHLIGHT_INIT` to the tab before starting audio. The content script builds a forward-only map once, accepts index-only updates for that initialized session, and paints while the document is visible, even if an extension surface has focus. The background owns tab/session validation, coalesces a relay backlog to the newest index, and never lets highlighting availability alter TTS playback.

**Tech Stack:** Chrome Manifest V3 messaging, TypeScript, DOM `Range`/`TreeWalker`, CSS Custom Highlight API, Node test runner, Playwright.

## Global Constraints

- Apply this only to tab-owned `article` and `selection` sessions; retain Side Panel manual highlight behavior and its existing messages unchanged.
- A global word index is the contiguous order of flattened `SpeechUnit.wordMap` entries, including duplicate text; never derive it from spoken text or a second tokenization pass.
- `WORD_HIGHLIGHT_INIT` is an acknowledged setup barrier. A failed/absent page receiver disables only highlighting; playback still starts and completes normally.
- The synchronous content-side `INIT` handler must return `sendResponse({ success: true })`; the offscreen readiness check must never treat Chrome's otherwise-undefined tab-message response as a successful initialization.
- A selected-text session must fail closed when its captured DOM `Range` is unavailable: do not fall back to article-wide matching.
- Keep the offscreen 50 ms timer and message relay active while a tab is hidden. Suppress only CSS mutations and auto-scroll, then render the latest received index when it becomes visible. Do not suppress a visible article merely because an extension surface has focus.
- Never re-search the document after initialization. A removed or altered mapped range clears the visual highlight instead of targeting another occurrence.
- Add no dependencies and do not modify extraction, TTS synthesis, audio playback semantics, `reading_anchor.ts` capture/validation semantics, or manual highlighting.
- Preserve the unrelated dirty worktree files; stage and commit only files created or edited by this plan.
- Run verification commands sequentially with `CI=true`; use `rtk` for shell commands and `rtk graphify update .` after code changes.

---

## File Structure

- Modify: `src/shared/word_highlight.ts` — typed init/update payloads, structural message validators, and the pure flattened word-list builder shared by offscreen and tests.
- Create: `tests/unit/word_highlight_protocol.test.ts` — validates contiguous indexes and rejects malformed protocol payloads without a browser runtime.
- Modify: `src/background/background.ts` — passes tab `contentScope` to offscreen, acknowledges init relay, and guards update/clear relays by the initialized active session.
- Create: `src/background/word_highlight_update_coalescer.ts` — retains only the latest update waiting behind a tab relay and discards pending state by matching session ID.
- Create: `tests/unit/word_highlight_update_coalescer.test.ts` — proves a slow relay skips stale indexes without letting a stale clear discard a newer session's update.
- Modify: `src/offscreen/offscreen.ts` — creates the word list after preparation, waits for init without making audio dependent on it, sends index deduped updates, and separates timer reset from terminal cleanup.
- Modify: `src/content/word_highlight.ts` — replaces the cursor with mapped ranges, exact session handling, range validity checks, visibility gating, and bounded auto-scroll.
- Modify: `tests/e2e/word-highlight.spec.ts` — migrates existing behavior to init/index messages and adds protocol, mutation, focus, scroll, duplicate, and setting regressions.
- Create: `tests/e2e/word-highlight-runtime.spec.ts` — starts real article playback through the coordinator and asserts that offscreen timing renders a CSS highlight.
- Modify: `tests/e2e/fixtures.ts` — preserves seeded model Cache Storage but removes stale worker state from each cloned test profile so E2E loads the current `dist/` extension.

## Task 1: Define the Word-highlight Protocol

**Files:**
- Modify: `src/shared/word_highlight.ts`
- Create: `tests/unit/word_highlight_protocol.test.ts`

**Interfaces:**
- Consumes: `PlaybackContentScope` from `src/shared/types.ts` and the structural `SpeechUnit.wordMap` shape from `src/offscreen/speech_unit.ts` without importing the offscreen module.
- Produces: `WordHighlightContentScope`, `WordHighlightWord`, `WordHighlightInitMessage`, `WordHighlightUpdateMessage`, `buildWordHighlightWords`, `isWordHighlightInitMessage`, and `isWordHighlightUpdateMessage` for background and offscreen.

- [ ] **Step 1: Write the failing protocol tests**

Create `tests/unit/word_highlight_protocol.test.ts` with these exact observable cases:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildWordHighlightWords,
	isWordHighlightInitMessage,
	isWordHighlightUpdateMessage,
} from '../../src/shared/word_highlight.ts';

test('flattens every word map entry into stable global indexes, including duplicates', () => {
	assert.deepEqual(
		buildWordHighlightWords([
			{ wordMap: [{ text: 'rất' }, { text: 'rất' }] },
			{ wordMap: [] },
			{ wordMap: [{ text: 'nhiều' }] },
		]),
		[
			{ text: 'rất', globalIndex: 0 },
			{ text: 'rất', globalIndex: 1 },
			{ text: 'nhiều', globalIndex: 2 },
		],
	);
});

test('accepts only a contiguous init word list with non-empty words', () => {
	assert.equal(
		isWordHighlightInitMessage({
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: 'session-1',
			contentScope: 'article',
			words: [{ text: 'First', globalIndex: 0 }],
		}),
		true,
	);
	assert.equal(
		isWordHighlightInitMessage({
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: 'session-1',
			contentScope: 'manual',
			words: [{ text: 'First', globalIndex: 0 }],
		}),
		false,
	);
	assert.equal(
		isWordHighlightInitMessage({
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: 'session-1',
			contentScope: 'article',
			words: [{ text: 'First', globalIndex: 1 }],
		}),
		false,
	);
});

test('accepts only non-negative integer update indexes', () => {
	assert.equal(isWordHighlightUpdateMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 's', wordIndex: 0 }), true);
	assert.equal(isWordHighlightUpdateMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 's', wordIndex: -1 }), false);
	assert.equal(isWordHighlightUpdateMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 's', wordIndex: 0.5 }), false);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `CI=true rtk pnpm exec node --experimental-strip-types --test tests/unit/word_highlight_protocol.test.ts`

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the shared contract**

Replace the text-word update contract in `src/shared/word_highlight.ts` with these definitions, retaining `WordHighlightScopeMessage`, `WordHighlightClearMessage`, and `isWordHighlightEnabled`:

```ts
import type { PlaybackContentScope } from './types';

export type WordHighlightContentScope = Exclude<PlaybackContentScope, 'manual'>;

export interface WordHighlightWord {
	text: string;
	globalIndex: number;
}

export interface WordHighlightInitMessage {
	action: 'WORD_HIGHLIGHT_INIT';
	sessionId: string;
	contentScope: WordHighlightContentScope;
	words: readonly WordHighlightWord[];
}

export interface WordHighlightUpdateMessage {
	action: 'WORD_HIGHLIGHT_UPDATE';
	sessionId: string;
	wordIndex: number;
}

export function buildWordHighlightWords(
	units: readonly { wordMap?: readonly { text: string }[] }[],
): WordHighlightWord[] {
	const words: WordHighlightWord[] = [];
	for (const unit of units) {
		for (const entry of unit.wordMap ?? []) {
			words.push({ text: entry.text, globalIndex: words.length });
		}
	}
	return words;
}

export function isWordHighlightInitMessage(value: unknown): value is WordHighlightInitMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as Partial<WordHighlightInitMessage>;
	return (
		message.action === 'WORD_HIGHLIGHT_INIT' &&
		typeof message.sessionId === 'string' &&
		message.sessionId.length > 0 &&
		(message.contentScope === 'article' || message.contentScope === 'selection') &&
		Array.isArray(message.words) &&
		message.words.every(
			(word, index) =>
				typeof word?.text === 'string' && word.text.trim().length > 0 && word.globalIndex === index,
		)
	);
}

export function isWordHighlightUpdateMessage(value: unknown): value is WordHighlightUpdateMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as Partial<WordHighlightUpdateMessage>;
	return (
		message.action === 'WORD_HIGHLIGHT_UPDATE' &&
		typeof message.sessionId === 'string' &&
		message.sessionId.length > 0 &&
		typeof message.wordIndex === 'number' &&
		Number.isInteger(message.wordIndex) &&
		message.wordIndex >= 0
	);
}
```

An empty list is structurally valid but never sent by offscreen; preserving that distinction lets the background validate the protocol while offscreen owns the “no highlights for empty text” decision.

- [ ] **Step 4: Run the focused unit test**

Run: `CI=true rtk pnpm exec node --experimental-strip-types --test tests/unit/word_highlight_protocol.test.ts`

Expected: PASS with 3 tests.

- [ ] **Step 5: Commit the isolated contract**

```bash
rtk git add src/shared/word_highlight.ts tests/unit/word_highlight_protocol.test.ts
rtk git commit -m "feat: define indexed word highlight protocol"
```

## Task 2: Acknowledge Init and Guard Tab Relays

**Files:**
- Modify: `src/background/background.ts`

**Interfaces:**
- Consumes: `WordHighlightInitMessage`, `WordHighlightUpdateMessage`, `isWordHighlightInitMessage`, and `isWordHighlightUpdateMessage` from Task 1.
- Produces: a `{ success: boolean }` runtime response for `WORD_HIGHLIGHT_INIT`; tab relays that contain `{ action, sessionId, contentScope, words }` for init and `{ action, sessionId, wordIndex }` for update.

- [ ] **Step 1: Add the initialized-session state and reset it with the session**

Place this beside `activeSession`:

```ts
let initializedWordHighlightSessionId: string | null = null;
```

At the start of `clearSession`, reset it before sending the direct tab clear:

```ts
const session = activeSession;
activeSession = null;
initializedWordHighlightSessionId = null;
```

This ensures a replaced, stopped, or errored session cannot relay an index after cleanup.

- [ ] **Step 2: Pass tab content scope through the PLAY payload**

In `startPlayback`, include `contentScope` only for a tab source in the object passed to `observeOffscreenPlay`:

```ts
payload: {
	sessionId: session.sessionId,
	article: input.content,
	voiceStyleId,
	speed,
	...(input.source.kind === 'tab' ? { contentScope: input.contentScope } : {}),
	...(input.contentScope === 'manual' ? { panelInstanceId: input.source.panelInstanceId } : {}),
},
```

Do not change the public manual-start payload or manual message routing.

- [ ] **Step 3: Add the acknowledged init relay**

Add a `relayWordHighlightInit` sibling to the existing update relay:

```ts
async function relayWordHighlightInit(message: unknown): Promise<{ success: boolean }> {
	await ensureHydrated();
	if (!isWordHighlightInitMessage(message) || activeSession?.source.kind !== 'tab' || message.sessionId !== activeSession.sessionId) {
		return { success: false };
	}
	try {
		await chrome.tabs.sendMessage(activeSession.source.tabId, message);
		initializedWordHighlightSessionId = activeSession.sessionId;
		return { success: true };
	} catch (_error) {
		return { success: false };
	}
}
```

Register it as a response-bearing queue operation rather than a fire-and-forget message:

```ts
case 'WORD_HIGHLIGHT_INIT':
	return respondFromQueue(() => relayWordHighlightInit(msg), sendResponse);
```

- [ ] **Step 4: Restrict update and clear relays to the initialized session**

Replace the current text-word validation with `isWordHighlightUpdateMessage(message)`. Before `chrome.tabs.sendMessage`, require:

```ts
initializedWordHighlightSessionId === activeSession.sessionId
```

Relay only `action`, `sessionId`, and `wordIndex`. In `relayWordHighlightClear`, require the same initialized session and clear `initializedWordHighlightSessionId` in a `finally` block after attempting its one clear relay. The direct `clearSession` tab message remains, because it must clean up a map even if offscreen does not send a terminal clear.

- [ ] **Step 5: Type-check the relay boundary**

Run: `CI=true rtk pnpm build`

Expected: PASS. The build must prove every previous `WORD_HIGHLIGHT_UPDATE` sender and relay has migrated from `word` to `wordIndex`.

- [ ] **Step 6: Commit the background protocol**

```bash
rtk git add src/background/background.ts
rtk git commit -m "feat: acknowledge word highlight initialization"
```

## Task 3: Initialize Indexed Highlighting Before Tab Audio Starts

**Files:**
- Modify: `src/offscreen/offscreen.ts`

**Interfaces:**
- Consumes: `buildWordHighlightWords`, `WordHighlightContentScope`, and `WordHighlightUpdateMessage` from Task 1; `contentScope` passed by Task 2.
- Produces: one acknowledged `WORD_HIGHLIGHT_INIT` for a non-empty tab word list before first audio, index-only generic updates, and one terminal clear for an initialized session.

- [ ] **Step 1: Replace generic text dedup state**

Replace `lastHighlightedWord` with these state fields near `wordHighlightTimer`:

```ts
let lastHighlightedWordIndex = -1;
let genericHighlightReady = false;
let currentHighlightContentScope: WordHighlightContentScope | null = null;
```

Keep `lastHighlightedManualWordIndex` and all manual checkpoint behavior unchanged. Add an `isWordHighlightContentScope` helper that returns true only for `'article'` and `'selection'`.

- [ ] **Step 2: Read the optional PLAY scope and initialize the map after unit preparation**

Extend the new-play payload shape to accept `contentScope?: unknown`. After `preparePlaybackUnits` assigns `speechUnits`, set `currentHighlightContentScope` only if the session is not manual and the payload scope passes `isWordHighlightContentScope`.

Before model initialization, voice selection, `sendResponse({ success: true })`, and `playNextUnit`, perform the non-fatal init:

```ts
const words = currentHighlightContentScope ? buildWordHighlightWords(speechUnits) : [];
genericHighlightReady = false;
if (currentExtensionSessionId && currentHighlightContentScope && words.length > 0) {
	try {
		const response = await chrome.runtime.sendMessage({
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: currentExtensionSessionId,
			contentScope: currentHighlightContentScope,
			words,
		});
		genericHighlightReady = response?.success === true;
	} catch (_error) {
		genericHighlightReady = false;
	}
}
```

Do not return an error or alter the normal play response when this request fails.

- [ ] **Step 3: Separate unit-boundary reset from terminal cleanup**

Implement the two functions below and call `resetHighlightTimer()` from `startWordHighlightTracking`:

```ts
function resetHighlightTimer(): void {
	if (wordHighlightTimer !== null) {
		clearInterval(wordHighlightTimer);
		wordHighlightTimer = null;
	}
	lastHighlightedWordIndex = -1;
	lastHighlightedManualWordIndex = -1;
}

function clearWordHighlightTracking(): void {
	resetHighlightTimer();
	if (genericHighlightReady && currentExtensionSessionId) {
		void chrome.runtime.sendMessage({ action: 'WORD_HIGHLIGHT_CLEAR', sessionId: currentExtensionSessionId }).catch(() => undefined);
	}
	genericHighlightReady = false;
}
```

`stopAudio`, synthesis failure, and session replacement continue calling `clearWordHighlightTracking`; they must also reset `currentHighlightContentScope` in terminal state cleanup.

- [ ] **Step 4: Send the global index instead of word text**

In the non-manual branch of the 50 ms callback, use the already calculated `wordIndex`:

```ts
if (!genericHighlightReady || !currentExtensionSessionId || wordIndex === lastHighlightedWordIndex) {
	return;
}
lastHighlightedWordIndex = wordIndex;
void chrome.runtime
	.sendMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: currentExtensionSessionId, wordIndex })
	.catch(() => undefined);
```

Leave the manual branch exactly as it is: it sends `OFFSCREEN_MANUAL_WORD_TIMING` with text and its existing index.

- [ ] **Step 5: Run unit and build checks**

Run: `CI=true rtk pnpm test:unit`

Expected: PASS, including the protocol test from Task 1 and the existing timing/word-map tests.

Run: `CI=true rtk pnpm build`

Expected: PASS with no remaining `lastHighlightedWord` or generic text-word payload type errors.

- [ ] **Step 6: Commit the offscreen bridge**

```bash
rtk git add src/offscreen/offscreen.ts
rtk git commit -m "feat: precompute indexed word highlight sessions"
```

## Task 4: Replace the Content Cursor with a Safe Range Map

**Files:**
- Modify: `src/content/word_highlight.ts`

**Interfaces:**
- Consumes: the shared init/update guards from Task 1 and selection ranges maintained by `src/content/reading_anchor.ts`.
- Produces: precomputed `Map<number, MappedWordRange>` state, exact-session index rendering, safe range invalidation, visibility gating, and viewport-only scrolling.

- [ ] **Step 1: Remove cursor state and define map/session helpers**

Delete `WalkerCursor`, `createCursor`, `findNextWordRange`, and module-level `cursor`. Retain the existing walker root, noise, Unicode, boundary, and selection-bound helpers.

Add this state and helpers after `clearHighlight`:

```ts
type MappedWordRange = { range: Range; variants: readonly string[] };

let wordRanges: Map<number, MappedWordRange> | null = null;
let currentWordIndex = -1;
let currentSessionId: string | null = null;
let enabled = true;
let visualUpdatesAllowed = document.visibilityState === 'visible';

function disposeCurrentHighlightSession(): void {
	if (currentSessionId) clearActiveSelectionScope(currentSessionId);
	currentSessionId = null;
	wordRanges = null;
	currentWordIndex = -1;
	clearHighlight();
}

function isMappedRangeUsable(mapped: MappedWordRange): boolean {
	const { range } = mapped;
	if (!range.startContainer.isConnected || !range.endContainer.isConnected || range.collapsed) return false;
	return wordVariants(range.toString()).some((variant) => mapped.variants.includes(variant));
}
```

- [ ] **Step 2: Implement the one-pass precomputation**

Replace the deleted cursor search with `precomputeWordRanges(words, scopeRange)`. It must use the existing `resolveWalkerRoot`, `createWalker`, `selectionSearchBounds`, `wordVariants`, and `findWordBoundaryMatch` helpers:

```ts
function precomputeWordRanges(words: readonly WordHighlightWord[], scopeRange: Range | null): Map<number, MappedWordRange> {
	const ranges = new Map<number, MappedWordRange>();
	const walker = createWalker(resolveWalkerRoot(scopeRange));
	let node = walker.nextNode() as Text | null;
	let offset = 0;
	if (scopeRange) {
		while (node) {
			try {
				if (scopeRange.comparePoint(node, node.textContent?.length ?? 0) >= 0) break;
			} catch {
				break;
			}
			node = walker.nextNode() as Text | null;
		}
		if (node === scopeRange.startContainer) offset = scopeRange.startOffset;
	}
	for (const { text, globalIndex } of words) {
		const variants = wordVariants(text);
		let found = false;
		let nodesScanned = 0;
		while (node && variants.length > 0 && nodesScanned < MAX_NODES_SCANNED_PER_WORD && !found) {
			const searchText = (node.textContent ?? '').toLocaleLowerCase();
			let searchStart = offset;
			let searchEnd = searchText.length;
			if (scopeRange) {
				const bounds = selectionSearchBounds(scopeRange, node, offset);
				if (bounds === 'after') {
					node = null;
					break;
				}
				if (bounds === null) {
					node = walker.nextNode() as Text | null;
					offset = 0;
					nodesScanned++;
					continue;
				}
				searchStart = bounds.start;
				searchEnd = bounds.end;
			}
			for (const variant of variants) {
				const matchIndex = findWordBoundaryMatch(searchText, variant, searchStart);
				if (matchIndex !== -1 && matchIndex + variant.length <= searchEnd) {
					const range = document.createRange();
					range.setStart(node, matchIndex);
					range.setEnd(node, matchIndex + variant.length);
					ranges.set(globalIndex, { range, variants });
					offset = matchIndex + variant.length;
					found = true;
					break;
				}
			}
			if (!found) {
				node = walker.nextNode() as Text | null;
				offset = 0;
				nodesScanned++;
			}
		}
	}
	return ranges;
}
```

Do not restore the previous start node on a miss. If a selection bound reports `'after'`, stop mapping that and all later words; their absent map entries clear the highlight when updated.

- [ ] **Step 3: Render only validated mapped ranges**

Implement index update/render behavior as follows:

```ts
function applyHighlightForIndex(wordIndex: number): void {
	const mapped = wordRanges?.get(wordIndex);
	if (!mapped || !isMappedRangeUsable(mapped)) {
		wordRanges?.delete(wordIndex);
		clearHighlight();
		return;
	}
	ensureStyleInjected();
	CSS.highlights?.set(WORD_HIGHLIGHT_NAME, new Highlight(mapped.range));
	scrollIntoViewIfNeeded(mapped.range);
}

function handleHighlightUpdate(wordIndex: number): void {
	currentWordIndex = wordIndex;
	if (enabled && visualUpdatesAllowed && wordRanges) applyHighlightForIndex(wordIndex);
}
```

An unknown index, a missing split-markup word, or a changed range must clear the old CSS highlight rather than leaving a stale word visible.

- [ ] **Step 4: Install strict message, setting, visibility, and scroll behavior**

Use `isWordHighlightInitMessage` and `isWordHighlightUpdateMessage` in the content listener.

```ts
if (isWordHighlightInitMessage(message)) {
	if (currentSessionId !== message.sessionId) {
		disposeCurrentHighlightSession();
		currentSessionId = message.sessionId;
	} else {
		clearHighlight();
		wordRanges = null;
		currentWordIndex = -1;
	}
	const selectionRange = message.contentScope === 'selection' ? getActiveSelectionRange(message.sessionId) : null;
	wordRanges = message.contentScope === 'selection' && !selectionRange
		? new Map()
		: precomputeWordRanges(message.words, selectionRange ?? null);
}

if (isWordHighlightUpdateMessage(message)) {
	if (message.sessionId !== currentSessionId || !wordRanges) return;
	handleHighlightUpdate(message.wordIndex);
}
```

Keep `WORD_HIGHLIGHT_SET_SELECTION_SCOPE` before `INIT`; it may set `currentSessionId`, activate the captured range, clear any previous session, and must not build a map. `CLEAR` may dispose only the matching current session.

Add a visibility gate and no-animation scroll helper:

```ts
function updateVisualUpdatePermission(): void {
	visualUpdatesAllowed = document.visibilityState === 'visible';
	if (visualUpdatesAllowed && enabled && currentWordIndex >= 0) {
		applyHighlightForIndex(currentWordIndex);
	} else if (!visualUpdatesAllowed) {
		clearHighlight();
	}
}

function scrollIntoViewIfNeeded(range: Range): void {
	const rect = range.getBoundingClientRect();
	if (rect.top < 0) {
		window.scrollBy({ top: rect.top - window.innerHeight * 0.2, behavior: 'auto' });
		return;
	}
	if (rect.bottom > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
		range.startContainer.parentElement?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
	}
}
```

Register `updateVisualUpdatePermission` for `visibilitychange`. On storage setting changes, disabling clears CSS; enabling applies the recorded current index only when `visualUpdatesAllowed` is true.

- [ ] **Step 5: Run the focused E2E suite**

Run: `CI=true rtk pnpm exec playwright test tests/e2e/word-highlight.spec.ts --retries=0`

Expected: FAIL because existing fixtures still send text-word updates. Task 5 replaces those fixtures and makes this suite pass.

- [ ] **Step 6: Commit the content mapper**

```bash
rtk git add src/content/word_highlight.ts
rtk git commit -m "feat: map spoken word indexes to page ranges"
```

## Task 5: Migrate and Expand Word-highlight E2E Coverage

**Files:**
- Modify: `tests/e2e/word-highlight.spec.ts`
- Create: `tests/e2e/word-highlight-runtime.spec.ts`
- Modify: `tests/e2e/fixtures.ts`

**Interfaces:**
- Consumes: the init/update payload types from Task 1 and the content behavior from Task 4.
- Produces: a deterministic browser regression suite for all protocol and rendering guarantees in the spec.

- [ ] **Step 1: Replace the test message union and add protocol helpers**

Replace the text-word update member with init/index forms and add helpers that keep test indexes contiguous:

```ts
type TestWordHighlightMessage =
	| { action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE'; sessionId: string; selectionText: string }
	| { action: 'WORD_HIGHLIGHT_INIT'; sessionId: string; contentScope: 'article' | 'selection'; words: { text: string; globalIndex: number }[] }
	| { action: 'WORD_HIGHLIGHT_UPDATE'; sessionId: string; wordIndex: number }
	| { action: 'WORD_HIGHLIGHT_CLEAR'; sessionId: string };

function highlightWords(...texts: string[]) {
	return texts.map((text, globalIndex) => ({ text, globalIndex }));
}

async function initializeWordHighlight(
	serviceWorker: Worker,
	tabId: number,
	input: { sessionId: string; contentScope?: 'article' | 'selection'; words: string[] },
): Promise<void> {
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_INIT',
		sessionId: input.sessionId,
		contentScope: input.contentScope ?? 'article',
		words: highlightWords(...input.words),
	});
}

async function openWordHighlightPage(context: BrowserContext, name: string, articleHtml: string) {
	const targetUrl = `https://readit.test/${name}`;
	await context.route(targetUrl, (route) =>
		route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><article>${articleHtml}</article></body></html>` }),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	const serviceWorker = findExtensionServiceWorker(context);
	return { page, serviceWorker, tabId: await getTabId(serviceWorker) };
}
```

Add `import { STORAGE_KEYS } from '../../src/shared/constants';` beside the existing tokenizer import so the preference regression uses the production storage key.

- [ ] **Step 2: Convert each existing regression before adding new cases**

For every test, send one init before its first update and replace each word with its zero-based index in the init list. Preserve these assertions exactly:

- basic update then clear;
- fast `chrome.tabs.sendMessage` round trip;
- repeated-word position;
- floating-button selection anchor;
- context-menu exact selection;
- selection end boundary;
- NFC/NFD text;
- article root/noise false positive;
- word-boundary and punctuation cases;
- split-markup recovery;
- realistic full Vietnamese article, where `words` becomes the init list and the loop sends `wordIndex`.

For the full-article loop, use:

```ts
await initializeWordHighlight(serviceWorker, tabId, { sessionId: 'e2e-full-article', words });
for (const [wordIndex, word] of words.entries()) {
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId: 'e2e-full-article',
		wordIndex,
	});
	await expect.poll(() => currentHighlightText(page), { message: `expected "${word}" to be highlighted` }).toBe(word);
}
```

- [ ] **Step 3: Add protocol and mutation regressions**

Add these separate tests, each with a fresh session ID:

```ts
test('ignores an update before its session is initialized', async ({ context }) => {
	const { page, serviceWorker, tabId } = await openWordHighlightPage(context, 'update-before-init', '<p>First</p>');
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId: 'uninitialized',
		wordIndex: 0,
	});
	await expect.poll(() => currentHighlightText(page)).toBeNull();
});

test('does not let an old clear erase a newer initialized session', async ({ context }) => {
	const { page, serviceWorker, tabId } = await openWordHighlightPage(context, 'stale-clear', '<p>Old New</p>');
	await initializeWordHighlight(serviceWorker, tabId, { sessionId: 'old', words: ['Old'] });
	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'old', wordIndex: 0 });
	await initializeWordHighlight(serviceWorker, tabId, { sessionId: 'new', words: ['New'] });
	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'new', wordIndex: 0 });
	await expect.poll(() => currentHighlightText(page)).toBe('New');
	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: 'old' });
	await expect.poll(() => currentHighlightText(page)).toBe('New');
});

test('does not fall back outside an unavailable selected range', async ({ context }) => {
	const { page, serviceWorker, tabId } = await openWordHighlightPage(context, 'missing-selection', '<p>Selected</p>');
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE',
		sessionId: 'missing-selection',
		selectionText: 'Selected',
	});
	await initializeWordHighlight(serviceWorker, tabId, {
		sessionId: 'missing-selection',
		contentScope: 'selection',
		words: ['Selected'],
	});
	await sendWordHighlightMessage(serviceWorker, tabId, {
		action: 'WORD_HIGHLIGHT_UPDATE',
		sessionId: 'missing-selection',
		wordIndex: 0,
	});
	await expect.poll(() => currentHighlightText(page)).toBeNull();
});

test('clears a removed mapped range without finding a later duplicate', async ({ context }) => {
	const { page, serviceWorker, tabId } = await openWordHighlightPage(
		context,
		'mutated-range',
		'<p>First <span id="mapped-target">target</span> target</p>',
	);
	await initializeWordHighlight(serviceWorker, tabId, { sessionId: 'mutated', words: ['First', 'target', 'target'] });
	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'mutated', wordIndex: 0 });
	await expect.poll(() => currentHighlightText(page)).toBe('First');
	await page.locator('#mapped-target').evaluate((element) => element.remove());
	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'mutated', wordIndex: 1 });
	await expect.poll(() => currentHighlightText(page)).toBeNull();
});
```

Add this consecutive-duplicate assertion:

```ts
test('uses the second range for consecutive duplicate indexes', async ({ context }) => {
	const { page, serviceWorker, tabId } = await openWordHighlightPage(context, 'duplicate-index', '<p>very very</p>');
	await initializeWordHighlight(serviceWorker, tabId, { sessionId: 'duplicate', words: ['very', 'very'] });
	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'duplicate', wordIndex: 1 });
	await expect
		.poll(() =>
			page.evaluate((name) => {
				const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
				const [range] = highlight ? [...highlight] : [];
				return range?.startOffset ?? null;
			}, highlightRegistryName),
		)
		.toBe(5);
});
```

- [ ] **Step 4: Add visibility, preference, and scroll regressions**

Add an ordinary second page to move focus away while the article remains visible. Initialize `['First', 'Second']`, render index 0, send index 1, and assert the article's CSS highlight is `Second` even though `document.hasFocus()` is false.

Before navigating a scroll test, install this browser-side spy with `page.addInitScript`:

```ts
await page.addInitScript(() => {
	(window as unknown as { scrollCalls: unknown[] }).scrollCalls = [];
	const original = HTMLElement.prototype.scrollIntoView;
	HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) {
		(window as unknown as { scrollCalls: unknown[] }).scrollCalls.push(options ?? null);
		return original.call(this, options);
	};
});
```

Route one in-view word and one word below a tall spacer. Assert the in-view update makes no call, and the below-viewport update makes exactly one call equal to:

```ts
{ behavior: 'auto', block: 'nearest', inline: 'nearest' }
```

Add a word at the start of a paragraph taller than the viewport, scroll into the middle of that paragraph, then update the word. Assert its range becomes visible; its parent remains partly visible, so `nearest` alone must not be used for this above-viewport case.

Finally, toggle `STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED` through `chrome.storage.local` during an initialized session: disabling clears CSS, and enabling re-renders the latest index without a new update.

- [ ] **Step 5: Run the focused suite and then all unit tests**

Run: `CI=true rtk pnpm exec playwright test tests/e2e/word-highlight.spec.ts --retries=0`

Expected: PASS. The result must include the migrated legacy coverage and the new init/order, mutation, focus, scroll, duplicate, and preference cases.

Run: `CI=true rtk pnpm test:unit`

Expected: PASS.

- [ ] **Step 6: Commit the migrated regressions**

```bash
rtk git add tests/e2e/word-highlight.spec.ts
rtk git commit -m "test: cover indexed word highlight lifecycle"
```

## Task 6: Verify the Completed Change

**Files:**
- Modify: `graphify-out/` only through the ignored graph update output

**Interfaces:**
- Consumes: all implementation and test changes from Tasks 1–5.
- Produces: verified extension build, current knowledge graph, and a clean diff check without changing unrelated worktree files.

- [ ] **Step 1: Run the complete sequential verification chain**

```bash
CI=true rtk pnpm test:unit
CI=true rtk pnpm build
CI=true rtk pnpm validate:manifest
CI=true rtk pnpm lint
CI=true rtk pnpm exec playwright test tests/e2e/word-highlight.spec.ts --retries=0
CI=true rtk pnpm test:e2e
```

Expected: every command exits 0. If browser startup fails with a sandbox process error, rerun that specific Playwright command with the required process permission before diagnosing product behavior.

- [ ] **Step 2: Update the code graph and inspect the final patch**

```bash
rtk graphify update .
rtk git diff --check
rtk git status --short
```

Expected: `git diff --check` has no output. Confirm that only planned source/test files are staged or committed and preserve all pre-existing unrelated changes.

- [ ] **Step 3: Make the final verification commit only if a planned file remains unstaged**

```bash
rtk git add src/shared/word_highlight.ts src/background/background.ts src/offscreen/offscreen.ts src/content/word_highlight.ts tests/unit/word_highlight_protocol.test.ts tests/e2e/word-highlight.spec.ts
rtk git commit -m "fix: stabilize tab word highlighting"
```

Before staging, compare the listed paths with `git status --short`; omit any path already committed and never stage the user's unrelated work.
