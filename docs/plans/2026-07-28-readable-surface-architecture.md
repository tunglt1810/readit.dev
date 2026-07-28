# Readable Surface Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Readable Surface capability explicit for every Playback Session and concentrate Website DOM, Manual Reader, and None projection lifecycle in one background Module without implementing Google Docs or PDF highlighting.

**Architecture:** Successful extraction returns an `Article` plus a `ReadableSurfaceKind`; playback persists that value instead of inferring projection capability from `contentScope` or URL. Offscreen emits one canonical spoken-position protocol, while a background Readable Surface Module validates session ownership and routes events to the existing Website DOM or Manual Reader Adapter. Google Docs, PDF, and error sessions use the None Adapter and produce no projection work.

**Tech Stack:** TypeScript 6, Chrome Manifest V3 messaging and session storage, React 19 Side Panel, Node test runner, Playwright, pnpm.

## Global Constraints

- Preserve `Article`, normalizer, word maps, speech units, timing, audio playback, extraction precedence, and current UI styling.
- Preserve exact selected DOM `Range` behavior and Website visibility/scroll/setting semantics.
- Preserve Manual Reader monotonic matching, owner scoping, and independence from the Website highlight setting.
- Surface initialization and delivery remain fail-open: audio must continue.
- Website updates remain coalesced; Manual Reader updates must not be coalesced.
- Google Docs, PDF, and error sessions use `readableSurface: 'none'`.
- Do not add a Google Docs/PDF highlighter, custom viewer, new permission, registry, dynamic discovery, or plugin manifest.
- Keep extracted and manual text memory-only.
- Use tabs, LF endings, and the repository's 140-character Biome line width.
- Run managed pnpm commands with `CI=true`.

---

## File Map

- Create `src/shared/readable_surface.ts`: canonical projection messages, validators, and the shared indexed-word shape.
- Modify `src/shared/types.ts`: `ReadableSurfaceKind`, `ExtractedArticle`, and persisted surface-aware Playback Sessions.
- Modify `src/shared/word_highlight.ts`: keep Website downstream messages and settings while importing the shared word shape.
- Modify `src/shared/manual_playback.ts`: keep manual ownership/control messages; remove the offscreen-specific timing message after migration.
- Modify `src/content/content_script.ts`: return `{ article, readableSurface }` for Website and Google Docs extraction.
- Modify `src/content/google_docs_extractor.ts`: mark successful Google Docs extraction as `none`.
- Modify `src/background/article_request.ts`: type and validate the extraction envelope.
- Modify `src/background/pdf_extractor.ts`: mark successful PDF extraction as `none`.
- Modify `src/background/playback_state.ts`: construct and validate surface-aware Playback Sessions.
- Create `src/background/readable_surface.ts`: own active surface lifecycle and the three Adapters.
- Modify `src/background/background.ts`: delegate projection lifecycle and pass explicit surface through playback start.
- Modify `src/background/offscreen_transport.ts`: type the PLAY payload's surface.
- Modify `src/offscreen/offscreen.ts`: emit canonical projection events and skip all projection work for None.
- Modify `src/sidepanel/App.tsx`: handle owner-scoped Manual Reader clear.
- Create `tests/unit/readable_surface_protocol.test.ts`: canonical protocol validation.
- Create `tests/unit/readable_surface.test.ts`: Module lifecycle, routing, readiness, and failure tests.
- Modify existing extraction, playback-state, manual protocol, Website highlight, Side Panel, PDF, Google Docs, and reading-state tests.

---

### Task 1: Add the Shared Readable Surface Model and Canonical Protocol

**Files:**

- Create: `src/shared/readable_surface.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/shared/word_highlight.ts`
- Test: `tests/unit/readable_surface_protocol.test.ts`
- Modify test: `tests/unit/word_highlight_protocol.test.ts`

**Interfaces:**

- Produces:

```ts
export type ReadableSurfaceKind = 'website-dom' | 'manual-reader' | 'none';

export interface ReadableSurfaceWord {
	text: string;
	globalIndex: number;
}

export interface ReadableSurfaceInitMessage {
	action: 'READABLE_SURFACE_INIT';
	sessionId: string;
	contentScope: PlaybackContentScope;
	words: readonly ReadableSurfaceWord[];
}

export interface ReadableSurfaceUpdateMessage {
	action: 'READABLE_SURFACE_UPDATE';
	sessionId: string;
	wordIndex: number;
	word: string;
}

export interface ReadableSurfaceClearMessage {
	action: 'READABLE_SURFACE_CLEAR';
	sessionId: string;
}
```

