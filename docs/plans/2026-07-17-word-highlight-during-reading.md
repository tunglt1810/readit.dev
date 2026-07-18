# Currently Spoken Word Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Specification:** [`docs/specs/2026-07-17-word-highlight-during-reading-design.md`](../specs/2026-07-17-word-highlight-during-reading-design.md)

**Goal:** Implement the approved currently spoken word highlight design and its strict selected-text scope correction.

**Tech Stack:** TypeScript 6 strict, React 19 (popup), Rsbuild/Rspack, Chrome Extension Manifest V3 (content script, background service worker, and offscreen document), CSS Custom Highlight API, Node's built-in test runner (`node --experimental-strip-types --test`) for unit tests, and Playwright for E2E tests.

---

## File Structure

| File | Change |
|---|---|
| `src/offscreen/vietnamese/types.ts` | Modify — add `WordMapEntry` and extend `NormalizationResult` |
| `src/offscreen/vietnamese/normalizer.ts` | Modify — build the word map while expanding each paragraph |
| `src/offscreen/word_map.ts` | **Create** — attach word maps to Vietnamese and Latin `SpeechUnit[]` values |
| `src/offscreen/speech_unit.ts` | Modify — add the optional `wordMap` field |
| `src/offscreen/playback_preparation.ts` | Modify — call `attachPlainWordMap` or `attachNormalizedWordMap` |
| `src/offscreen/word_timing.ts` | **Create** — estimate per-word time windows and resolve the current word from elapsed time |
| `src/offscreen/offscreen.ts` | Modify — report the currently spoken word from a polling loop through `chrome.runtime.sendMessage` |
| `src/shared/word_highlight.ts` | **Create** — define the message contract, highlight registry name, and setting helper |
| `src/shared/constants.ts` | Modify — add `STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED` and localized strings |
| `src/background/background.ts` | Modify — relay messages to the owning tab |
| `src/content/article_extractor.ts` | Modify — export `isWithinNoiseRegion` for a reusable non-mutating content-script noise check |
| `src/content/reading_anchor.ts` | **Create** — share the `Range` that initiated selected-text playback |
| `src/content/selection_button.ts` | Modify — capture the selected `Range` before sending `START_SELECTED_TEXT` |
| `src/content/word_highlight.ts` | **Create** — implement sequential `TreeWalker` search and CSS Custom Highlight rendering |
| `src/content/content_script.ts` | Modify — register `installWordHighlight()` |
| `src/popup/App.tsx` | Modify — add an enable/disable switch |
| `tests/unit/word_map.test.ts` | **Create** |
| `tests/unit/word_timing.test.ts` | **Create** |
| `tests/unit/vietnamese_normalizer.test.ts` | Modify — add `wordMap` tests |
| `tests/unit/playback_preparation.test.ts` | Modify — migrate assertions and add `wordMap` tests |
| `tests/e2e/word-highlight.spec.ts` | **Create** |

---

### Task 1: Vietnamese normalizer — word map

**Files:**
- Modify: `src/offscreen/vietnamese/types.ts:56-69`
- Modify: `src/offscreen/vietnamese/normalizer.ts`
- Test: `tests/unit/vietnamese_normalizer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these cases to `tests/unit/vietnamese_normalizer.test.ts` after the existing final test:

```ts
test('builds a word map that groups an expanded date span back to its original token', async () => {
	const dependencies = createTestNormalizationDependencies();
	const result = await normalizeVietnameseText('Có 11/07/2026.', dependencies);
	assert.equal(result.text, 'Có mười một tháng bảy năm hai nghìn không trăm hai mươi sáu.');
	const dateEntry = result.wordMap.find((entry) => entry.originalText === '11/07/2026');
	assert.ok(dateEntry, 'expected a word map entry for the original date token');
	assert.equal(
		result.text.slice(dateEntry.spokenStart, dateEntry.spokenEnd),
		'mười một tháng bảy năm hai nghìn không trăm hai mươi sáu',
	);
	const plainEntry = result.wordMap.find((entry) => entry.originalText === 'Có');
	assert.ok(plainEntry, 'expected a word map entry for the plain leading word');
	assert.equal(result.text.slice(plainEntry.spokenStart, plainEntry.spokenEnd), 'Có');
});

