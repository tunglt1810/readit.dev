# Translate-then-Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user read any Content Source aloud in Vietnamese, English, or Chinese by translating it with Chrome's built-in Translator API before playback starts.

**Architecture:** Translation happens in the MV3 background worker, between article extraction and session creation. The translated string replaces `Article.content` and the target language replaces `Article.lang`, so every downstream stage — normalization, word map, Document Reader, audio export — runs unchanged. The Document Reader always owns the surface for a translated session. The offscreen document is never modified: the background enriches the snapshot it receives from offscreen with the original text and translation descriptor before handing it to the reader.

**Tech Stack:** TypeScript, React 19, MV3 service worker, Chrome Translator API (`globalThis.Translator`), Chrome Language Detector API (`globalThis.LanguageDetector`), `node:test` for unit tests, Playwright for E2E, Biome for lint.

**Spec:** `docs/specs/2026-08-17-translate-then-read-design.md`

## Global Constraints

- **No Gemini Nano.** Only `Translator` and `LanguageDetector` may be used. Introducing `LanguageModel` or `Summarizer` anywhere in this path violates the spec.
- **Translation targets are exactly `'vi' | 'en' | 'zh'`** — the three languages the Supertonic engine can speak (`MANUAL_LANGUAGES` in `src/background/manual_text.ts`).
- **Chrome only.** Every entry point must feature-detect `globalThis.Translator` and degrade to current behaviour when absent. The Firefox build must keep working.
- **No caching of translations.** No new storage of translated text.
- **Paragraph boundaries must survive translation.** Split on `\n\n`, translate each paragraph, rejoin with `\n\n`.
- **`src/offscreen/` must not be modified.**
- **Minimum source-language confidence is `0.5`.** Below that the source is unknown and no translation happens.
- Run `pnpm lint:fix` before each commit. Unit tests run with `pnpm test:unit`.

---

### Task 1: Translation policy module

Pure decision logic with no browser dependencies, so it can be unit tested directly.

**Files:**
- Create: `src/shared/translation_policy.ts`
- Modify: `src/shared/types.ts` (append after line 21, next to `ResolvedManualTextLanguage`)
- Modify: `src/shared/constants.ts` (add one entry to `STORAGE_KEYS`)
- Test: `tests/unit/translation_policy.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type TranslationTarget = 'vi' | 'en' | 'zh'` (in `src/shared/types.ts`)
  - `interface TranslationInfo { sourceLanguage: string; targetLanguage: TranslationTarget }` (in `src/shared/types.ts`)
  - `TRANSLATION_TARGETS: readonly TranslationTarget[]`
  - `MIN_SOURCE_CONFIDENCE: number`
  - `defaultTranslationTarget(uiLanguage: string): TranslationTarget`
  - `isTranslationTarget(value: unknown): value is TranslationTarget`
  - `resolveTranslationPair(detected: DetectedSourceLanguage | null, target: TranslationTarget): TranslationPair | null`
  - `interface DetectedSourceLanguage { language: string; confidence: number }`
  - `interface TranslationPair { sourceLanguage: string; targetLanguage: TranslationTarget }`
  - `STORAGE_KEYS.TRANSLATION_TARGET` = `'readit_translation_target'`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/translation_policy.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	defaultTranslationTarget,
	isTranslationTarget,
	MIN_SOURCE_CONFIDENCE,
	resolveTranslationPair,
	TRANSLATION_TARGETS,
} from '../../src/shared/translation_policy.ts';

test('offers exactly the three languages the engine can speak', () => {
	assert.deepEqual([...TRANSLATION_TARGETS], ['vi', 'en', 'zh']);
});

test('defaults to the UI language when the engine can speak it', () => {
	assert.equal(defaultTranslationTarget('vi'), 'vi');
	assert.equal(defaultTranslationTarget('en'), 'en');
	assert.equal(defaultTranslationTarget('zh'), 'zh');
});

test('defaults to English when the UI language has no voice', () => {
	assert.equal(defaultTranslationTarget('ja'), 'en');
	assert.equal(defaultTranslationTarget(''), 'en');
});

test('accepts regional UI locales', () => {
	assert.equal(defaultTranslationTarget('vi-VN'), 'vi');
	assert.equal(defaultTranslationTarget('zh-Hans-CN'), 'zh');
});

test('recognises valid targets and rejects anything else', () => {
	assert.equal(isTranslationTarget('vi'), true);
	assert.equal(isTranslationTarget('ja'), false);
	assert.equal(isTranslationTarget(undefined), false);
});

test('resolves a pair when the source differs from the target', () => {
	assert.deepEqual(resolveTranslationPair({ language: 'en', confidence: 1 }, 'vi'), {
		sourceLanguage: 'en',
		targetLanguage: 'vi',
	});
});

test('declines when the source already matches the target', () => {
	assert.equal(resolveTranslationPair({ language: 'vi', confidence: 0.999 }, 'vi'), null);
});

test('declines when the source is a regional variant of the target', () => {
	assert.equal(resolveTranslationPair({ language: 'en-GB', confidence: 1 }, 'en'), null);
});

test('declines when confidence is below the threshold', () => {
	assert.equal(resolveTranslationPair({ language: 'en', confidence: MIN_SOURCE_CONFIDENCE - 0.01 }, 'vi'), null);
});

test('accepts confidence exactly at the threshold', () => {
	assert.notEqual(resolveTranslationPair({ language: 'en', confidence: MIN_SOURCE_CONFIDENCE }, 'vi'), null);
});