- Preserves the Website downstream `WORD_HIGHLIGHT_*` Interface in `src/shared/word_highlight.ts`.

- [ ] **Step 1: Write failing canonical protocol tests**

Create `tests/unit/readable_surface_protocol.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildReadableSurfaceWords,
	isReadableSurfaceClearMessage,
	isReadableSurfaceInitMessage,
	isReadableSurfaceUpdateMessage,
} from '../../src/shared/readable_surface.ts';

test('flattens word maps into contiguous source-equivalent indexes', () => {
	assert.deepEqual(
		buildReadableSurfaceWords([{ wordMap: [{ text: 'rất' }, { text: 'rất' }] }, { wordMap: [{ text: 'nhiều' }] }]),
		[
			{ text: 'rất', globalIndex: 0 },
			{ text: 'rất', globalIndex: 1 },
			{ text: 'nhiều', globalIndex: 2 },
		],
	);
});

test('validates canonical initialize, update, and clear messages', () => {
	assert.equal(
		isReadableSurfaceInitMessage({
			action: 'READABLE_SURFACE_INIT',
			sessionId: 'session-1',
			contentScope: 'manual',
			words: [{ text: 'First', globalIndex: 0 }],
		}),
		true,
	);
	assert.equal(
		isReadableSurfaceInitMessage({
			action: 'READABLE_SURFACE_INIT',
			sessionId: 'session-1',
			contentScope: 'article',
			words: [{ text: 'First', globalIndex: 1 }],
		}),
		false,
	);
	assert.equal(
		isReadableSurfaceUpdateMessage({
			action: 'READABLE_SURFACE_UPDATE',
			sessionId: 'session-1',
			wordIndex: 0,
			word: 'First',
		}),
		true,
	);
	assert.equal(
		isReadableSurfaceUpdateMessage({
			action: 'READABLE_SURFACE_UPDATE',
			sessionId: 'session-1',
			wordIndex: -1,
			word: 'First',
		}),
		false,
	);
	assert.equal(isReadableSurfaceClearMessage({ action: 'READABLE_SURFACE_CLEAR', sessionId: 'session-1' }), true);
	assert.equal(isReadableSurfaceClearMessage({ action: 'READABLE_SURFACE_CLEAR', sessionId: '' }), false);
});
```

- [ ] **Step 2: Run the new test and verify the missing Module failure**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/readable_surface_protocol.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/shared/readable_surface.ts`.

- [ ] **Step 3: Implement the canonical protocol and validators**

Create `src/shared/readable_surface.ts` with:

```ts
import type { PlaybackContentScope } from './types.ts';

export interface ReadableSurfaceWord {
	text: string;
	globalIndex: number;
}

export interface ReadableSurfaceInitMessage {
	action: 'READABLE_SURFACE_INIT';
	sessionId: string;
	contentScope: PlaybackContentScope;
	words: readonly ReadableSurfaceWord[];
}

export interface ReadableSurfaceUpdateMessage {
	action: 'READABLE_SURFACE_UPDATE';
	sessionId: string;
	wordIndex: number;
	word: string;
}

export interface ReadableSurfaceClearMessage {
	action: 'READABLE_SURFACE_CLEAR';
	sessionId: string;
}

export function buildReadableSurfaceWords(units: readonly { wordMap?: readonly { text: string }[] }[]): ReadableSurfaceWord[] {
	const words: ReadableSurfaceWord[] = [];
	for (const unit of units) {
		for (const entry of unit.wordMap ?? []) {
			words.push({ text: entry.text, globalIndex: words.length });
		}
	}
	return words;
}

function hasSessionId(value: { sessionId?: unknown }): value is { sessionId: string } {
	return typeof value.sessionId === 'string' && value.sessionId.length > 0;
}

export function isReadableSurfaceInitMessage(value: unknown): value is ReadableSurfaceInitMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as Partial<ReadableSurfaceInitMessage>;
	return (
		message.action === 'READABLE_SURFACE_INIT' &&
		hasSessionId(message) &&
		(message.contentScope === 'article' || message.contentScope === 'selection' || message.contentScope === 'manual') &&
		Array.isArray(message.words) &&
		message.words.every(
			(word, index) => typeof word?.text === 'string' && word.text.trim().length > 0 && word.globalIndex === index,
		)
	);
}

export function isReadableSurfaceUpdateMessage(value: unknown): value is ReadableSurfaceUpdateMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as Partial<ReadableSurfaceUpdateMessage>;
	return (
		message.action === 'READABLE_SURFACE_UPDATE' &&
		hasSessionId(message) &&
		typeof message.wordIndex === 'number' &&
		Number.isInteger(message.wordIndex) &&
		message.wordIndex >= 0 &&
		typeof message.word === 'string' &&
		message.word.length > 0
	);
}