test('accounts for the paragraph separator when computing word map offsets across paragraphs', async () => {
	const dependencies = createTestNormalizationDependencies();
	const result = await normalizeVietnameseText('Mở đầu.\n\nĐH kết thúc.', dependencies);
	const abbrevEntry = result.wordMap.find((entry) => entry.originalText === 'ĐH');
	assert.ok(abbrevEntry, 'expected a word map entry for the abbreviation in the second paragraph');
	assert.equal(result.text.slice(abbrevEntry.spokenStart, abbrevEntry.spokenEnd), 'đại học');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/unit/vietnamese_normalizer.test.ts`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'find')` because `result.wordMap` does not exist yet.

- [ ] **Step 3: Extend `NormalizationResult` with a word map**

In `src/offscreen/vietnamese/types.ts`, replace lines 56-69:

```ts
export interface NormalizationDiagnostics {
	tokenCount: number;
	crfMs: number;
	expansionMs: number;
	totalMs: number;
	usedCrf: boolean;
	usedAbbreviationScorer: boolean;
	fallbackReason?: string;
}

export interface NormalizationResult {
	text: string;
	diagnostics: NormalizationDiagnostics;
}
```

with:

```ts
export interface NormalizationDiagnostics {
	tokenCount: number;
	crfMs: number;
	expansionMs: number;
	totalMs: number;
	usedCrf: boolean;
	usedAbbreviationScorer: boolean;
	fallbackReason?: string;
}

export interface WordMapEntry {
	originalText: string;
	originalStart: number;
	originalEnd: number;
	spokenStart: number;
	spokenEnd: number;
}

export interface NormalizationResult {
	text: string;
	wordMap: readonly WordMapEntry[];
	diagnostics: NormalizationDiagnostics;
}
```

- [ ] **Step 4: Build the word map while expanding each paragraph**

In `src/offscreen/vietnamese/normalizer.ts`, add `WordMapEntry` to the type import (line 10-18):

```ts
import type {
	CheckpointLabel,
	DetectedSpan,
	NormalizationDependencies,
	NormalizationResult,
	SourceToken,
	TokenizedParagraph,
	VietnameseNormalizerAssets,
	WordMapEntry,
} from './types.ts';
```

Replace `expandParagraph` (lines 128-185) with:

```ts
async function expandParagraph(
	paragraph: TokenizedParagraph,
	labels: readonly CheckpointLabel[],
	dependencies: NormalizationDependencies,
): Promise<{ text: string; wordMap: WordMapEntry[]; usedAbbreviationScorer: boolean }> {
	const spans = reconstructDetectedSpans(labels);
	const spansByStart = new Map(spans.map((span) => [span.startToken, span]));
	const output: string[] = [];
	const wordMap: WordMapEntry[] = [];
	let cursor = 0;
	let usedAbbreviationScorer = false;
	for (let index = 0; index < paragraph.tokens.length; ) {
		const token = paragraph.tokens[index];
		const span = spansByStart.get(index);
		if (!span) {
			output.push(token.leading, token.original);
			cursor += token.leading.length;
			wordMap.push({
				originalText: token.original,
				originalStart: token.start,
				originalEnd: token.end,
				spokenStart: cursor,
				spokenEnd: cursor + token.original.length,
			});
			cursor += token.original.length;
			index++;
			continue;
		}

		const source = originalSpan(paragraph.tokens, span);
		let expansion: string | null = null;
		try {
			if (span.type === 'LABB') {
				const candidates =
					dependencies.assets.abbreviations.get(source) ?? dependencies.assets.abbreviations.get(source.replaceAll('.', ''));
				usedAbbreviationScorer ||= Boolean(dependencies.assets.abbreviationScorer && candidates && candidates.length > 1);
				expansion = await expandAbbreviation({
					source,
					leftContext: paragraph.tokens
						.slice(Math.max(0, span.startToken - 5), span.startToken)
						.map(({ text }) => text)
						.join(' '),
					rightContext: paragraph.tokens
						.slice(span.endToken, span.endToken + 5)
						.map(({ text }) => text)
						.join(' '),
					dictionary: dependencies.assets.abbreviations,
					scorer: dependencies.assets.abbreviationScorer,
					confidenceThreshold: dependencies.assets.confidenceThreshold,
					confidenceMargin: dependencies.assets.confidenceMargin,
				});
			} else {
				expansion = expandTypedSpan(span.type, source, {
					previousText: paragraph.tokens[span.startToken - 1]?.text,
					nextText: paragraph.tokens[span.endToken]?.text,
				});
				if (span.type === 'NDAT' && paragraph.tokens[span.startToken - 1]?.text.toLocaleLowerCase('vi') === 'ngày') {
					expansion = expansion?.replace(/^ngày\s+/u, '') ?? null;
				}
			}
		} catch {
			expansion = null;
		}
		const piece = expansion?.trim() || source;
		output.push(token.leading, piece);
		cursor += token.leading.length;
		const spanStartToken = paragraph.tokens[span.startToken];
		const spanEndToken = paragraph.tokens[span.endToken - 1];
		wordMap.push({
			originalText: source,
			originalStart: spanStartToken.start,
			originalEnd: spanEndToken.end,
			spokenStart: cursor,
			spokenEnd: cursor + piece.length,
		});
		cursor += piece.length;
		index = span.endToken;
	}
	output.push(paragraph.trailing);
	return { text: output.join(''), wordMap, usedAbbreviationScorer };
}
```

Replace `normalizeVietnameseText` (lines 187-229) with:

```ts
export async function normalizeVietnameseText(text: string, dependencies: NormalizationDependencies): Promise<NormalizationResult> {
	const startedAt = dependencies.now();
	const document = tokenizeVietnameseText(text);
	let tokenCount = 0;
	let crfMs = 0;
	let expansionMs = 0;
	let usedCrf = false;
	let usedAbbreviationScorer = false;
	let fallbackReason: string | undefined;
	const paragraphs: string[] = [];
	const wordMap: WordMapEntry[] = [];
	let spokenOffset = 0;

	for (const paragraph of document.paragraphs) {
		tokenCount += paragraph.tokens.length;
		const crfStartedAt = dependencies.now();
		const detected = detectVietnameseLabels(paragraph.tokens, dependencies.assets);
		crfMs += dependencies.now() - crfStartedAt;
		usedCrf ||= detected.usedCrf;
		fallbackReason ??= detected.fallbackReason;
		const expansionStartedAt = dependencies.now();
		const expanded = await expandParagraph(paragraph, detected.labels, dependencies);
		expansionMs += dependencies.now() - expansionStartedAt;
		usedAbbreviationScorer ||= expanded.usedAbbreviationScorer;
		for (const entry of expanded.wordMap) {
			wordMap.push({
				originalText: entry.originalText,
				originalStart: entry.originalStart,
				originalEnd: entry.originalEnd,
				spokenStart: spokenOffset + entry.spokenStart,
				spokenEnd: spokenOffset + entry.spokenEnd,
			});
		}
		spokenOffset += expanded.text.length + 2;
		paragraphs.push(expanded.text);
	}

	let normalized = paragraphs.join('\n\n');
	if (normalized.length === 0 && text.length > 0) {
		normalized = text;
		wordMap.length = 0;
	}
	const diagnostics = {
		tokenCount,
		crfMs,
		expansionMs,
		totalMs: dependencies.now() - startedAt,
		usedCrf,
		usedAbbreviationScorer,
		...(fallbackReason ? { fallbackReason } : {}),
	};
	if (document.paragraphs.length === 0 && document.normalizedSource.length > 0) {
		normalized = restoreSource([], document.normalizedSource);
	}
	return { text: normalized, wordMap, diagnostics };
}
```

This adds `wordMap` calculation alongside the existing result without changing any existing `text` or `diagnostics` values, so all current assertions on those fields remain valid.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/unit/vietnamese_normalizer.test.ts`
Expected: PASS for all existing tests plus the two new cases.

- [ ] **Step 6: Commit**

```bash
git add src/offscreen/vietnamese/types.ts src/offscreen/vietnamese/normalizer.ts tests/unit/vietnamese_normalizer.test.ts
git commit -m "feat: build a token/span word map while normalizing Vietnamese text"
```

---

### Task 2: Offscreen word map builder for speech units

**Files:**
- Create: `src/offscreen/word_map.ts`
- Test: `tests/unit/word_map.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/word_map.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { attachNormalizedWordMap, attachPlainWordMap, buildPlainWordMap } from '../../src/offscreen/word_map.ts';

test('builds a plain word map by splitting on whitespace runs', () => {
	assert.deepEqual(buildPlainWordMap('Hello, world!'), [
		{ text: 'Hello,', start: 0, end: 6 },
		{ text: 'world!', start: 7, end: 13 },
	]);
});

test('attaches a plain word map to each unit using the unit own text', () => {
	const units = [
		{ text: 'First sentence.', pauseAfterMs: 180 },
		{ text: 'Second one.', pauseAfterMs: null },
	];
	const attached = attachPlainWordMap(units);
	assert.deepEqual(attached[0].wordMap, [
		{ text: 'First', start: 0, end: 5 },
		{ text: 'sentence.', start: 6, end: 15 },
	]);
	assert.deepEqual(attached[1].wordMap, [
		{ text: 'Second', start: 0, end: 6 },
		{ text: 'one.', start: 7, end: 11 },
	]);
});

test('slices a document-level word map into unit-relative offsets in order', () => {
	const fullText = 'mot hai ba.';
	const units = [{ text: fullText, pauseAfterMs: 180 }];
	const wordMap = [
		{ originalText: '1', originalStart: 0, originalEnd: 1, spokenStart: 0, spokenEnd: 3 },
		{ originalText: 'hai', originalStart: 2, originalEnd: 5, spokenStart: 4, spokenEnd: 7 },
		{ originalText: 'ba', originalStart: 6, originalEnd: 8, spokenStart: 8, spokenEnd: 10 },
	];
	const attached = attachNormalizedWordMap(units, fullText, wordMap);
	assert.deepEqual(attached[0].wordMap, [
		{ text: '1', start: 0, end: 3 },
		{ text: 'hai', start: 4, end: 7 },
		{ text: 'ba', start: 8, end: 10 },
	]);
});

test('advances the search cursor across multiple units instead of rematching from the start', () => {
	const fullText = 'aaa bbb';
	const units = [
		{ text: 'aaa', pauseAfterMs: 60 },
		{ text: 'bbb', pauseAfterMs: null },
	];
	const wordMap = [
		{ originalText: 'x', originalStart: 0, originalEnd: 1, spokenStart: 0, spokenEnd: 3 },
		{ originalText: 'y', originalStart: 2, originalEnd: 3, spokenStart: 4, spokenEnd: 7 },
	];
	const attached = attachNormalizedWordMap(units, fullText, wordMap);
	assert.deepEqual(attached[0].wordMap, [{ text: 'x', start: 0, end: 3 }]);
	assert.deepEqual(attached[1].wordMap, [{ text: 'y', start: 0, end: 3 }]);
});

test('returns an empty word map for a unit that cannot be located in the full text', () => {
	const attached = attachNormalizedWordMap([{ text: 'missing unit', pauseAfterMs: null }], 'completely different text', []);
	assert.deepEqual(attached[0].wordMap, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/word_map.test.ts`
Expected: FAIL — `Cannot find module '../../src/offscreen/word_map.ts'`.

- [ ] **Step 3: Implement `src/offscreen/word_map.ts`**

```ts
import type { SpeechUnit } from './speech_unit.ts';
import type { WordMapEntry } from './vietnamese/types.ts';

export function buildPlainWordMap(text: string): Array<{ text: string; start: number; end: number }> {
	const entries: Array<{ text: string; start: number; end: number }> = [];
	const pattern = /\S+/gu;
	let match: RegExpExecArray | null = pattern.exec(text);
	while (match !== null) {
		entries.push({ text: match[0], start: match.index, end: match.index + match[0].length });
		match = pattern.exec(text);
	}
	return entries;
}

export function attachPlainWordMap(units: readonly SpeechUnit[]): SpeechUnit[] {
	return units.map((unit) => ({ ...unit, wordMap: buildPlainWordMap(unit.text) }));
}

export function attachNormalizedWordMap(
	units: readonly SpeechUnit[],
	fullSpokenText: string,
	wordMap: readonly WordMapEntry[],
): SpeechUnit[] {
	let searchCursor = 0;
	return units.map((unit) => {
		const unitStart = fullSpokenText.indexOf(unit.text, searchCursor);
		if (unitStart === -1) {
			return { ...unit, wordMap: [] };
		}
		const unitEnd = unitStart + unit.text.length;
		searchCursor = unitEnd;
		const entries = wordMap
			.filter((entry) => entry.spokenStart >= unitStart && entry.spokenEnd <= unitEnd)
			.map((entry) => ({
				text: entry.originalText,
				start: entry.spokenStart - unitStart,
				end: entry.spokenEnd - unitStart,
			}));
		return { ...unit, wordMap: entries };
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/word_map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/word_map.ts tests/unit/word_map.test.ts
git commit -m "feat: attach a per-unit word map for plain and normalized text"
```

---

### Task 3: Thread the word map through `SpeechUnit` and `preparePlaybackUnits`

**Files:**
- Modify: `src/offscreen/speech_unit.ts`
- Modify: `src/offscreen/playback_preparation.ts:34-48`
- Test: `tests/unit/playback_preparation.test.ts`

- [ ] **Step 1: Add the `wordMap` field to `SpeechUnit`**

Replace the full content of `src/offscreen/speech_unit.ts`:

```ts
export interface SpeechUnitWordMapEntry {
	text: string;
	start: number;
	end: number;
}

export interface SpeechUnit {
	text: string;
	pauseAfterMs: number | null;
	wordMap?: readonly SpeechUnitWordMapEntry[];
}
```

`wordMap` remains optional so existing functions (`planLatinSpeechUnits`, `planTextSegments`, and `compatibilityUnits`) can continue creating `SpeechUnit` values without setting it. `preparePlaybackUnits` is the only place that attaches a word map before returning.

- [ ] **Step 2: Write the failing test**

Replace the full content of `tests/unit/playback_preparation.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isVietnameseLanguage, preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

const diagnostics = {
	tokenCount: 3,
	crfMs: 0,
	expansionMs: 0,
	totalMs: 0,
	usedCrf: true,
	usedAbbreviationScorer: false,
};

function withoutWordMap(units: SpeechUnit[]) {
	return units.map(({ wordMap: _wordMap, ...rest }) => rest);
}

test('recognizes Vietnamese primary language subtags', () => {
	for (const lang of ['vi', 'VI', 'vi-VN', 'VI-latn-VN', 'vi_VN']) {
		assert.equal(isVietnameseLanguage(lang), true, lang);
	}
	for (const lang of ['', 'en', 'x-vi', 'viet']) {
		assert.equal(isVietnameseLanguage(lang), false, lang);
	}
});

test('normalizes Vietnamese BCP-47 variants once and plans explicit pauses', async () => {
	for (const lang of ['vi', 'vi-VN']) {
		let calls = 0;
		const units = await preparePlaybackUnits('ĐH mở cửa.', lang, {
			async normalize() {
				calls++;
				return { text: 'đại học mở cửa.', wordMap: [], diagnostics };
			},
		});
		assert.equal(calls, 1);
		assert.deepEqual(withoutWordMap(units), [{ text: 'đại học mở cửa.', pauseAfterMs: 180 }]);
	}
});

test('uses weighted units for Latin text despite missing or inaccurate language tags', async () => {
	let calls = 0;
	const normalizer = {
		async normalize() {
			calls++;
			throw new Error('must not run');
		},
	};
	for (const lang of ['en', 'na', 'zh', '']) {
		assert.deepEqual(withoutWordMap(await preparePlaybackUnits('First sentence. Second sentence.', lang, normalizer)), [
			{ text: 'First sentence. Second sentence.', pauseAfterMs: 180 },
		]);
	}
	assert.equal(calls, 0);
});

test('uses weighted units for accented Latin languages', async () => {
	for (const [lang, text] of [
		['fr', 'Déjà vu. Très bien.'],
		['de', 'Größere Übung. Alles gut.'],
		['es', 'Corazón español. Muy bien.'],
		['pl', 'Zażółć gęślą jaźń. Dobrze.'],
	] as const) {
		assert.deepEqual(withoutWordMap(await preparePlaybackUnits(text, lang, null)), [{ text, pauseAfterMs: 180 }]);
	}
});

test('keeps non-Latin and exact-half text on engine-managed compatibility pauses', async () => {
	for (const text of ['中文内容。', 'Русский текст.', 'نص عربي.', 'ab中文', '123 😀 !!!']) {
		assert.deepEqual(withoutWordMap(await preparePlaybackUnits(text, 'unknown', null)), [{ text, pauseAfterMs: null }]);
	}
});

test('fails open to explicit units from the exact original Vietnamese text', async () => {
	const units = await preparePlaybackUnits('Một câu, vẫn đọc được.', 'vi', {
		async normalize() {
			throw new Error('expected failure');
		},
	});
	assert.deepEqual(withoutWordMap(units), [{ text: 'Một câu, vẫn đọc được.', pauseAfterMs: 180 }]);
});

test('returns identical units for identical selected and article text', async () => {
	const text = 'Nội dung giống nhau.';
	const normalizer = {
		async normalize() {
			return { text, wordMap: [], diagnostics };
		},
	};
	assert.deepEqual(
		withoutWordMap(await preparePlaybackUnits(text, 'vi', normalizer)),
		withoutWordMap(await preparePlaybackUnits(text, 'vi', normalizer)),
	);
});

test('does not return empty units when normalization yields whitespace', async () => {
	const units = await preparePlaybackUnits('Vẫn phải đọc.', 'vi', {
		async normalize() {
			return { text: ' \n\n ', wordMap: [], diagnostics };
		},
	});
	assert.deepEqual(withoutWordMap(units), [{ text: 'Vẫn phải đọc.', pauseAfterMs: 180 }]);
});

test('attaches a word map for both normalized Vietnamese text and plain Latin text', async () => {
	const spokenDate = 'mười một tháng bảy năm hai nghìn không trăm hai mươi sáu';
	const text = `Có ${spokenDate}.`;
	const viUnits = await preparePlaybackUnits('Có 11/07/2026.', 'vi', {
		async normalize() {
			return {
				text,
				wordMap: [
					{ originalText: 'Có', originalStart: 0, originalEnd: 2, spokenStart: 0, spokenEnd: 2 },
					{ originalText: '11/07/2026', originalStart: 3, originalEnd: 13, spokenStart: 3, spokenEnd: 3 + spokenDate.length },
				],
				diagnostics,
			};
		},
	});
	assert.deepEqual(
		viUnits[0].wordMap?.map(({ text: word }) => word),
		['Có', '11/07/2026'],
	);

	const latinUnits = await preparePlaybackUnits('First sentence.', 'en', null);
	assert.deepEqual(
		latinUnits[0].wordMap?.map(({ text: word }) => word),
		['First', 'sentence.'],
	);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --experimental-strip-types --test tests/unit/playback_preparation.test.ts`
Expected: FAIL — last test fails (`wordMap` is `undefined` since `preparePlaybackUnits` doesn't attach it yet); earlier tests still pass since `withoutWordMap` already tolerates a missing field.

- [ ] **Step 4: Wire `preparePlaybackUnits` to attach the word map**

In `src/offscreen/playback_preparation.ts`, add the import (after line 4):

```ts
import { isPredominantlyLatinText, planLatinSpeechUnits } from './latin/speech_units.ts';
import type { SpeechUnit } from './speech_unit.ts';
import { chunkText } from './supertonic_helper.ts';
import { attachNormalizedWordMap, attachPlainWordMap } from './word_map.ts';
import type { NormalizationResult } from './vietnamese/types.ts';
```

Replace `preparePlaybackUnits` (lines 34-48) with:

```ts
export async function preparePlaybackUnits(text: string, lang: string, normalizer: VietnameseTextNormalizer | null): Promise<SpeechUnit[]> {
	if (!isVietnameseLanguage(lang)) {
		const units = isPredominantlyLatinText(text) ? plannedUnits(text, null) : compatibilityUnits(text, null);
		return attachPlainWordMap(units);
	}
	if (!normalizer) {
		return attachPlainWordMap(vietnameseFallback(text));
	}
	try {
		const result = await normalizer.normalize(text);
		const units = planLatinSpeechUnits(result.text).filter(({ text: unit }) => unit.trim().length > 0);
		return units.length > 0
			? attachNormalizedWordMap(units, result.text, result.wordMap)
			: attachPlainWordMap(vietnameseFallback(text));
	} catch {
		return attachPlainWordMap(vietnameseFallback(text));
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --experimental-strip-types --test tests/unit/playback_preparation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/offscreen/speech_unit.ts src/offscreen/playback_preparation.ts tests/unit/playback_preparation.test.ts
git commit -m "feat: attach a word map to every prepared speech unit"
```

---

### Task 4: Word timing estimation

**Files:**
- Create: `src/offscreen/word_timing.ts`
- Test: `tests/unit/word_timing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/word_timing.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeWordTimings, findWordAtTime } from '../../src/offscreen/word_timing.ts';

test('allocates duration proportionally to each word length', () => {
	const wordMap = [
		{ text: 'a', start: 0, end: 1 },
		{ text: 'bb', start: 2, end: 4 },
		{ text: 'ccc', start: 5, end: 8 },
	];
	const windows = computeWordTimings(wordMap, 6);
	assert.deepEqual(windows, [
		{ text: 'a', startSec: 0, endSec: 1 },
		{ text: 'bb', startSec: 1, endSec: 3 },
		{ text: 'ccc', startSec: 3, endSec: 6 },
	]);
});

test('returns an empty list when there is no spoken duration or no words', () => {
	assert.deepEqual(computeWordTimings([], 5), []);
	assert.deepEqual(computeWordTimings([{ text: 'x', start: 0, end: 1 }], 0), []);
});

test('finds the word whose window contains the elapsed time', () => {
	const windows = [
		{ text: 'a', startSec: 0, endSec: 1 },
		{ text: 'bb', startSec: 1, endSec: 3 },
		{ text: 'ccc', startSec: 3, endSec: 6 },
	];
	assert.equal(findWordAtTime(windows, 0), 'a');
	assert.equal(findWordAtTime(windows, 0.5), 'a');
	assert.equal(findWordAtTime(windows, 1), 'bb');
	assert.equal(findWordAtTime(windows, 2.9), 'bb');
	assert.equal(findWordAtTime(windows, 3), 'ccc');
});

test('clamps to the last word once elapsed time reaches the end, and returns null for an empty timeline', () => {
	const windows = [{ text: 'only', startSec: 0, endSec: 2 }];
	assert.equal(findWordAtTime(windows, 10), 'only');
	assert.equal(findWordAtTime([], 0), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/unit/word_timing.test.ts`
Expected: FAIL — `Cannot find module '../../src/offscreen/word_timing.ts'`.

- [ ] **Step 3: Implement `src/offscreen/word_timing.ts`**

```ts
export interface WordTimingWindow {
	text: string;
	startSec: number;
	endSec: number;
}

export function computeWordTimings(
	wordMap: readonly { text: string; start: number; end: number }[],
	spokenDurationSec: number,
): WordTimingWindow[] {
	if (wordMap.length === 0 || spokenDurationSec <= 0) {
		return [];
	}
	const totalChars = wordMap.reduce((sum, entry) => sum + Math.max(entry.end - entry.start, 1), 0);
	const windows: WordTimingWindow[] = [];
	let elapsed = 0;
	for (const entry of wordMap) {
		const weight = Math.max(entry.end - entry.start, 1);
		const duration = (weight / totalChars) * spokenDurationSec;
		windows.push({ text: entry.text, startSec: elapsed, endSec: elapsed + duration });
		elapsed += duration;
	}
	return windows;
}

export function findWordAtTime(windows: readonly WordTimingWindow[], elapsedSec: number): string | null {
	for (const window of windows) {
		if (elapsedSec >= window.startSec && elapsedSec < window.endSec) {
			return window.text;
		}
	}
	const lastWindow = windows.at(-1);
	return lastWindow && elapsedSec >= lastWindow.endSec ? lastWindow.text : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/unit/word_timing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/word_timing.ts tests/unit/word_timing.test.ts
git commit -m "feat: estimate per-word timing windows from real audio duration"
```

---

### Task 5: Wire word timing tracking into offscreen playback

**Files:**
- Modify: `src/offscreen/offscreen.ts`

There is no unit test for this task because `offscreen.ts` owns module-level state and controls the real `AudioContext` and `chrome.runtime`. This follows the existing convention: only pure functions in `audio.ts`, `synthesis_coordinator.ts`, and `playback_preparation.ts` have unit tests, while `offscreen.ts` behavior is verified by Task 11 (E2E) and Task 12 (manual QA).

- [ ] **Step 1: Import the new pure functions**

In `src/offscreen/offscreen.ts`, add to the import block (after line 8, before `loadVietnameseNormalizerAssets`):

```ts
import { synthesizeSpeechUnitSamples } from './audio';
import { isVietnameseLanguage, preparePlaybackUnits, VietnameseTextNormalizer } from './playback_preparation';
import { createSingleFlight } from './single_flight';
import type { SpeechUnit } from './speech_unit';
import { loadTextToSpeech, loadVoiceStyle, Style, TextToSpeech, writeWavFile } from './supertonic_helper';
import { IndexedSynthesisCoordinator, type SynthesisKey } from './synthesis_coordinator';
import { loadVietnameseNormalizerAssets } from './vietnamese/assets';
import { normalizeVietnameseText } from './vietnamese/normalizer';
import { computeWordTimings, findWordAtTime, type WordTimingWindow } from './word_timing';
```

- [ ] **Step 2: Add word-highlight tracking state and helpers**

After `stopCurrentSource` (line 227), insert:

```ts
let wordHighlightTimer: ReturnType<typeof setInterval> | null = null;
let lastHighlightedWord: string | null = null;

function clearWordHighlightTracking() {
	if (wordHighlightTimer !== null) {
		clearInterval(wordHighlightTimer);
		wordHighlightTimer = null;
	}
	if (lastHighlightedWord !== null) {
		lastHighlightedWord = null;
		chrome.runtime.sendMessage({ action: 'WORD_HIGHLIGHT_CLEAR', sessionId: currentExtensionSessionId });
	}
}

function startWordHighlightTracking(windows: WordTimingWindow[], unitStartTime: number) {
	clearWordHighlightTracking();
	if (windows.length === 0 || !audioCtx) {
		return;
	}
	wordHighlightTimer = setInterval(() => {
		if (!audioCtx) {
			return;
		}
		const elapsed = audioCtx.currentTime - unitStartTime;
		const word = findWordAtTime(windows, elapsed);
		if (word !== null && word !== lastHighlightedWord) {
			lastHighlightedWord = word;
			chrome.runtime.sendMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: currentExtensionSessionId, word });
		}
	}, 100);
}
```

`audioCtx.currentTime` automatically stops advancing when `audioCtx.suspend()` handles PAUSE and resumes from the correct timestamp after `resume()`. No separate pause/resume timing logic is required; `elapsed` already reflects actual playback time.

- [ ] **Step 3: Clear tracking when audio stops**

Replace `stopAudio` (lines 229-240):

```ts
function stopAudio() {
	stopCurrentSource();
	clearWordHighlightTracking();
	isPaused = false;
	synthesisCoordinator.clear();
	reportProgress('stopped');
	speechUnits = [];
	currentUnitIndex = 0;
	currentExtensionSessionId = null;
}
```

- [ ] **Step 4: Start tracking whenever a new unit starts playing**

In `playAudioBuffer` (lines 245-278), replace the last two lines (`source.start(0);` followed by the closing `}`):

```ts
	const unit = speechUnits[unitIndex];
	const spokenDurationSec = Math.max(buffer.duration - (unit?.pauseAfterMs ?? 0) / 1000, 0);
	const windows = computeWordTimings(unit?.wordMap ?? [], spokenDurationSec);
	const unitStartTime = audioCtx.currentTime;
	source.start(0);
	startWordHighlightTracking(windows, unitStartTime);
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat: report the currently spoken word while a unit is playing"
```

---

### Task 6: Shared word-highlight message contract, storage key, i18n

**Files:**
- Create: `src/shared/word_highlight.ts`
- Modify: `src/shared/constants.ts:27-34`, `src/shared/constants.ts:40-111`

- [ ] **Step 1: Create the shared message contract**

Create `src/shared/word_highlight.ts`:

```ts
export const WORD_HIGHLIGHT_NAME = 'readit-dev-word-highlight';

export interface WordHighlightUpdateMessage {
	action: 'WORD_HIGHLIGHT_UPDATE';
	sessionId: string;
	word: string;
}

export interface WordHighlightClearMessage {
	action: 'WORD_HIGHLIGHT_CLEAR';
	sessionId: string;
}

export function isWordHighlightEnabled(value: unknown): boolean {
	return value !== false;
}
```

- [ ] **Step 2: Add the storage key**

In `src/shared/constants.ts`, replace lines 27-34:

```ts
export const STORAGE_KEYS = {
	ACTIVE_VOICE: 'readit_active_voice',
	SPEED: 'readit_speed',
	READ_MODE_SETTINGS: 'readit_read_mode_settings',
	PLAYBACK_SESSION: 'readit_playback_session',
	THEME: 'readit_active_theme',
	SELECTION_BUTTON_ENABLED: 'readit_selection_button_enabled',
};
```

with:

```ts
export const STORAGE_KEYS = {
	ACTIVE_VOICE: 'readit_active_voice',
	SPEED: 'readit_speed',
	READ_MODE_SETTINGS: 'readit_read_mode_settings',
	PLAYBACK_SESSION: 'readit_playback_session',
	THEME: 'readit_active_theme',
	SELECTION_BUTTON_ENABLED: 'readit_selection_button_enabled',
	WORD_HIGHLIGHT_ENABLED: 'readit_word_highlight_enabled',
};
```

- [ ] **Step 3: Add i18n strings**

In `src/shared/constants.ts`, in the `vi` block of `THEME_TRANSLATIONS` (around line 73-74), replace:

```ts
		showSelectionButton: 'Hiện nút đọc cạnh văn bản đã chọn',
		readSelectedText: 'Đọc văn bản đã chọn',
```

with:

```ts
		showSelectionButton: 'Hiện nút đọc cạnh văn bản đã chọn',
		readSelectedText: 'Đọc văn bản đã chọn',
		showWordHighlight: 'Tô sáng từ đang đọc trên trang',
```

In the `en` block (around line 108-109), replace:

```ts
		showSelectionButton: 'Show read button for selected text',
		readSelectedText: 'Read selected text',
```

with:

```ts
		showSelectionButton: 'Show read button for selected text',
		readSelectedText: 'Read selected text',
		showWordHighlight: 'Highlight the word being read on the page',
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/word_highlight.ts src/shared/constants.ts
git commit -m "feat: add the word-highlight message contract, storage key and i18n strings"
```

---

### Task 7: Background relay to the owning tab

**Files:**
- Modify: `src/background/background.ts`

There is no dedicated unit test for this task because the current codebase does not test `background.ts` directly; only imported pure modules such as `playback_state.ts` have unit tests. Task 11 (E2E) and Task 12 (manual QA) verify relay behavior.

- [ ] **Step 1: Add relay handlers**

In `src/background/background.ts`, after `applyProgressMessage` (lines 431-450), insert:

```ts
async function relayWordHighlightUpdate(message: Record<string, unknown>): Promise<void> {
	await ensureHydrated();
	if (
		!activeSession ||
		typeof message.sessionId !== 'string' ||
		message.sessionId !== activeSession.sessionId ||
		typeof message.word !== 'string'
	) {
		return;
	}
	try {
		await chrome.tabs.sendMessage(activeSession.tabId, {
			action: 'WORD_HIGHLIGHT_UPDATE',
			sessionId: activeSession.sessionId,
			word: message.word,
		});
	} catch (_error) {
		// The content script may not be listening (e.g. the tab navigated away); ignore.
	}
}

async function relayWordHighlightClear(message: Record<string, unknown>): Promise<void> {
	await ensureHydrated();
	if (!activeSession || typeof message.sessionId !== 'string' || message.sessionId !== activeSession.sessionId) {
		return;
	}
	try {
		await chrome.tabs.sendMessage(activeSession.tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: activeSession.sessionId });
	} catch (_error) {
		// The content script may not be listening; ignore.
	}
}
```

- [ ] **Step 2: Dispatch the new actions**

In the `chrome.runtime.onMessage` switch (around line 512-514), replace:

```ts
			case 'PLAYBACK_PROGRESS_UPDATE':
				void enqueue(() => applyProgressMessage(msg));
				break;
```

with:

```ts
			case 'PLAYBACK_PROGRESS_UPDATE':
				void enqueue(() => applyProgressMessage(msg));
				break;

			case 'WORD_HIGHLIGHT_UPDATE':
				void enqueue(() => relayWordHighlightUpdate(msg));
				break;

			case 'WORD_HIGHLIGHT_CLEAR':
				void enqueue(() => relayWordHighlightClear(msg));
				break;
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/background/background.ts
git commit -m "feat: relay word-highlight updates to the tab that owns the session"
```

---

### Task 8: Content script — noise-region export and selection range capture

**Files:**
- Modify: `src/content/article_extractor.ts`
- Create: `src/content/reading_anchor.ts`
- Modify: `src/content/selection_button.ts`

- [ ] **Step 1: Export a non-mutating noise-region check**

In `src/content/article_extractor.ts`, after `isNoiseElement` (lines 40-42), insert:

```ts
export function isWithinNoiseRegion(node: Node): boolean {
	let element: Element | null = node instanceof Element ? node : node.parentElement;
	while (element) {
		if (element.matches(STRUCTURAL_NOISE_SELECTOR) || isNoiseElement(element)) {
			return true;
		}
		element = element.parentElement;
	}
	return false;
}
```

This is the non-mutating form of the same `cleanContentTree` criteria used to remove extraction noise. It checks `matches` and ancestors instead of calling `remove()`, so it is safe to run against the live page.

- [ ] **Step 2: Create the shared selection-range anchor**

Create `src/content/reading_anchor.ts`:

```ts
let lastSelectionRange: Range | null = null;

export function setLastSelectionRange(range: Range | null): void {
	lastSelectionRange = range;
}

export function consumeLastSelectionRange(): Range | null {
	const range = lastSelectionRange;
	lastSelectionRange = null;
	return range;
}
```

- [ ] **Step 3: Capture the Range when the floating button starts a selected-text session**

In `src/content/selection_button.ts`, add the import (after line 9):

```ts
import { computeSelectionButtonPosition } from './selection_button_position';
import { setLastSelectionRange } from './reading_anchor';
```

Replace the `click` handler (lines 156-169):

```ts
		button.addEventListener('click', () => {
			if (activated || !snapshot) {
				return;
			}
			activated = true;
			button.disabled = true;
			const message: StartSelectedTextMessage = {
				action: 'START_SELECTED_TEXT',
				selectionText: snapshot.text,
				pageLanguage: snapshot.pageLanguage,
			};
			removeButton();
			void chrome.runtime.sendMessage(message).catch(() => undefined);
		});
```

with:

```ts
		button.addEventListener('click', () => {
			if (activated || !snapshot) {
				return;
			}
			activated = true;
			button.disabled = true;
			const activeSelection = window.getSelection();
			if (activeSelection && activeSelection.rangeCount > 0) {
				setLastSelectionRange(activeSelection.getRangeAt(0).cloneRange());
			}
			const message: StartSelectedTextMessage = {
				action: 'START_SELECTED_TEXT',
				selectionText: snapshot.text,
				pageLanguage: snapshot.pageLanguage,
			};
			removeButton();
			void chrome.runtime.sendMessage(message).catch(() => undefined);
		});
```

The button's `pointerdown` handler already calls `preventDefault()` (line 155), so the page selection remains intact when the `click` handler runs.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/content/article_extractor.ts src/content/reading_anchor.ts src/content/selection_button.ts
git commit -m "feat: expose a non-mutating noise check and capture the active selection range"
```

---

### Task 9: Content script — word highlight DOM module

**Files:**
- Create: `src/content/word_highlight.ts`
- Modify: `src/content/content_script.ts`

There is no dedicated unit test because this logic depends on real DOM APIs (`TreeWalker`, `Range`, and `CSS.highlights`), while `node --experimental-strip-types --test` has no DOM and the project does not use jsdom. This matches the existing convention for `article_extractor.ts` and `selection_button.ts`; Task 11 verifies the behavior through E2E coverage.

- [ ] **Step 1: Implement `src/content/word_highlight.ts`**

```ts
import { STORAGE_KEYS } from '../shared/constants';
import { isWordHighlightEnabled, WORD_HIGHLIGHT_NAME } from '../shared/word_highlight';
import { isWithinNoiseRegion } from './article_extractor';
import { consumeLastSelectionRange } from './reading_anchor';

interface WalkerCursor {
	walker: TreeWalker;
	node: Text | null;
	offset: number;
}

function createWalker(root: Node): TreeWalker {
	return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (isWithinNoiseRegion(node)) {
				return NodeFilter.FILTER_REJECT;
			}
			return node.textContent && node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		},
	});
}

function createCursor(root: Node): WalkerCursor {
	const walker = createWalker(root);
	return { walker, node: walker.nextNode() as Text | null, offset: 0 };
}

function findNextWordRange(cursor: WalkerCursor, word: string): Range | null {
	const target = word.trim().toLocaleLowerCase();
	if (!target) {
		return null;
	}
	while (cursor.node) {
		const searchText = (cursor.node.textContent ?? '').toLocaleLowerCase();
		const matchIndex = searchText.indexOf(target, cursor.offset);
		if (matchIndex === -1) {
			cursor.node = cursor.walker.nextNode() as Text | null;
			cursor.offset = 0;
			continue;
		}
		const range = document.createRange();
		range.setStart(cursor.node, matchIndex);
		range.setEnd(cursor.node, matchIndex + target.length);
		cursor.offset = matchIndex + target.length;
		return range;
	}
	return null;
}

function resolveStartRoot(): Node {
	const range = consumeLastSelectionRange();
	if (!range) {
		return document.body;
	}
	const container = range.commonAncestorContainer;
	return container instanceof Element ? container : (container.parentElement ?? document.body);
}

let cursor: WalkerCursor | null = null;
let currentSessionId: string | null = null;
let enabled = true;
let styleInjected = false;

function ensureStyleInjected(): void {
	if (styleInjected) {
		return;
	}
	styleInjected = true;
	const style = document.createElement('style');
	style.id = 'readit-dev-word-highlight-style';
	style.textContent = `::highlight(${WORD_HIGHLIGHT_NAME}) { background-color: #ffe066; color: #1a1a1a; }`;
	document.head.append(style);
}

function clearHighlight(): void {
	CSS.highlights?.delete(WORD_HIGHLIGHT_NAME);
}

function applyWordHighlight(word: string): void {
	if (!enabled) {
		return;
	}
	if (!cursor) {
		cursor = createCursor(resolveStartRoot());
	}
	const range = findNextWordRange(cursor, word);
	if (!range) {
		return;
	}
	ensureStyleInjected();
	CSS.highlights?.set(WORD_HIGHLIGHT_NAME, new Highlight(range));
}

export function installWordHighlight(): void {
	if (window.top !== window || (window.location.protocol !== 'http:' && window.location.protocol !== 'https:')) {
		return;
	}
	if (typeof CSS === 'undefined' || !CSS.highlights) {
		return;
	}

	chrome.runtime.onMessage.addListener((message: unknown) => {
		const msg = message as { action?: string; sessionId?: string; word?: string };
		if (msg.action === 'WORD_HIGHLIGHT_UPDATE' && typeof msg.word === 'string') {
			if (msg.sessionId !== currentSessionId) {
				currentSessionId = msg.sessionId ?? null;
				cursor = null;
			}
			applyWordHighlight(msg.word);
		} else if (msg.action === 'WORD_HIGHLIGHT_CLEAR') {
			currentSessionId = null;
			cursor = null;
			consumeLastSelectionRange();
			clearHighlight();
		}
	});

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'local' || !(STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED in changes)) {
			return;
		}
		enabled = isWordHighlightEnabled(changes[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED].newValue);
		if (!enabled) {
			clearHighlight();
		}
	});

	void chrome.storage.local.get(STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED).then((stored) => {
		enabled = isWordHighlightEnabled(stored[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]);
	});
}
```

Following the `installSelectionButton()` convention, `enabled` defaults to `true`, and the `chrome.runtime.onMessage` and `chrome.storage.onChanged` listeners are attached synchronously before `await chrome.storage.local.get(...)`. This prevents messages from being missed while storage is loading, the same bug class fixed in commit `878ced8`.

The `WORD_HIGHLIGHT_CLEAR` branch also calls `consumeLastSelectionRange()` and ignores the return value. This clears a stored range when a selected-text session ends before any word is highlighted, meaning `resolveStartRoot()` never consumed it, and prevents a later full-page session from inheriting the wrong start position.

- [ ] **Step 2: Register it in the content script entrypoint**

In `src/content/content_script.ts`, replace:

```ts
import { Article } from '../shared/types';
import { extractArticleFromDocument } from './article_extractor';
import { claimContentScriptInitialization } from './content_script_state';
import { installSelectionButton } from './selection_button';
```

with:

```ts
import { Article } from '../shared/types';
import { extractArticleFromDocument } from './article_extractor';
import { claimContentScriptInitialization } from './content_script_state';
import { installSelectionButton } from './selection_button';
import { installWordHighlight } from './word_highlight';
```

Replace line 26 (`void installSelectionButton();`) with:

```ts
	void installSelectionButton();
	installWordHighlight();
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/content/word_highlight.ts src/content/content_script.ts
git commit -m "feat: highlight the currently spoken word on the live page via the CSS Custom Highlight API"
```

---

### Task 10: Popup settings toggle

**Files:**
- Modify: `src/popup/App.tsx`

- [ ] **Step 1: Import the helper and add state**

In `src/popup/App.tsx`, replace the import block (lines 1-13):

```ts
import { useEffect, useRef, useState } from 'react';

import {
	BUY_ME_A_COFFEE_URL,
	PRIVACY_POLICY_URL,
	STORAGE_KEYS,
	THEME_TRANSLATIONS,
	VOICE_STYLE_TRANSLATIONS,
	VOICE_STYLES,
} from '../shared/constants';
import { isSelectionButtonEnabled } from '../shared/selection_button';
import type { PlaybackSessionSnapshot, PlaybackStateResponse, PlaybackStatus } from '../shared/types';
import { isWordHighlightEnabled } from '../shared/word_highlight';
import { buildFeedbackUrl } from './feedback';
```

Replace line 139 (`const [selectionButtonEnabled, setSelectionButtonEnabled] = useState(true);`) — insert a new line right after it:

```ts
	const [selectionButtonEnabled, setSelectionButtonEnabled] = useState(true);
	const [wordHighlightEnabled, setWordHighlightEnabled] = useState(true);
```

- [ ] **Step 2: Read and react to the stored setting**

Replace the `chrome.storage.local.get` call (lines 157-171):

```ts
		chrome.storage.local.get(
			[STORAGE_KEYS.ACTIVE_VOICE, STORAGE_KEYS.SPEED, STORAGE_KEYS.THEME, STORAGE_KEYS.SELECTION_BUTTON_ENABLED],
			(result: { [key: string]: unknown }) => {
				if (result[STORAGE_KEYS.ACTIVE_VOICE]) {
					setActiveVoice(result[STORAGE_KEYS.ACTIVE_VOICE] as string);
				}
				if (result[STORAGE_KEYS.SPEED]) {
					setSpeed(result[STORAGE_KEYS.SPEED] as number);
				}
				if (result[STORAGE_KEYS.THEME]) {
					setActiveTheme(result[STORAGE_KEYS.THEME] as ThemeName);
				}
				setSelectionButtonEnabled(isSelectionButtonEnabled(result[STORAGE_KEYS.SELECTION_BUTTON_ENABLED]));
			},
		);
```

with:

```ts
		chrome.storage.local.get(
			[
				STORAGE_KEYS.ACTIVE_VOICE,
				STORAGE_KEYS.SPEED,
				STORAGE_KEYS.THEME,
				STORAGE_KEYS.SELECTION_BUTTON_ENABLED,
				STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED,
			],
			(result: { [key: string]: unknown }) => {
				if (result[STORAGE_KEYS.ACTIVE_VOICE]) {
					setActiveVoice(result[STORAGE_KEYS.ACTIVE_VOICE] as string);
				}
				if (result[STORAGE_KEYS.SPEED]) {
					setSpeed(result[STORAGE_KEYS.SPEED] as number);
				}
				if (result[STORAGE_KEYS.THEME]) {
					setActiveTheme(result[STORAGE_KEYS.THEME] as ThemeName);
				}
				setSelectionButtonEnabled(isSelectionButtonEnabled(result[STORAGE_KEYS.SELECTION_BUTTON_ENABLED]));
				setWordHighlightEnabled(isWordHighlightEnabled(result[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]));
			},
		);
```

- [ ] **Step 3: Add the change handler**

Replace `handleSelectionButtonEnabledChange` (lines 293-296):

```ts
	const handleSelectionButtonEnabledChange = (enabled: boolean) => {
		setSelectionButtonEnabled(enabled);
		void chrome.storage.local.set({ [STORAGE_KEYS.SELECTION_BUTTON_ENABLED]: enabled });
	};
```

with:

```ts
	const handleSelectionButtonEnabledChange = (enabled: boolean) => {
		setSelectionButtonEnabled(enabled);
		void chrome.storage.local.set({ [STORAGE_KEYS.SELECTION_BUTTON_ENABLED]: enabled });
	};

	const handleWordHighlightEnabledChange = (enabled: boolean) => {
		setWordHighlightEnabled(enabled);
		void chrome.storage.local.set({ [STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]: enabled });
	};
```

- [ ] **Step 4: Add the switch to the settings UI**

Replace the selection-button switch block (lines 538-546):

```tsx
			<label className="selection-button-setting">
				<span>{t('showSelectionButton')}</span>
				<input
					type="checkbox"
					className="selection-button-toggle"
					checked={selectionButtonEnabled}
					onChange={(event) => handleSelectionButtonEnabledChange(event.target.checked)}
				/>
			</label>
```

with:

```tsx
			<label className="selection-button-setting">
				<span>{t('showSelectionButton')}</span>
				<input
					type="checkbox"
					className="selection-button-toggle"
					checked={selectionButtonEnabled}
					onChange={(event) => handleSelectionButtonEnabledChange(event.target.checked)}
				/>
			</label>

			<label className="selection-button-setting">
				<span>{t('showWordHighlight')}</span>
				<input
					type="checkbox"
					className="selection-button-toggle"
					checked={wordHighlightEnabled}
					onChange={(event) => handleWordHighlightEnabledChange(event.target.checked)}
				/>
			</label>
```

Reuse the existing `selection-button-setting` and `selection-button-toggle` CSS from `src/popup/popup.css`; no new CSS is required.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/popup/App.tsx
git commit -m "feat: add a settings toggle for word highlighting"
```

---

### Task 11: E2E test

**Files:**
- Create: `tests/e2e/word-highlight.spec.ts`

Playwright loads the real extension through `tests/e2e/fixtures.ts`, so the test can call the real `chrome.tabs.sendMessage` from the service-worker context to reproduce Task 7's messages and verify `word_highlight.ts` against the live DOM. It does not need to run the full TTS/ONNX pipeline, which is too heavy for E2E coverage.

- [ ] **Step 1: Write the test**

Create `tests/e2e/word-highlight.spec.ts`:

```ts
import type { BrowserContext, Page, Worker } from '@playwright/test';

import { expect, test } from './fixtures';

const highlightRegistryName = 'readit-dev-word-highlight';

function findExtensionServiceWorker(context: BrowserContext): Worker {
	const serviceWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
	if (!serviceWorker) {
		throw new Error('Extension service worker was not found.');
	}
	return serviceWorker;
}

async function getTabId(serviceWorker: Worker, url: string): Promise<number> {
	const tabId = await serviceWorker.evaluate(async (targetUrl) => {
		const tabs = await chrome.tabs.query({ url: targetUrl });
		return tabs[0]?.id;
	}, url);
	if (typeof tabId !== 'number') {
		throw new Error(`Could not resolve a tab id for ${url}`);
	}
	return tabId;
}

async function sendWordHighlightMessage(
	serviceWorker: Worker,
	tabId: number,
	message: { action: 'WORD_HIGHLIGHT_UPDATE'; sessionId: string; word: string } | { action: 'WORD_HIGHLIGHT_CLEAR'; sessionId: string },
): Promise<void> {
	await serviceWorker.evaluate(
		async ({ id, msg }) => {
			await chrome.tabs.sendMessage(id, msg);
		},
		{ id: tabId, msg: message },
	);
}

async function currentHighlightText(page: Page): Promise<string | null> {
	return page.evaluate((name) => {
		const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
		const [range] = highlight ? [...highlight] : [];
		return range ? range.toString() : null;
	}, highlightRegistryName);
}

test('highlights the current word as WORD_HIGHLIGHT_UPDATE messages arrive, and clears on WORD_HIGHLIGHT_CLEAR', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="en"><head><title>Word highlight page</title></head><body>
				<article><p id="content">First sentence about testing.</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker, targetUrl);

	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-session', word: 'First' });
	await expect.poll(() => currentHighlightText(page)).toBe('First');

	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-session', word: 'sentence' });
	await expect.poll(() => currentHighlightText(page)).toBe('sentence');

	await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: 'e2e-session' });
	await expect
		.poll(() =>
			page.evaluate(
				(name) => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has(name),
				highlightRegistryName,
			),
		)
		.toBe(false);
});

test('advances past a repeated word instead of matching the same earlier occurrence again', async ({ context }) => {
	const targetUrl = 'https://readit.test/word-highlight-repeat';
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="en"><head><title>Repeat page</title></head><body>
				<article><p id="content">The cat sat on the mat.</p></article>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

	const serviceWorker = findExtensionServiceWorker(context);
	const tabId = await getTabId(serviceWorker, targetUrl);

	for (const word of ['The', 'cat', 'sat', 'on', 'the']) {
		await sendWordHighlightMessage(serviceWorker, tabId, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'e2e-repeat', word });
	}

	await expect
		.poll(() =>
			page.evaluate((name) => {
				const highlight = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get(name);
				const [range] = highlight ? [...highlight] : [];
				if (!range) {
					return null;
				}
				const following = range.startContainer.textContent?.slice(range.endOffset, range.endOffset + 4);
				return { matched: range.toString(), following };
			}, highlightRegistryName),
		)
		.toEqual({ matched: 'the', following: ' mat' });
});
```

- [ ] **Step 2: Build the extension**

Run: `pnpm build`
Expected: succeeds, produces `dist/`.

- [ ] **Step 3: Run the test**

Run: `npx playwright test tests/e2e/word-highlight.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/word-highlight.spec.ts
git commit -m "test: cover word-highlight DOM matching and clearing end-to-end"
```

---

### Task 12: Manual verification pass

**Files:** none (verification only)

- [ ] **Step 1: Build and load the extension**

Run: `pnpm build`
In Chrome, open `chrome://extensions`, enable Developer mode, and use “Load unpacked” with the `dist/` directory.

- [ ] **Step 2: Verify on a Vietnamese page with numbers/dates**

Open a Vietnamese article containing a number or date, such as “ngày 17/07/2026”, and choose “Read current page.” Verify that the spoken word is highlighted and that when TTS expands the date into multiple spoken words, the original `17/07/2026` token is highlighted as one continuous unit rather than separate syllables.

- [ ] **Step 3: Verify on an English page**

Open an English article, start reading, and verify that each word is highlighted in spoken order.

- [ ] **Step 4: Verify pause/resume/stop**

Pause during playback and verify that the highlight remains on the last word. Resume and verify that highlighting continues without jumping forward or backward. Stop and verify that the highlight disappears.

- [ ] **Step 5: Verify selected-text reading**

Select a passage in the middle of an article and activate the floating read button. Verify that highlighting starts at the exact selected position rather than jumping to the beginning of the page.

- [ ] **Step 6: Verify the settings toggle**

Disable “Highlight spoken word on page” in the popup, start reading again, and verify that no page highlight appears.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm test:unit`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx playwright test`
Expected: PASS for the complete E2E suite, including the new test and all existing regression coverage.

- [ ] **Step 8: Commit any final fixups**

```bash
git add -A
git commit -m "chore: manual verification pass for word highlighting"
```

---