test('declines when detection produced nothing', () => {
	assert.equal(resolveTranslationPair(null, 'vi'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — cannot find module `src/shared/translation_policy.ts`

- [ ] **Step 3: Add the shared types**

In `src/shared/types.ts`, directly after the line `export type ResolvedManualTextLanguage = Exclude<ManualTextLanguage, 'auto'>;`:

```ts
/** The languages the Supertonic engine can speak, and therefore the only translation targets. */
export type TranslationTarget = 'vi' | 'en' | 'zh';

export interface TranslationInfo {
	sourceLanguage: string;
	targetLanguage: TranslationTarget;
}
```

In `src/shared/constants.ts`, add to the `STORAGE_KEYS` object, after `PRONUNCIATION_DICTIONARY`:

```ts
	TRANSLATION_TARGET: 'readit_translation_target',
```

- [ ] **Step 4: Write the implementation**

Create `src/shared/translation_policy.ts`:

```ts
import type { TranslationTarget } from './types.ts';

/**
 * Translation targets are limited by the speech engine, not by the Translator API. Chrome can
 * translate into far more languages than Supertonic can pronounce, and a translation nothing can
 * read aloud is worse than no translation.
 */
export const TRANSLATION_TARGETS: readonly TranslationTarget[] = ['vi', 'en', 'zh'];

/**
 * Below this, the detector is guessing. Translating from a guessed source produces confident
 * nonsense, which is the one failure mode a listener cannot catch.
 */
export const MIN_SOURCE_CONFIDENCE = 0.5;

export interface DetectedSourceLanguage {
	language: string;
	confidence: number;
}

export interface TranslationPair {
	sourceLanguage: string;
	targetLanguage: TranslationTarget;
}

export function isTranslationTarget(value: unknown): value is TranslationTarget {
	return typeof value === 'string' && (TRANSLATION_TARGETS as readonly string[]).includes(value);
}

function baseLanguage(tag: string): string {
	return tag.toLowerCase().split('-')[0] ?? '';
}

export function defaultTranslationTarget(uiLanguage: string): TranslationTarget {
	const base = baseLanguage(uiLanguage);
	return isTranslationTarget(base) ? base : 'en';
}

export function resolveTranslationPair(
	detected: DetectedSourceLanguage | null,
	target: TranslationTarget,
): TranslationPair | null {
	if (!detected || detected.confidence < MIN_SOURCE_CONFIDENCE) {
		return null;
	}
	if (baseLanguage(detected.language) === target) {
		return null;
	}
	return { sourceLanguage: detected.language, targetLanguage: target };
}
```

- [ ] **Step 5: Run tests and lint**

Run: `pnpm test:unit && pnpm lint`
Expected: all tests PASS, lint clean

- [ ] **Step 6: Commit**

```bash
git add src/shared/translation_policy.ts src/shared/types.ts src/shared/constants.ts tests/unit/translation_policy.test.ts
git commit -m "feat: add translation policy for target languages and pair resolution"
```

---

### Task 2: Paragraph-preserving article translation

The Translator and Language Detector are injected as dependencies so this module is testable without Chrome.

**Files:**
- Create: `src/background/translate_article.ts`
- Test: `tests/unit/translate_article.test.ts`

**Interfaces:**
- Consumes: `DetectedSourceLanguage`, `TranslationPair`, `TranslationTarget`, `resolveTranslationPair` from Task 1
- Produces:
  - `interface TranslatorLike { translate(input: string): Promise<string> }`
  - `interface TranslationDependencies { detectLanguage(text: string): Promise<DetectedSourceLanguage | null>; createTranslator(pair: TranslationPair): Promise<TranslatorLike> }`
  - `interface TranslatedArticleText { content: string; translation: TranslationInfo }`
  - `translateArticleText(content: string, target: TranslationTarget, dependencies: TranslationDependencies): Promise<TranslatedArticleText | null>` — resolves `null` when no translation should happen
  - `createChromeTranslationDependencies(): TranslationDependencies | null` — `null` when the APIs are absent. `create()` is what triggers the one-off model download for an unused pair, so that call is the whole download story; no monitor is attached, since the project's lint forbids console output
  - `splitParagraphs(content: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/translate_article.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { splitParagraphs, translateArticleText } from '../../src/background/translate_article.ts';
import type { TranslationDependencies } from '../../src/background/translate_article.ts';

function fakeDependencies(options: {
	detected?: { language: string; confidence: number } | null;
	translate?: (input: string) => string;
	onCreate?: () => void;
}): TranslationDependencies {
	return {
		detectLanguage: async () => (options.detected === undefined ? { language: 'en', confidence: 1 } : options.detected),
		createTranslator: async () => {
			options.onCreate?.();
			return { translate: async (input: string) => (options.translate ? options.translate(input) : `[${input}]`) };
		},
	};
}

test('splits on blank lines and drops empty runs', () => {
	assert.deepEqual(splitParagraphs('One.\n\nTwo.\n\n\n\nThree.'), ['One.', 'Two.', 'Three.']);
});

test('treats a document with no blank line as a single paragraph', () => {
	assert.deepEqual(splitParagraphs('Just one line.'), ['Just one line.']);
});

test('translates each paragraph and rejoins with blank lines', async () => {
	const result = await translateArticleText('One.\n\nTwo.', 'vi', fakeDependencies({}));
	assert.equal(result?.content, '[One.]\n\n[Two.]');
});

test('reports the pair it used', async () => {
	const result = await translateArticleText('Hello.', 'vi', fakeDependencies({ detected: { language: 'en', confidence: 0.98 } }));
	assert.deepEqual(result?.translation, { sourceLanguage: 'en', targetLanguage: 'vi' });
});

test('returns null when the source already matches the target', async () => {
	const result = await translateArticleText('Xin chào.', 'vi', fakeDependencies({ detected: { language: 'vi', confidence: 0.99 } }));
	assert.equal(result, null);
});

test('returns null when detection is not confident', async () => {
	const result = await translateArticleText('????', 'vi', fakeDependencies({ detected: { language: 'en', confidence: 0.2 } }));
	assert.equal(result, null);
});

test('returns null when detection produced nothing', async () => {
	const result = await translateArticleText('Hello.', 'vi', fakeDependencies({ detected: null }));
	assert.equal(result, null);
});

test('creates the translator once for the whole document', async () => {
	let creations = 0;
	await translateArticleText('A.\n\nB.\n\nC.', 'vi', fakeDependencies({ onCreate: () => { creations += 1; } }));
	assert.equal(creations, 1);
});

test('preserves paragraph count even when a paragraph translates to empty', async () => {
	const result = await translateArticleText('Keep.\n\nDrop.', 'vi', fakeDependencies({
		translate: (input) => (input === 'Drop.' ? '' : input),
	}));
	assert.equal(result?.content, 'Keep.\n\nDrop.');
});

test('propagates a translator failure rather than returning partial text', async () => {
	const dependencies: TranslationDependencies = {
		detectLanguage: async () => ({ language: 'en', confidence: 1 }),
		createTranslator: async () => ({
			translate: async (input: string) => {
				if (input === 'Two.') throw new Error('model failed');
				return `[${input}]`;
			},
		}),
	};
	await assert.rejects(() => translateArticleText('One.\n\nTwo.', 'vi', dependencies), /model failed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — cannot find module `src/background/translate_article.ts`

- [ ] **Step 3: Write the implementation**

Create `src/background/translate_article.ts`:

```ts
import {
	type DetectedSourceLanguage,
	resolveTranslationPair,
	type TranslationPair,
} from '../shared/translation_policy.ts';
import type { TranslationInfo, TranslationTarget } from '../shared/types.ts';

export interface TranslatorLike {
	translate(input: string): Promise<string>;
}

export interface TranslationDependencies {
	detectLanguage(text: string): Promise<DetectedSourceLanguage | null>;
	createTranslator(pair: TranslationPair): Promise<TranslatorLike>;
}

export interface TranslatedArticleText {
	content: string;
	translation: TranslationInfo;
}

/**
 * The normalizer iterates paragraphs and rejoins them with a blank line, and the Document Reader
 * renders the same string it highlights into. Translating the document as one blob risks the model
 * reflowing or collapsing those breaks, so each paragraph is translated on its own.
 */
export function splitParagraphs(content: string): string[] {
	return content
		.split(/\n\s*\n/u)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
}

export async function translateArticleText(
	content: string,
	target: TranslationTarget,
	dependencies: TranslationDependencies,
): Promise<TranslatedArticleText | null> {
	const detected = await dependencies.detectLanguage(content);
	const pair = resolveTranslationPair(detected, target);
	if (!pair) {
		return null;
	}

	const paragraphs = splitParagraphs(content);
	if (paragraphs.length === 0) {
		return null;
	}

	const translator = await dependencies.createTranslator(pair);
	const translated: string[] = [];
	for (const paragraph of paragraphs) {
		const output = await translator.translate(paragraph);
		// An empty result would silently delete a paragraph and shift every later word range, so the
		// source paragraph is kept instead. Reading it untranslated is recoverable; losing it is not.
		translated.push(output.trim().length > 0 ? output : paragraph);
	}

	return {
		content: translated.join('\n\n'),
		translation: { sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage },
	};
}

/**
 * Binds the module to Chrome's built-in APIs. Returns null on any browser that lacks them, which is
 * how the Firefox build and older Chrome keep their current behaviour.
 */
export function createChromeTranslationDependencies(): TranslationDependencies | null {
	const detector = (globalThis as { LanguageDetector?: { create(): Promise<{ detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>> }> } }).LanguageDetector;
	const translator = (globalThis as { Translator?: { create(options: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorLike> } }).Translator;
	if (!detector || !translator) {
		return null;
	}

	return {
		detectLanguage: async (text) => {
			try {
				const instance = await detector.create();
				const results = await instance.detect(text);
				const best = results[0];
				return best ? { language: best.detectedLanguage, confidence: best.confidence } : null;
			} catch {
				return null;
			}
		},
		createTranslator: (pair) =>
			// A pair the user has not used before is `downloadable`, and this call is what triggers
			// the one-off model download. The wait is covered by the session's existing `loading`
			// status; no `downloadprogress` monitor is attached, because the project forbids console
			// output and nothing else would consume it.
			translator.create({ sourceLanguage: pair.sourceLanguage, targetLanguage: pair.targetLanguage }),
	};
}
```

- [ ] **Step 4: Run tests and lint**

Run: `pnpm test:unit && pnpm lint`
Expected: all tests PASS, lint clean

- [ ] **Step 5: Commit**

```bash
git add src/background/translate_article.ts tests/unit/translate_article.test.ts
git commit -m "feat: translate article text paragraph by paragraph"
```

---

### Task 3: Carry the original text on the Document Reader snapshot

**Files:**
- Modify: `src/shared/document_reader.ts:7-13` (interface) and `:73-98` (validator)
- Test: `tests/unit/document_reader_snapshot.test.ts` (create; existing reader tests live in `tests/unit/readable_surface.test.ts` and stay untouched)

**Interfaces:**
- Consumes: `TranslationInfo` from Task 1
- Produces: `DocumentReaderSnapshot` gains optional `originalContent: string` and `translation: TranslationInfo`. `isDocumentReaderSnapshot()` accepts snapshots with both fields present or both absent, and rejects one without the other.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/document_reader_snapshot.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isDocumentReaderSnapshot } from '../../src/shared/document_reader.ts';

const base = {
	sessionId: 's1',
	title: 'Title',
	content: 'Xin chào thế giới',
	words: [{ text: 'Xin', globalIndex: 0 }],
	currentWordIndex: 0,
};

test('accepts an untranslated snapshot', () => {
	assert.equal(isDocumentReaderSnapshot(base), true);
});

test('accepts a translated snapshot carrying the original text', () => {
	assert.equal(
		isDocumentReaderSnapshot({
			...base,
			originalContent: 'Hello world',
			translation: { sourceLanguage: 'en', targetLanguage: 'vi' },
		}),
		true,
	);
});

test('rejects a translation descriptor without the original text', () => {
	assert.equal(isDocumentReaderSnapshot({ ...base, translation: { sourceLanguage: 'en', targetLanguage: 'vi' } }), false);
});

test('rejects original text without a translation descriptor', () => {
	assert.equal(isDocumentReaderSnapshot({ ...base, originalContent: 'Hello world' }), false);
});

test('rejects an unsupported target language', () => {
	assert.equal(
		isDocumentReaderSnapshot({
			...base,
			originalContent: 'Hello world',
			translation: { sourceLanguage: 'en', targetLanguage: 'ja' },
		}),
		false,
	);
});

test('still rejects unknown fields', () => {
	assert.equal(isDocumentReaderSnapshot({ ...base, surpriseField: true }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — the translated snapshot is rejected, because the current validator asserts `Object.keys(snapshot).length === 5`

- [ ] **Step 3: Extend the interface**

In `src/shared/document_reader.ts`, add the import at the top of the file alongside the existing `ReadableSurfaceWord` import:

```ts
import type { TranslationInfo } from './types.ts';
```

Replace the `DocumentReaderSnapshot` interface (currently lines 7-13) with:

```ts
export interface DocumentReaderSnapshot {
	sessionId: string;
	title: string;
	content: string;
	words: readonly ReadableSurfaceWord[];
	currentWordIndex: number;
	/** The pre-translation text, present only on a translated session. */
	originalContent?: string;
	/** Which pair produced `content`, present only on a translated session. */
	translation?: TranslationInfo;
}
```

- [ ] **Step 4: Replace the key-count check in the validator**

In `src/shared/document_reader.ts`, add above `isDocumentReaderSnapshot`:

```ts
const SNAPSHOT_KEYS = new Set([
	'sessionId',
	'title',
	'content',
	'words',
	'currentWordIndex',
	'originalContent',
	'translation',
]);

const TRANSLATION_TARGETS = new Set(['vi', 'en', 'zh']);

function isTranslationInfo(value: unknown): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const info = value as Record<string, unknown>;
	return (
		typeof info.sourceLanguage === 'string' &&
		info.sourceLanguage.length > 0 &&
		typeof info.targetLanguage === 'string' &&
		TRANSLATION_TARGETS.has(info.targetLanguage) &&
		Object.keys(info).length === 2
	);
}
```

Then in `isDocumentReaderSnapshot`, replace the final clause `Object.keys(snapshot).length === 5` with:

```ts
		Object.keys(snapshot).every((key) => SNAPSHOT_KEYS.has(key)) &&
		// Both translation fields travel together: the banner needs the descriptor and the
		// "view original" panel needs the text, and one without the other is a bug upstream.
		('originalContent' in snapshot) === ('translation' in snapshot) &&
		(!('translation' in snapshot) ||
			(typeof snapshot.originalContent === 'string' && isTranslationInfo(snapshot.translation)))
```

- [ ] **Step 5: Run tests and lint**

Run: `pnpm test:unit && pnpm lint`
Expected: all tests PASS — including the pre-existing `tests/unit/readable_surface.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/shared/document_reader.ts tests/unit/document_reader_snapshot.test.ts
git commit -m "feat: carry original text and translation pair on reader snapshots"
```

---

### Task 4: Wire translation into the background worker

**Files:**
- Modify: `src/background/background.ts` — the `requestDocumentReaderSnapshot` dependency at `:157-163`, `startCurrentPage()` at `:1012-1078`, and the message switch at `:1619`
- Modify: `src/shared/types.ts` — add the command message type

**Interfaces:**
- Consumes: `translateArticleText`, `createChromeTranslationDependencies` (Task 2); `defaultTranslationTarget`, `isTranslationTarget` (Task 1)
- Produces:
  - Message action `'START_CURRENT_PAGE_TRANSLATED'`, no payload, returning `CommandResponse`
  - Module-level `activeTranslation: { originalContent: string; translation: TranslationInfo } | null`, cleared whenever a session stops or is replaced
  - `readTranslationTarget(): Promise<TranslationTarget>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/translation_target_store.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { pickStoredTranslationTarget } from '../../src/background/translation_target_store.ts';

test('uses the stored value when it names a speakable language', () => {
	assert.equal(pickStoredTranslationTarget('zh', 'en'), 'zh');
});

test('falls back to the UI default when nothing is stored', () => {
	assert.equal(pickStoredTranslationTarget(undefined, 'vi'), 'vi');
});

test('falls back to the UI default when the stored value is stale or invalid', () => {
	assert.equal(pickStoredTranslationTarget('ja', 'vi'), 'vi');
	assert.equal(pickStoredTranslationTarget(42, 'en'), 'en');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — cannot find module `src/background/translation_target_store.ts`

- [ ] **Step 3: Write the store**

Create `src/background/translation_target_store.ts`:

```ts
import { STORAGE_KEYS } from '../shared/constants.ts';
import { getUiLanguage } from '../shared/i18n.ts';
import { browserStorage } from '../shared/storage.ts';
import { defaultTranslationTarget, isTranslationTarget } from '../shared/translation_policy.ts';
import type { TranslationTarget } from '../shared/types.ts';

/** Split out from the storage read so the fallback chain can be tested without `chrome`. */
export function pickStoredTranslationTarget(stored: unknown, uiLanguage: string): TranslationTarget {
	return isTranslationTarget(stored) ? stored : defaultTranslationTarget(uiLanguage);
}

export async function readTranslationTarget(): Promise<TranslationTarget> {
	const items = await browserStorage.get(STORAGE_KEYS.TRANSLATION_TARGET);
	return pickStoredTranslationTarget(items[STORAGE_KEYS.TRANSLATION_TARGET], getUiLanguage());
}

export async function writeTranslationTarget(target: TranslationTarget): Promise<void> {
	await browserStorage.set({ [STORAGE_KEYS.TRANSLATION_TARGET]: target });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Put the translation step inside `startPlayback()`**

Every reading path converges on `startPlayback()` at `:831` — current page (`:1066`), manual text (`:1128`), reader content for local EPUB/PDF/DOCX (`:1629`), and selection (`:1683`, `:1996`). Putting the translation there means the remaining sources need only pass a flag when they grow their own entry point, rather than each repeating the logic.

In `src/background/background.ts`, add to the imports:

```ts
import { createChromeTranslationDependencies, translateArticleText } from './translate_article.ts';
import { readTranslationTarget } from './translation_target_store.ts';
import type { TranslationInfo } from '../shared/types.ts';
```

Add `translate` to the `'article'` variant of `StartPlaybackInput` at `:113`:

```ts
	| {
			contentScope: 'article';
			source: { kind: 'tab'; tabId: number; title: string; url: string };
			content: PlaybackContent;
			readableSurface: 'website-dom' | 'document-reader' | 'none';
			queueItemId?: string;
			/** Translate before speaking. Only the article scope supports it today. */
			translate?: boolean;
	  }
```

Add a module-level variable next to the other session state:

```ts
/**
 * The pre-translation text for the active session. The offscreen document builds reader snapshots
 * and knows nothing about translation, so the background attaches this on the way out.
 */
let activeTranslation: { originalContent: string; translation: TranslationInfo } | null = null;
```

Add this helper above `startPlayback`:

```ts
/**
 * Resolves the content a session should actually speak. Returns the input unchanged whenever
 * translation is not asked for, not possible, or not useful — a source already in the target
 * language is read as-is rather than round-tripped through the model.
 */
async function resolveTranslatedContent(
	input: StartPlaybackInput,
): Promise<{ content: PlaybackContent; readableSurface: StartPlaybackInput['readableSurface'] } | { failed: true }> {
	const unchanged = { content: input.content, readableSurface: input.readableSurface };
	if (input.contentScope !== 'article' || !input.translate) {
		return unchanged;
	}
	const dependencies = createChromeTranslationDependencies();
	if (!dependencies) {
		return unchanged;
	}

	const target = await readTranslationTarget();
	try {
		const translated = await translateArticleText(input.content.content, target, dependencies);
		if (!translated) {
			return unchanged;
		}
		activeTranslation = { originalContent: input.content.content, translation: translated.translation };
		return {
			content: { ...input.content, content: translated.content, lang: translated.translation.targetLanguage },
			// A translation cannot be highlighted onto the original page DOM, so it always reads in
			// the Document Reader.
			readableSurface: 'document-reader',
		};
	} catch {
		return { failed: true };
	}
}
```

Inside `startPlayback()`, immediately after the `stopActiveSession('session-replaced')` calls at the top of the function complete (so a failure leaves no half-started session), insert:

```ts
	activeTranslation = null;
	const resolved = await resolveTranslatedContent(input);
	if ('failed' in resolved) {
		return { success: false, error: ERROR_MESSAGES.translationFailed };
	}
```

Then, everywhere further down `startPlayback()` that reads `input.content` or `input.readableSurface`, use `resolved.content` and `resolved.readableSurface` instead. Read the whole function body before editing — the session object it builds and the payload it sends to offscreen both consume these.

- [ ] **Step 6: Pass the flag from the current-page path**

In `src/background/background.ts`, change the `startCurrentPage` signature at `:1012`:

```ts
async function startCurrentPage(
	targetTabId?: number,
	queueItemId?: string,
	fallbackUrl?: string,
	translate = false,
): Promise<CommandResponse> {
```

and add `translate` to the object it passes to `startPlayback` at `:1066`:

```ts
		content: articleResponse.article,
		readableSurface: articleResponse.readableSurface,
		translate,
		...(queueItemId ? { queueItemId } : {}),
```

- [ ] **Step 7: Attach the original text to outgoing snapshots**

In `src/background/background.ts`, replace the `requestDocumentReaderSnapshot` dependency body (currently `:157-163`) with:

```ts
	requestDocumentReaderSnapshot: async (sessionId) => {
		const response = await sendOffscreenCommand(
			{ action: 'GET_DOCUMENT_READER_SNAPSHOT', payload: { sessionId } },
			sendAudioHostCommand,
		);
		const snapshot = response.success ? (response.snapshot ?? null) : null;
		if (!snapshot || !activeTranslation) {
			return snapshot;
		}
		return {
			...snapshot,
			originalContent: activeTranslation.originalContent,
			translation: activeTranslation.translation,
		};
	},
```

- [ ] **Step 8: Clear the translation when the session ends**

In `src/background/background.ts`, inside `stopActiveSession()` (starts at `:705`), add `activeTranslation = null;` alongside the existing session teardown.

- [ ] **Step 9: Register the message action**

In `src/background/background.ts`, in the switch inside `handleBackgroundMessage()`, directly after `case 'START_CURRENT_PAGE':`:

```ts
			case 'START_CURRENT_PAGE_TRANSLATED':
				return startCurrentPage(undefined, undefined, undefined, true);
```

Add the error message to the existing `ERROR_MESSAGES` object in the same file:

```ts
	translationFailed: 'TRANSLATION_FAILED',
```

- [ ] **Step 10: Map the error to a message**

In `src/shared/i18n.ts`, add to the switch in `getPlaybackErrorTranslationKey`:

```ts
		case 'TRANSLATION_FAILED':
			return 'translationFailed';
```

Add to both `src/shared/locales/en.json` and `src/shared/locales/vi.json`:

```json
	"translationFailed": "Could not translate this page."
```

```json
	"translationFailed": "Không dịch được trang này."
```

- [ ] **Step 11: Build and verify**

Run: `pnpm build:chrome && pnpm build:firefox && pnpm lint`
Expected: both builds succeed, lint clean. The Firefox build must succeed even though it will never have `Translator`.

- [ ] **Step 12: Commit**

```bash
git add src/background/background.ts src/background/translation_target_store.ts src/shared/i18n.ts src/shared/locales/en.json src/shared/locales/vi.json tests/unit/translation_target_store.test.ts
git commit -m "feat: start a translated reading session from the background"
```

---

### Task 5: Target language setting

**Files:**
- Modify: `src/settings/SettingsApp.tsx`
- Modify: `src/shared/locales/en.json`, `src/shared/locales/vi.json`

**Interfaces:**
- Consumes: `TRANSLATION_TARGETS`, `isTranslationTarget` (Task 1); `readTranslationTarget`, `writeTranslationTarget` (Task 4)
- Produces: a persisted `STORAGE_KEYS.TRANSLATION_TARGET` value the background reads

- [ ] **Step 1: Add the strings**

To `src/shared/locales/en.json`:

```json
	"translationSectionTitle": "Translation",
	"translationTargetLabel": "Translate into",
	"translationTargetHelp": "Only languages the reader can speak are listed.",
	"translationLanguageVi": "Vietnamese",
	"translationLanguageEn": "English",
	"translationLanguageZh": "Chinese"
```

To `src/shared/locales/vi.json`:

```json
	"translationSectionTitle": "Dịch",
	"translationTargetLabel": "Dịch sang",
	"translationTargetHelp": "Chỉ liệt kê những ngôn ngữ trình đọc phát âm được.",
	"translationLanguageVi": "Tiếng Việt",
	"translationLanguageEn": "Tiếng Anh",
	"translationLanguageZh": "Tiếng Trung"
```

- [ ] **Step 2: Add the setting to the Settings page**

In `src/settings/SettingsApp.tsx`, add the imports:

```ts
import { readTranslationTarget, writeTranslationTarget } from '../background/translation_target_store.ts';
import { TRANSLATION_TARGETS, isTranslationTarget } from '../shared/translation_policy.ts';
import type { TranslationTarget } from '../shared/types.ts';
```

Add a component above the main settings component:

```tsx
function targetLabel(target: TranslationTarget): string {
	if (target === 'vi') return t('translationLanguageVi');
	if (target === 'zh') return t('translationLanguageZh');
	return t('translationLanguageEn');
}

function TranslationSettings() {
	const [target, setTarget] = useState<TranslationTarget | null>(null);

	useEffect(() => {
		void readTranslationTarget().then(setTarget);
	}, []);

	// The Translator API is Chrome-only; on Firefox the section would promise something the
	// browser cannot do.
	if (typeof globalThis.Translator === 'undefined' || target === null) {
		return null;
	}

	const handleChange = (value: string) => {
		if (!isTranslationTarget(value)) return;
		setTarget(value);
		void writeTranslationTarget(value);
	};

	return (
		<section className="settings-section">
			<h2>{t('translationSectionTitle')}</h2>
			<label className="rule-edit-field">
				<span>{t('translationTargetLabel')}</span>
				<select aria-label={t('translationTargetLabel')} value={target} onChange={(e) => handleChange(e.target.value)}>
					{TRANSLATION_TARGETS.map((option) => (
						<option key={option} value={option}>
							{targetLabel(option)}
						</option>
					))}
				</select>
			</label>
			<p className="settings-help">{t('translationTargetHelp')}</p>
		</section>
	);
}
```

Render `<TranslationSettings />` inside the settings page's top-level element, after the existing pronunciation dictionary section.

- [ ] **Step 3: Build and check by hand**

Run: `pnpm build:chrome`
Then load `dist/chrome` unpacked in Chrome, open the extension's Settings page, and confirm: the Translation section appears, lists three languages, and the choice survives a page reload.

- [ ] **Step 4: Commit**

```bash
git add src/settings/SettingsApp.tsx src/shared/locales/en.json src/shared/locales/vi.json
git commit -m "feat: add a translation target setting"
```

---

### Task 6: Translate & read button

**Files:**
- Modify: `src/popup/App.tsx` — near `handleReadCurrentPage` at `:230-233` and the button at `:474-476`
- Modify: `src/sidepanel/` — the equivalent read control
- Modify: `src/shared/locales/en.json`, `src/shared/locales/vi.json`

**Interfaces:**
- Consumes: message action `'START_CURRENT_PAGE_TRANSLATED'` (Task 4)
- Produces: nothing other tasks depend on

- [ ] **Step 1: Add the strings**

To `src/shared/locales/en.json`:

```json
	"translateAndRead": "Translate & read"
```

To `src/shared/locales/vi.json`:

```json
	"translateAndRead": "Dịch & đọc"
```

- [ ] **Step 2: Add the handler and button in the popup**

In `src/popup/App.tsx`, next to `handleReadCurrentPage`:

```tsx
	const canTranslate = typeof globalThis.Translator !== 'undefined';

	const handleTranslateAndRead = () => {
		setModelError('');
		setCommandError('');
		void sendPlaybackCommand({ action: 'START_CURRENT_PAGE_TRANSLATED' }).then((response) => {
			if (!response?.success) {
				setCommandError(getLocalizedPlaybackError(response?.error) ?? t('startReadingFailed'));
			}
		});
	};
```

Directly after the existing `btn-read-current-page` button:

```tsx
					{canTranslate && (
						<button className="btn btn-secondary btn-translate-read" onClick={handleTranslateAndRead}>
							{t('translateAndRead')}
						</button>
					)}
```

- [ ] **Step 3: Mirror it in the side panel**

In `src/sidepanel/App.tsx`, directly after `handleReadCurrentPage` (which ends at `:355`):

```tsx
	const canTranslate = typeof globalThis.Translator !== 'undefined';

	const handleTranslateAndRead = async () => {
		setCommandError('');
		const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE_TRANSLATED' });
		if (!response.success) {
			setCommandError(
				response.transportError
					? t('startReadingFailed')
					: (getLocalizedPlaybackError(response.error) ?? t('startReadingFailed')),
			);
		}
	};
```

Then find the button whose `onClick` is `handleReadCurrentPage` and add immediately after it:

```tsx
				{canTranslate && (
					<button className="btn btn-secondary btn-translate-read" onClick={handleTranslateAndRead}>
						{t('translateAndRead')}
					</button>
				)}
```

- [ ] **Step 4: Build and check by hand**

Run: `pnpm build:chrome`
Load `dist/chrome` unpacked, open an English article, and press **Translate & read** from both the popup and the side panel. Expect the Document Reader to open and read the article in the configured target language.

- [ ] **Step 5: Commit**

```bash
git add src/popup/App.tsx src/sidepanel src/shared/locales/en.json src/shared/locales/vi.json
git commit -m "feat: add a translate and read button to the popup and side panel"
```

---

### Task 7: Disclaimer banner and original-text panel

**Files:**
- Modify: `src/reader/App.tsx` — snapshot state at `:65`, content render at `:605-606`
- Modify: `src/shared/locales/en.json`, `src/shared/locales/vi.json`
- Modify: the Document Reader stylesheet used by `src/reader/`

**Interfaces:**
- Consumes: `DocumentReaderSnapshot.originalContent` and `.translation` (Task 3)
- Produces: nothing other tasks depend on

- [ ] **Step 1: Add the strings**

To `src/shared/locales/en.json`:

```json
	"translationNoticeTitle": "Automatic translation",
	"translationNoticeBody": "Translated on your device by Chrome Translator. Machine translation can get the meaning wrong.",
	"translationViewOriginal": "View original",
	"translationHideOriginal": "Hide original",
	"translationOriginalHeading": "Original text"
```

To `src/shared/locales/vi.json`:

```json
	"translationNoticeTitle": "Bản dịch tự động",
	"translationNoticeBody": "Dịch trên máy bằng Chrome Translator. Dịch máy có thể sai nghĩa.",
	"translationViewOriginal": "Xem bản gốc",
	"translationHideOriginal": "Ẩn bản gốc",
	"translationOriginalHeading": "Văn bản gốc"
```

- [ ] **Step 2: Render the banner**

In `src/reader/App.tsx`, add state beside the existing snapshot state:

```tsx
	const [showOriginal, setShowOriginal] = useState(false);
```

Reset it whenever a new snapshot arrives — in the `DOCUMENT_READER_SNAPSHOT` branch that already calls `setSnapshot(message.snapshot)`, add:

```tsx
				setShowOriginal(false);
```

Immediately before the `<article ref={contentRef} className="document-reader-content">` element:

```tsx
					{snapshot.translation && snapshot.originalContent && (
						<aside className="translation-notice">
							<h2>{t('translationNoticeTitle')}</h2>
							<p>
								{t('translationNoticeBody')}{' '}
								<span className="translation-notice-pair">
									({snapshot.translation.sourceLanguage} → {snapshot.translation.targetLanguage})
								</span>
							</p>
							<button type="button" onClick={() => setShowOriginal((shown) => !shown)}>
								{showOriginal ? t('translationHideOriginal') : t('translationViewOriginal')}
							</button>
							{showOriginal && (
								<div className="translation-original">
									<h3>{t('translationOriginalHeading')}</h3>
									<p>{snapshot.originalContent}</p>
								</div>
							)}
						</aside>
					)}
```

The original text sits in its own panel rather than replacing the content element, because `contentRef.current?.firstChild` (used at `:192` for highlight positioning) must keep pointing at the text being read.

- [ ] **Step 3: Style the banner**

Append to `src/reader/reader.css`, following the `.document-reader-*` conventions already in that file:

```css
.translation-notice {
	margin: 0 0 1.5rem;
	padding: 0.875rem 1rem;
	border: 1px solid var(--border-color, #d0d0d0);
	border-left-width: 4px;
	border-radius: 6px;
	background: var(--surface-muted, #f6f6f6);
	font-size: 0.9rem;
}

.translation-notice h2 {
	margin: 0 0 0.375rem;
	font-size: 0.95rem;
}

.translation-notice p {
	margin: 0 0 0.625rem;
}

.translation-notice-pair {
	font-variant-numeric: tabular-nums;
	opacity: 0.75;
}

.translation-original {
	margin-top: 0.875rem;
	padding-top: 0.875rem;
	border-top: 1px solid var(--border-color, #d0d0d0);
	white-space: pre-wrap;
}

.translation-original h3 {
	margin: 0 0 0.5rem;
	font-size: 0.9rem;
}
```

The banner must not be mistaken for article content, and must stay readable in all three themes (`default`, `winamp`, `wmp12`). Check each theme in Step 4; if a theme overrides the CSS variables used above in a way that makes the banner illegible, add a theme-scoped rule beside the existing theme overrides in this file.

- [ ] **Step 4: Build and check by hand**

Run: `pnpm build:chrome`
Load unpacked, translate an English article, and confirm: the banner names the pair, word highlighting still tracks the translated text, **View original** reveals the English text and toggles closed, and highlighting is unaffected while the panel is open.

- [ ] **Step 5: Commit**

```bash
git add src/reader src/shared/locales/en.json src/shared/locales/vi.json
git commit -m "feat: show a machine-translation notice with the original text in the reader"
```

---

### Task 8: End-to-end coverage with a stubbed Translator

Playwright drives bundled Chromium, where `globalThis.Translator` does not exist. These tests verify the wiring, not the translation.

**Files:**
- Create: `tests/e2e/translate-and-read.spec.ts`
- Modify: `tests/e2e/fixtures.ts` — add a helper beside the existing `installExtensionUiRuntimeMock`

**Interfaces:**
- Consumes: everything above
- Produces: `installTranslatorStub(page: Page, translations: Record<string, string>): Promise<void>`

- [ ] **Step 1: Add the stub helper**

In `tests/e2e/fixtures.ts`:

```ts
/**
 * Bundled Chromium has no built-in AI at all, so E2E cannot exercise the real Translator. This
 * stub asserts the wiring around it: which surface is used, what the banner says, and that
 * highlighting follows the translated text.
 */
export async function installTranslatorStub(page: Page, translations: Record<string, string>): Promise<void> {
	await page.addInitScript((table: Record<string, string>) => {
		(globalThis as Record<string, unknown>).LanguageDetector = {
			create: async () => ({
				detect: async () => [{ detectedLanguage: 'en', confidence: 0.99 }],
			}),
		};
		(globalThis as Record<string, unknown>).Translator = {
			availability: async () => 'available',
			create: async () => ({
				translate: async (input: string) => table[input] ?? `VI:${input}`,
			}),
		};
	}, translations);
}
```

- [ ] **Step 2: Write the E2E test**

Create `tests/e2e/translate-and-read.spec.ts`. Open `tests/e2e/side-panel.spec.ts` first and match its imports, its `test` fixture, and the way it opens extension pages — the skeleton below uses the shared fixture but the exact page-opening helper must match what that file already does.

```ts
import { expect } from '@playwright/test';
import { installTranslatorStub, test } from './fixtures';

const ENGLISH = 'The committee met to review the proposal.';
const VIETNAMESE = 'Ủy ban đã họp để xem xét đề xuất.';

test.describe('translate and read', () => {
	test('hides the button when the browser has no Translator', async ({ context, extensionId }) => {
		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await expect(popup.locator('.btn-translate-read')).toHaveCount(0);
	});

	test('reads the translated text in the Document Reader', async ({ context, extensionId }) => {
		const article = await context.newPage();
		await article.route('https://readit.test/article', (route) =>
			route.fulfill({
				contentType: 'text/html',
				body: `<!doctype html><html lang="en"><body><article><p>${ENGLISH}</p></article></body></html>`,
			}),
		);
		await article.goto('https://readit.test/article');

		const popup = await context.newPage();
		await installTranslatorStub(popup, { [ENGLISH]: VIETNAMESE });
		await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

		await popup.locator('.btn-translate-read').click();

		const reader = await context.waitForEvent('page');
		await expect(reader.locator('.document-reader-content')).toContainText(VIETNAMESE);
		await expect(reader.locator('.document-reader-content')).not.toContainText(ENGLISH);
	});

	test('names the language pair in the notice', async ({ context, extensionId }) => {
		const reader = await openTranslatedReader(context, extensionId);
		await expect(reader.locator('.translation-notice')).toBeVisible();
		await expect(reader.locator('.translation-notice-pair')).toContainText('en');
		await expect(reader.locator('.translation-notice-pair')).toContainText('vi');
	});

	test('toggles the original text', async ({ context, extensionId }) => {
		const reader = await openTranslatedReader(context, extensionId);
		await expect(reader.locator('.translation-original')).toHaveCount(0);

		await reader.locator('.translation-notice button').click();
		await expect(reader.locator('.translation-original')).toContainText(ENGLISH);

		await reader.locator('.translation-notice button').click();
		await expect(reader.locator('.translation-original')).toHaveCount(0);
	});

	test('highlights words in the translated text', async ({ context, extensionId }) => {
		const reader = await openTranslatedReader(context, extensionId);
		const highlighted = reader.locator('.document-reader-content .word-highlight');
		await expect(highlighted).toBeVisible();
		await expect(highlighted).not.toHaveText('');
	});
});
```

Extract the repeated setup into an `openTranslatedReader(context, extensionId)` helper in this same file — it performs the article-route, stub-install, popup-open, and click sequence from the second test, then returns the reader page from `context.waitForEvent('page')`. Confirm `.word-highlight` matches the class the reader actually applies; if it differs, use the real one.

- [ ] **Step 3: Rebuild before running**

Run: `pnpm build:chrome && pnpm test:e2e -- tests/e2e/translate-and-read.spec.ts`
Expected: PASS. The rebuild is mandatory — Playwright loads `dist/chrome`, so a stale build silently tests the previous code.

- [ ] **Step 4: Full suite**

Run: `pnpm build && pnpm test:unit && pnpm test:e2e && pnpm lint`
Expected: all PASS

- [ ] **Step 5: Manual verification against real Chrome**

The automated suite cannot prove translation works. In real Chrome, with the extension loaded unpacked:

1. Open an English news article, press **Translate & read**, confirm it reads Vietnamese and the highlight tracks correctly.
2. Open a Vietnamese article with the target set to English, confirm the reverse.
3. Set the target to the page's own language and confirm it reads the original with no banner.
4. Open a local EPUB, translate a chapter, turn the page, and confirm the next chapter translates too.
5. Reopen that EPUB reading the original and confirm it starts at the chapter beginning rather than at the translated offset.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/translate-and-read.spec.ts tests/e2e/fixtures.ts
git commit -m "test: cover the translate and read flow end to end"
```