export function isReadableSurfaceClearMessage(value: unknown): value is ReadableSurfaceClearMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as Partial<ReadableSurfaceClearMessage>;
	return message.action === 'READABLE_SURFACE_CLEAR' && hasSessionId(message);
}
```

Add to `src/shared/types.ts`:

```ts
export type ReadableSurfaceKind = 'website-dom' | 'manual-reader' | 'none';

export interface ExtractedArticle {
	article: Article;
	readableSurface: Extract<ReadableSurfaceKind, 'website-dom' | 'none'>;
}
```

In `src/shared/word_highlight.ts`, import `ReadableSurfaceWord`, remove the duplicate `WordHighlightWord` declaration and
`buildWordHighlightWords()`, and use:

```ts
import type { ReadableSurfaceWord } from './readable_surface.ts';

export interface WordHighlightInitMessage {
	action: 'WORD_HIGHLIGHT_INIT';
	sessionId: string;
	contentScope: WordHighlightContentScope;
	words: readonly ReadableSurfaceWord[];
}
```

Update `src/content/word_highlight.ts` and existing tests to import `ReadableSurfaceWord` or `buildReadableSurfaceWords` from the new Module.

- [ ] **Step 4: Run focused protocol tests**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/readable_surface_protocol.test.ts tests/unit/word_highlight_protocol.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the shared model**

```bash
git add src/shared/types.ts src/shared/readable_surface.ts src/shared/word_highlight.ts src/content/word_highlight.ts tests/unit/readable_surface_protocol.test.ts tests/unit/word_highlight_protocol.test.ts
git commit -m "refactor: add readable surface protocol"
```

---

### Task 2: Return Explicit Surface Capability from Extraction

**Files:**

- Modify: `src/content/content_script.ts`
- Modify: `src/content/google_docs_extractor.ts`
- Modify: `src/background/article_request.ts`
- Modify: `src/background/pdf_extractor.ts`
- Modify: `src/background/background.ts`
- Modify test: `tests/unit/google_docs_extractor.test.ts`
- Modify test: `tests/unit/pdf_extractor.test.ts`
- Modify test: `tests/unit/article_request.test.ts`
- Modify test: `tests/e2e/reader.spec.ts`
- Modify test: `tests/e2e/pdf-reading.spec.ts`

**Interfaces:**

- Consumes `ExtractedArticle` from Task 1.
- Produces successful extraction responses with:

```ts
{ success: true; article: Article; readableSurface: 'website-dom' | 'none' }
```

- Preserves every existing error code and Website → Google Docs → PDF fallback decision.

- [ ] **Step 1: Change extraction expectations first**

Update the Google Docs success assertion:

```ts
assert.deepEqual(result, {
	success: true,
	readableSurface: 'none',
	article: {
		title: 'Planning',
		url: 'https://docs.google.com/document/d/document-id/edit',
		content: 'First paragraph.\n\nSecond paragraph.',
		lang: 'en',
	},
});
```

Update the PDF success assertion:

```ts
assert.deepEqual(await extractPdfArticle(source, dependencies()), {
	success: true,
	readableSurface: 'none',
	article: {
		title: 'PDF title',
		url: source.url,
		content: 'Page one\n\nPage two',
		lang: 'en',
	},
});
```

Add an article request assertion that passes through:

```ts
{
	success: true,
	readableSurface: 'website-dom',
	article,
}
```

Update `tests/e2e/reader.spec.ts` so standard Website extraction expects `website-dom` and Google Docs expects `none`. Update PDF E2E success to expect `none`.

- [ ] **Step 2: Run extraction tests and verify shape mismatches**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/google_docs_extractor.test.ts tests/unit/pdf_extractor.test.ts tests/unit/article_request.test.ts
```

Expected: FAIL because successful responses do not contain `readableSurface`.

- [ ] **Step 3: Add the extraction envelope without changing precedence**

Change the Google Docs success type and return:

```ts
export type GoogleDocsExtractionResponse =
	| { success: true; article: Article; readableSurface: 'none' }
	| { success: false; error: typeof GOOGLE_DOCS_EXPORT_UNAVAILABLE };

return {
	success: true,
	article: { ...input, content, lang: detectContentLanguage(content, input.lang) },
	readableSurface: 'none',
};
```

Change the Website fallback in `src/content/content_script.ts`:

```ts
return article
	? { success: true, article, readableSurface: 'website-dom' }
	: { success: false, error: 'Could not find a readable article on this page.' };
```

Change `PdfArticleResponse` and its success return:

```ts
export type PdfArticleResponse =
	| { success: true; article: Article; readableSurface: 'none' }
	| { success: false; error: PdfErrorCode };
```

Type `ArticleResponse` as:

```ts
export type ArticleResponse =
	| { success: true; article: unknown; readableSurface: unknown }
	| { success: false; error?: string };
```

In `requestCurrentTabArticle()`, accept a successful response only when `article` is valid and `readableSurface` is `website-dom` or `none`.
Do not infer the surface from URL, MIME type, or `contentScope`.

- [ ] **Step 4: Run focused unit and extraction E2E tests**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/google_docs_extractor.test.ts tests/unit/pdf_extractor.test.ts tests/unit/article_request.test.ts
CI=true pnpm exec playwright test tests/e2e/reader.spec.ts tests/e2e/pdf-reading.spec.ts --retries=0
```

Expected: PASS; Google Docs/PDF errors remain unchanged.

- [ ] **Step 5: Commit explicit extraction capability**

```bash
git add src/content/content_script.ts src/content/google_docs_extractor.ts src/background/article_request.ts src/background/pdf_extractor.ts src/background/background.ts tests/unit/google_docs_extractor.test.ts tests/unit/pdf_extractor.test.ts tests/unit/article_request.test.ts tests/e2e/reader.spec.ts tests/e2e/pdf-reading.spec.ts
git commit -m "refactor: expose article surface capability"
```

---

### Task 3: Persist Readable Surface on Playback Sessions

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/background/playback_state.ts`
- Modify: `src/background/background.ts`
- Modify test: `tests/unit/playback_state.test.ts`
- Modify test: `tests/e2e/reading-state.spec.ts`

**Interfaces:**

- Consumes `ReadableSurfaceKind` and extraction responses from Tasks 1–2.
- Produces `PlaybackSessionSnapshot` values with required `readableSurface`.
- Enforces:

```text
tab + article/selection -> website-dom | none
manual + manual         -> manual-reader
error session           -> none
```

- [ ] **Step 1: Add failing construction and validation tests**

Update fixture inputs to include `readableSurface`, then add:

```ts
test('persists valid surfaces and rejects invalid source-surface combinations', () => {
	const website = createPlaybackSession({ ...tabInput, readableSurface: 'website-dom' });
	assert.equal(website.readableSurface, 'website-dom');

	const textOnly = createPlaybackSession({ ...tabInput, readableSurface: 'none' });
	assert.equal(textOnly.readableSurface, 'none');

	const manual = createPlaybackSession({
		...manualInput,
		readableSurface: 'manual-reader',
	});
	assert.equal(manual.readableSurface, 'manual-reader');

	assert.equal(isPlaybackSessionSnapshot({ ...website, readableSurface: 'manual-reader' }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...manual, readableSurface: 'website-dom' }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...website, readableSurface: undefined }), false);
});
```

Update the extraction-error assertion to require `readableSurface: 'none'`. Update reading-state session fixtures similarly.

- [ ] **Step 2: Run playback-state tests and verify failures**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/playback_state.test.ts
```

Expected: FAIL because constructors and validators do not yet accept or persist `readableSurface`.

- [ ] **Step 3: Implement surface-aware session construction**

Add `readableSurface` to `PlaybackSessionBase`. Update constructor input unions:

```ts
type CreatePlaybackSessionInput = PlaybackSessionInputBase &
	(
		| {
				contentScope: 'article' | 'selection';
				source: { kind: 'tab'; tabId: number; title: string; url: string };
				readableSurface: 'website-dom' | 'none';
		  }
		| {
				contentScope: 'manual';
				source: { kind: 'manual'; panelInstanceId: string };
				readableSurface: 'manual-reader';
		  }
	);
```

Persist `readableSurface` in the common session base and include it in strict key validation. Validate tab and manual combinations explicitly.

Make error sessions return:

```ts
{
	...,
	contentScope: 'article',
	readableSurface: 'none',
	source: input.source,
}
```

Pass surfaces at every start:

```ts
// Current page
readableSurface: articleResponse.readableSurface

// Selected text
readableSurface: 'website-dom'

// Manual input
readableSurface: 'manual-reader'
```

- [ ] **Step 4: Run session tests**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/playback_state.test.ts
CI=true pnpm exec playwright test tests/e2e/reading-state.spec.ts --retries=0
```

Expected: PASS; hydration rejects snapshots missing a valid surface.

- [ ] **Step 5: Commit persisted surface state**

```bash
git add src/shared/types.ts src/background/playback_state.ts src/background/background.ts tests/unit/playback_state.test.ts tests/e2e/reading-state.spec.ts
git commit -m "refactor: persist playback surface"
```

---

### Task 4: Deepen the Background Readable Surface Module

**Files:**

- Create: `src/background/readable_surface.ts`
- Create test: `tests/unit/readable_surface.test.ts`
- Reuse: `src/background/word_highlight_update_coalescer.ts`

**Interfaces:**

- Consumes canonical messages and `PlaybackSessionSnapshot`.
- Produces:

```ts
export interface ReadableSurfaceCoordinator {
	activate(session: PlaybackSessionSnapshot): void;
	initialize(message: ReadableSurfaceInitMessage): Promise<{ success: boolean }>;
	advance(message: ReadableSurfaceUpdateMessage): void;
	clear(sessionId: string): Promise<void>;
}

export function createReadableSurfaceCoordinator(dependencies: {
	sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
	sendRuntimeMessage(message: unknown): Promise<unknown>;
	enqueue(operation: () => Promise<void>): void;
}): ReadableSurfaceCoordinator;
```

- Website downstream messages stay `WORD_HIGHLIGHT_INIT`, `WORD_HIGHLIGHT_UPDATE`, and `WORD_HIGHLIGHT_CLEAR`.
- Manual downstream messages stay `MANUAL_WORD_HIGHLIGHT_UPDATE` and add `MANUAL_WORD_HIGHLIGHT_CLEAR`.

- [ ] **Step 1: Write failing lifecycle and routing tests**

Create fake dependency arrays and cover:

```ts
test('initializes Website DOM before coalesced index updates', async () => {
	const sentToTab: unknown[] = [];
	const queued: (() => Promise<void>)[] = [];
	const coordinator = createReadableSurfaceCoordinator({
		sendTabMessage: async (_tabId, message) => {
			sentToTab.push(message);
			return { success: true };
		},
		sendRuntimeMessage: async () => undefined,
		enqueue: (operation) => queued.push(operation),
	});
	coordinator.activate(websiteSession);

	assert.deepEqual(await coordinator.initialize(initMessage('article')), { success: true });
	coordinator.advance(updateMessage(0, 'First'));
	coordinator.advance(updateMessage(1, 'Second'));
	await queued.shift()?.();

	assert.deepEqual(sentToTab, [
		{
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: websiteSession.sessionId,
			contentScope: 'article',
			words,
		},
		{
			action: 'WORD_HIGHLIGHT_UPDATE',
			sessionId: websiteSession.sessionId,
			wordIndex: 1,
		},
	]);
});
```

Add named cases proving:

- Website updates before successful initialization are ignored.
- Manual activation accepts initialization and broadcasts every update with `word` and `wordIndex`.
- None initialization returns `{ success: false }` and sends no message.
- Stale initialization, update, and clear cannot affect a replacement.
- Website clear discards queued updates and sends tab clear.
- Manual clear sends `{ action: 'MANUAL_WORD_HIGHLIGHT_CLEAR', sessionId }`.
- Tab/runtime delivery rejection returns failure or is swallowed without throwing into playback.

- [ ] **Step 2: Run the Module test and verify the missing Module failure**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/readable_surface.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/background/readable_surface.ts`.

- [ ] **Step 3: Implement the coordinator and internal Adapters**

Implement one active session, one Website readiness flag, and the existing update coalescer inside the Module:

```ts
export function createReadableSurfaceCoordinator(dependencies: ReadableSurfaceDependencies): ReadableSurfaceCoordinator {
	let activeSession: PlaybackSessionSnapshot | null = null;
	let websiteReady = false;

	const deliverWebsiteUpdate = async (message: ReadableSurfaceUpdateMessage) => {
		const session = activeSession;
		if (!session || session.readableSurface !== 'website-dom' || session.source.kind !== 'tab' || !websiteReady) return;
		if (message.sessionId !== session.sessionId) return;
		try {
			await dependencies.sendTabMessage(session.source.tabId, {
				action: 'WORD_HIGHLIGHT_UPDATE',
				sessionId: session.sessionId,
				wordIndex: message.wordIndex,
			});
		} catch {
			websiteReady = false;
		}
	};

	const coalescer = createWordHighlightUpdateCoalescer(
		(operation) => dependencies.enqueue(operation),
		deliverWebsiteUpdate,
	);

	return {
		activate(session) {
			if (activeSession) coalescer.discard(activeSession.sessionId);
			activeSession = session;
			websiteReady = false;
		},
		async initialize(message) {
			const session = activeSession;
			if (!session || message.sessionId !== session.sessionId || session.readableSurface === 'none') {
				return { success: false };
			}
			if (session.readableSurface === 'manual-reader') {
				return { success: session.source.kind === 'manual' };
			}
			if (session.source.kind !== 'tab' || message.contentScope === 'manual') return { success: false };
			try {
				const response = await dependencies.sendTabMessage(session.source.tabId, {
					action: 'WORD_HIGHLIGHT_INIT',
					sessionId: session.sessionId,
					contentScope: message.contentScope,
					words: message.words,
				});
				websiteReady = (response as { success?: unknown } | undefined)?.success === true;
				return { success: websiteReady };
			} catch {
				websiteReady = false;
				return { success: false };
			}
		},
		advance(message) {
			const session = activeSession;
			if (!session || message.sessionId !== session.sessionId || session.readableSurface === 'none') return;
			if (session.readableSurface === 'website-dom') {
				coalescer.submit(message);
				return;
			}
			if (session.source.kind === 'manual') {
				void dependencies.sendRuntimeMessage({
					action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
					sessionId: session.sessionId,
					word: message.word,
					wordIndex: message.wordIndex,
				}).catch(() => undefined);
			}
		},
		async clear(sessionId) {
			const session = activeSession;
			if (!session || session.sessionId !== sessionId) return;
			coalescer.discard(sessionId);
			activeSession = null;
			websiteReady = false;
			try {
				if (session.readableSurface === 'website-dom' && session.source.kind === 'tab') {
					await dependencies.sendTabMessage(session.source.tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId });
				} else if (session.readableSurface === 'manual-reader' && session.source.kind === 'manual') {
					await dependencies.sendRuntimeMessage({ action: 'MANUAL_WORD_HIGHLIGHT_CLEAR', sessionId });
				}
			} catch {
				// Surface failure never interrupts playback cleanup.
			}
		},
	};
}
```

Generalize the coalescer type without changing scheduling or discard behavior:

```ts
type CoalescedWordUpdate = { sessionId: string; wordIndex: number };
type Schedule = (operation: () => Promise<void>) => void;

export function createWordHighlightUpdateCoalescer<T extends CoalescedWordUpdate>(
	schedule: Schedule,
	relay: (message: T) => Promise<void>,
) {
	let latest: T | null = null;
	let scheduled = false;

	function scheduleLatest(): void {
		scheduled = true;
		schedule(async () => {
			try {
				const message = latest;
				latest = null;
				if (message) await relay(message);
			} finally {
				scheduled = false;
				if (latest) scheduleLatest();
			}
		});
	}

	return {
		submit(message: T): void {
			latest = message;
			if (!scheduled) scheduleLatest();
		},
		discard(sessionId: string): void {
			if (latest?.sessionId === sessionId) latest = null;
		},
	};
}
```

The generic preserves the complete canonical update, including `word`, for the coordinator while allowing the existing Website-only tests
to keep using `WordHighlightUpdateMessage`.

- [ ] **Step 4: Run coordinator and coalescer tests**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/readable_surface.test.ts tests/unit/word_highlight_update_coalescer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the deep Module**

```bash
git add src/background/readable_surface.ts src/background/word_highlight_update_coalescer.ts tests/unit/readable_surface.test.ts tests/unit/word_highlight_update_coalescer.test.ts
git commit -m "refactor: deepen readable surface routing"
```

---

### Task 5: Migrate Background, Offscreen, and Side Panel to the Canonical Lifecycle

**Files:**

- Modify: `src/background/background.ts`
- Modify: `src/background/offscreen_transport.ts`
- Modify: `src/offscreen/offscreen.ts`
- Modify: `src/shared/manual_playback.ts`
- Modify: `src/sidepanel/App.tsx`
- Modify test: `tests/unit/manual_playback.test.ts`
- Modify test: `tests/e2e/word-highlight-runtime.spec.ts`
- Modify test: `tests/e2e/word-highlight.spec.ts`
- Modify test: `tests/e2e/side-panel.spec.ts`
- Modify test: `tests/e2e/reading-state.spec.ts`

**Interfaces:**

- Consumes the coordinator from Task 4.
- PLAY payload adds:

```ts
readableSurface: ReadableSurfaceKind;
```

- Offscreen sends only `READABLE_SURFACE_INIT`, `READABLE_SURFACE_UPDATE`, and `READABLE_SURFACE_CLEAR`.
- Content script and Side Panel continue receiving their Adapter-specific messages.

- [ ] **Step 1: Update runtime tests before wiring**

In `tests/e2e/reading-state.spec.ts`, replace the captured offscreen manual event:

```ts
{
	action: 'READABLE_SURFACE_UPDATE',
	sessionId,
	word: 'cat',
	wordIndex: 1,
}
```

Keep the expected Side Panel relay:

```ts
{
	action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
	sessionId,
	word: 'cat',
	wordIndex: 1,
}
```

Add to `tests/e2e/side-panel.spec.ts`:

```ts
await sidePanel.evaluate((activeSessionId) => {
	chrome.runtime.sendMessage({ action: 'MANUAL_WORD_HIGHLIGHT_CLEAR', sessionId: activeSessionId });
}, session.sessionId);
await expect(sidePanel.locator('.manual-reader mark')).toHaveCount(0);
```

Add a Google Docs/PDF assertion that no `READABLE_SURFACE_INIT` message is observed during successful playback while Website real playback
still produces a visible CSS highlight.

- [ ] **Step 2: Run targeted E2E tests and verify old protocol failures**

Run:

```bash
CI=true pnpm exec playwright test tests/e2e/reading-state.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/word-highlight-runtime.spec.ts --retries=0
```

Expected: FAIL because offscreen/background still use `WORD_HIGHLIGHT_*` and `OFFSCREEN_MANUAL_WORD_TIMING`.

- [ ] **Step 3: Wire the background coordinator**

Instantiate once beside the background state queue:

```ts
const readableSurface = createReadableSurfaceCoordinator({
	sendTabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
	sendRuntimeMessage: (message) => chrome.runtime.sendMessage(message),
	enqueue: (operation) => {
		void enqueue(operation);
	},
});
```

Then:

- call `readableSurface.activate(session)` immediately after assigning a newly created or hydrated active session;
- call `await readableSurface.clear(session.sessionId)` on stop, failure, replacement, navigation, and natural completion before discarding owner state;
- include `readableSurface: input.readableSurface` in the PLAY payload;
- replace inline `relayWordHighlightInit`, `relayWordHighlightUpdate`, `relayWordHighlightClear`,
  `relayManualWordHighlight`, `initializedWordHighlightSessionId`, and the background-owned coalescer with:

```ts
case 'READABLE_SURFACE_INIT':
	return respondFromQueue(() => readableSurface.initialize(msg), sendResponse);

case 'READABLE_SURFACE_UPDATE':
	if (isReadableSurfaceUpdateMessage(msg)) readableSurface.advance(msg);
	break;

case 'READABLE_SURFACE_CLEAR':
	if (isReadableSurfaceClearMessage(msg)) void enqueue(() => readableSurface.clear(msg.sessionId));
	break;
```

Do not route canonical messages for inactive or malformed sessions.

- [ ] **Step 4: Migrate offscreen tracking**

Validate `readableSurface` in PLAY input and store it as `currentReadableSurface`. Replace separate generic/manual last-index state with one
last index. Build/init only when the surface is not None:

```ts
const words = currentReadableSurface === 'none' ? [] : buildReadableSurfaceWords(speechUnits);
surfaceReady = false;
if (currentExtensionSessionId && currentReadableSurface !== 'none' && words.length > 0) {
	const response = await chrome.runtime.sendMessage({
		action: 'READABLE_SURFACE_INIT',
		sessionId: currentExtensionSessionId,
		contentScope: data.contentScope ?? 'manual',
		words,
	});
	if (session === playbackSession) surfaceReady = response?.success === true;
}
```

Emit one update shape:

```ts
if (surfaceReady && currentExtensionSessionId && wordIndex !== lastReadableSurfaceWordIndex) {
	lastReadableSurfaceWordIndex = wordIndex;
	void chrome.runtime.sendMessage({
		action: 'READABLE_SURFACE_UPDATE',
		sessionId: currentExtensionSessionId,
		word: wordTiming.text,
		wordIndex,
	}).catch(() => undefined);
}
```

Clear only when ready:

```ts
if (surfaceReady && currentExtensionSessionId) {
	void chrome.runtime
		.sendMessage({ action: 'READABLE_SURFACE_CLEAR', sessionId: currentExtensionSessionId })
		.catch(() => undefined);
}
surfaceReady = false;
```

Manual checkpoint/resume must restore `currentReadableSurface = 'manual-reader'`. Stop/replacement resets it to `none`.

- [ ] **Step 5: Handle owner-scoped manual clear**

Remove `ManualWordTimingMessage`, `isManualWordTimingMessage`, and `OFFSCREEN_MANUAL_WORD_TIMING` from `src/shared/manual_playback.ts`.
Keep `ManualWordHighlightMessage`.

In the Side Panel runtime listener:

```ts
if (value.action === 'MANUAL_WORD_HIGHLIGHT_CLEAR') {
	if (value.sessionId === manualReaderSessionIdRef.current) {
		setManualHighlight(null);
	}
	return;
}
```

Do not clear editor text, checkpoint state, or the cursor for a stale session.

- [ ] **Step 6: Run focused unit and E2E regressions**

Run:

```bash
CI=true pnpm exec node --experimental-strip-types --test tests/unit/manual_playback.test.ts tests/unit/readable_surface.test.ts tests/unit/readable_surface_protocol.test.ts
CI=true pnpm build
CI=true pnpm exec playwright test tests/e2e/word-highlight-runtime.spec.ts tests/e2e/word-highlight.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts --retries=0
```

Expected: PASS; Website and Manual Reader render as before, while Google Docs/PDF emit no projection lifecycle.

- [ ] **Step 7: Commit runtime migration**

```bash
git add src/background/background.ts src/background/offscreen_transport.ts src/offscreen/offscreen.ts src/shared/manual_playback.ts src/sidepanel/App.tsx tests/unit/manual_playback.test.ts tests/e2e/word-highlight-runtime.spec.ts tests/e2e/word-highlight.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts
git commit -m "refactor: route readable surfaces explicitly"
```

---

### Task 6: Verify the Refactor and Refresh Architecture Artifacts

**Files:**

- Verify: `docs/specs/2026-07-28-readable-surface-architecture-design.md`
- Verify: `docs/specs/2026-07-28-google-docs-pdf-highlighting-potential-solutions.md`
- Update generated: `graphify-out/**` through `graphify update .`

**Interfaces:**

- No new runtime Interface.
- Produces verification evidence that all accepted behavior survives the refactor.

- [ ] **Step 1: Run the complete unit suite**

Run:

```bash
CI=true pnpm test:unit
```

Expected: all unit tests pass with no skipped new surface tests.

- [ ] **Step 2: Build and validate the manifest**

Run:

```bash
CI=true pnpm build
CI=true pnpm validate:manifest
```

Expected: TypeScript and Rsbuild succeed; manifest validation passes with no new permission or asset.

- [ ] **Step 3: Run targeted source and surface E2E**

Run:

```bash
CI=true pnpm exec playwright test tests/e2e/reader.spec.ts tests/e2e/pdf-reading.spec.ts tests/e2e/word-highlight-runtime.spec.ts tests/e2e/word-highlight.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts --retries=0
```

Expected: all targeted tests pass.

- [ ] **Step 4: Run the full E2E suite**

Run:

```bash
CI=true pnpm test:e2e
```

Expected: all Playwright tests pass; no focus or persistent-context leak remains.

- [ ] **Step 5: Run formatting and diff validation**

Run:

```bash
pnpm exec biome check src/shared/types.ts src/shared/readable_surface.ts src/shared/word_highlight.ts src/shared/manual_playback.ts src/content/content_script.ts src/content/google_docs_extractor.ts src/content/word_highlight.ts src/background/article_request.ts src/background/pdf_extractor.ts src/background/playback_state.ts src/background/readable_surface.ts src/background/background.ts src/background/offscreen_transport.ts src/background/word_highlight_update_coalescer.ts src/offscreen/offscreen.ts src/sidepanel/App.tsx tests/unit/readable_surface_protocol.test.ts tests/unit/readable_surface.test.ts tests/unit/word_highlight_protocol.test.ts tests/unit/word_highlight_update_coalescer.test.ts tests/unit/google_docs_extractor.test.ts tests/unit/pdf_extractor.test.ts tests/unit/article_request.test.ts tests/unit/playback_state.test.ts tests/unit/manual_playback.test.ts tests/e2e/reader.spec.ts tests/e2e/pdf-reading.spec.ts tests/e2e/word-highlight-runtime.spec.ts tests/e2e/word-highlight.spec.ts tests/e2e/side-panel.spec.ts tests/e2e/reading-state.spec.ts
git diff --check
```

Expected: Biome and diff checks pass.

- [ ] **Step 6: Refresh graphify and prove scope**

Run:

```bash
graphify update .
git diff --name-only
```

Expected: source/tests plus expected generated graph files only. Confirm:

- no manifest permission changed;
- no Google Docs/PDF visual Adapter exists;
- no normalizer, segmentation, speech-unit, word-map, or audio behavior changed;
- `README.md` remains the single domain-language source.

- [ ] **Step 7: Commit verification-only updates if graph files are tracked**

If `graphify update .` produces tracked graph changes:

```bash
git add graphify-out
git commit -m "docs: refresh architecture graph"
```

If graph files remain ignored, do not force-add them and do not create an empty commit.
