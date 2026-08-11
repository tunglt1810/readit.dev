# Custom Pronunciation Dictionary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-managed pronunciation dictionary that replaces words in TTS synthesis text without affecting highlights.

**Architecture:** Post-planning `synthesisText` injection. A pure matching engine receives `SpeechUnit[]` + rules, assigns `synthesisText` on matched units. Applied in `playback_preparation.ts` between unit planning and consolidation. Settings page opens as a separate tab. Context menu quick-add under existing `readit-menu`.

**Tech Stack:** TypeScript, React, Rsbuild, `webextension-polyfill`, `node:test` + `node:assert/strict`

**Spec:** [2026-08-11-pronunciation-dictionary-design.md](file:///Users/bez/Workspace/repos/bez/readit.dev/docs/specs/2026-08-11-pronunciation-dictionary-design.md)

## Global Constraints

- Strict TypeScript, Biome formatting (tabs, 4-space tab width, LF, 140 char line width)
- `node:test` + `node:assert/strict` for unit tests (no Jest/Vitest)
- `webextension-polyfill` for cross-browser storage (Firefox support)
- `chrome.storage.local` only — no remote sync
- Cap: 200 rules max
- Existing `chrome.storage` callsites NOT migrated — only new code uses wrapper
- Import paths use `.ts` extension (e.g. `'../../src/foo/bar.ts'`)

---

### Task 1: Data Model, Constants & Storage Wrapper

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`
- Create: `src/shared/storage.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PronunciationRule` type (used by Tasks 2, 3, 4, 5)
  - `STORAGE_KEYS.PRONUNCIATION_DICTIONARY` constant (used by Tasks 3, 4, 5)
  - `browserStorage` wrapper (used by Tasks 3, 4, 5)

- [ ] **Step 1: Add `PronunciationRule` interface to `src/shared/types.ts`**

Append at end of file:

```typescript
/** A user-defined pronunciation replacement rule applied before TTS synthesis. */
export interface PronunciationRule {
	id: string;
	match: string;
	replacement: string;
	wholeWord: boolean;
	caseSensitive: boolean;
	lang?: 'en' | 'vi' | 'zh';
	enabled: boolean;
	createdAt: number;
}
```

- [ ] **Step 2: Add storage key to `src/shared/constants.ts`**

Add to `STORAGE_KEYS` object:

```typescript
PRONUNCIATION_DICTIONARY: 'readit_pronunciation_dictionary',
```

- [ ] **Step 3: Create cross-browser storage wrapper `src/shared/storage.ts`**

```typescript
import browser from 'webextension-polyfill';

/**
 * Cross-browser storage wrapper using webextension-polyfill.
 * New modules should use this instead of chrome.storage directly.
 */
export const browserStorage = browser.storage.local;
```

- [ ] **Step 4: Verify build compiles**

Run: ` pnpm build`
Expected: no type errors

- [ ] **Step 5: Commit**

```bash
 git add src/shared/types.ts src/shared/constants.ts src/shared/storage.ts
 git commit -m "feat(pronunciation): add PronunciationRule type, storage key, and browser storage wrapper"
```

---

### Task 2: Matching Engine (TDD Core)

**Files:**
- Create: `src/offscreen/pronunciation_dictionary.ts`
- Create: `tests/unit/pronunciation_dictionary.test.ts`

**Interfaces:**
- Consumes: `PronunciationRule` from `src/shared/types.ts`, `SpeechUnit` from `src/offscreen/speech_unit.ts`
- Produces: `applyPronunciationDictionary(units: SpeechUnit[], rules: readonly PronunciationRule[], lang: string): void` (used by Task 3)

#### Cycle 1: Basic exact match

- [ ] **Step 1: Write failing test — exact match assigns synthesisText**

Create `tests/unit/pronunciation_dictionary.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPronunciationDictionary } from '../../src/offscreen/pronunciation_dictionary.ts';
import type { PronunciationRule } from '../../src/shared/types.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

function makeUnit(text: string, synthesisText?: string): SpeechUnit {
	return { text, synthesisText, sourceOffset: 0, pauseAfterMs: 0 } as SpeechUnit;
}

function makeRule(match: string, replacement: string, overrides?: Partial<PronunciationRule>): PronunciationRule {
	return {
		id: crypto.randomUUID(),
		match,
		replacement,
		wholeWord: true,
		caseSensitive: true,
		enabled: true,
		createdAt: Date.now(),
		...overrides,
	};
}

test('exact match assigns synthesisText, leaves text unchanged', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
	assert.equal(units[0].text, 'HTML is great');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: ` pnpm test:unit -- --test-name-pattern "exact match"`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/offscreen/pronunciation_dictionary.ts`:

```typescript
import type { PronunciationRule } from '../shared/types.ts';
import type { SpeechUnit } from './speech_unit.ts';

export function applyPronunciationDictionary(
	units: SpeechUnit[],
	rules: readonly PronunciationRule[],
	lang: string,
): void {
	const activeRules = rules
		.filter((r) => r.enabled && (!r.lang || r.lang === lang))
		.sort((a, b) => b.match.length - a.match.length);

	if (activeRules.length === 0) return;

	for (const unit of units) {
		let source = unit.synthesisText ?? unit.text;
		let changed = false;

		for (const rule of activeRules) {
			const idx = source.indexOf(rule.match);
			if (idx === -1) continue;
			if (rule.wholeWord && !isWholeWordMatch(source, idx, rule.match.length)) continue;
			source = source.replaceAll(rule.match, rule.replacement);
			changed = true;
		}

		if (changed) {
			unit.synthesisText = source;
		}
	}
}

function isWholeWordMatch(text: string, startIdx: number, matchLength: number): boolean {
	const before = startIdx > 0 ? text[startIdx - 1] : ' ';
	const after = startIdx + matchLength < text.length ? text[startIdx + matchLength] : ' ';
	return /\s|^$/.test(before) && /\s|[.,;:!?)]|^$/.test(after);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: ` pnpm test:unit -- --test-name-pattern "exact match"`
Expected: PASS

#### Cycle 2: Whole-word boundary

- [ ] **Step 5: Write failing test — wholeWord prevents partial match**

```typescript
test('wholeWord=true does not match inside another word', () => {
	const units = [makeUnit('the USB controller')];
	const rules = [makeRule('US', 'united states')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, undefined);
});

test('wholeWord=false matches inside words', () => {
	const units = [makeUnit('the USB controller')];
	const rules = [makeRule('US', 'united states', { wholeWord: false })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'the united statesB controller');
});
```

- [ ] **Step 6: Run tests to verify they fail correctly**

Run: ` pnpm test:unit -- --test-name-pattern "wholeWord"`
Expected: first test may pass (boundary check already implemented), second should fail

- [ ] **Step 7: Update implementation if needed to handle wholeWord=false**

In `applyPronunciationDictionary`, the wholeWord check is skipped when `rule.wholeWord === false`:

```typescript
if (rule.wholeWord && !isWholeWordMatch(source, idx, rule.match.length)) continue;
```

This is already in the Step 3 implementation. If second test fails, adjust to skip boundary check when `wholeWord === false`.

- [ ] **Step 8: Run tests to verify they pass**

Run: ` pnpm test:unit -- --test-name-pattern "wholeWord"`
Expected: PASS

#### Cycle 3: Case sensitivity

- [ ] **Step 9: Write failing test — case-insensitive matching**

```typescript
test('caseSensitive=true does not match different case', () => {
	const units = [makeUnit('html is great')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, undefined);
});

test('caseSensitive=false matches regardless of case', () => {
	const units = [makeUnit('html is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { caseSensitive: false })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
});
```

- [ ] **Step 10: Run tests, verify first passes and second fails**

Run: ` pnpm test:unit -- --test-name-pattern "caseSensitive"`
Expected: first PASS, second FAIL

- [ ] **Step 11: Implement case-insensitive matching**

Update the matching loop in `applyPronunciationDictionary`:

```typescript
for (const rule of activeRules) {
	const searchSource = rule.caseSensitive ? source : source.toLowerCase();
	const searchMatch = rule.caseSensitive ? rule.match : rule.match.toLowerCase();
	const idx = searchSource.indexOf(searchMatch);
	if (idx === -1) continue;
	if (rule.wholeWord && !isWholeWordMatch(source, idx, rule.match.length)) continue;

	if (rule.caseSensitive) {
		source = source.replaceAll(rule.match, rule.replacement);
	} else {
		source = source.replace(new RegExp(escapeRegExp(rule.match), 'gi'), rule.replacement);
	}
	changed = true;
}
```

Add helper:

```typescript
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 12: Run tests to verify they pass**

Run: ` pnpm test:unit -- --test-name-pattern "caseSensitive"`
Expected: PASS

#### Cycle 4: Language filtering

- [ ] **Step 13: Write failing test — lang filter**

```typescript
test('rule with lang="en" is skipped for Vietnamese units', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { lang: 'en' })];
	applyPronunciationDictionary(units, rules, 'vi');
	assert.equal(units[0].synthesisText, undefined);
});

test('rule with lang="en" applies for English units', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { lang: 'en' })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
});

test('rule without lang applies to all languages', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'vi');
	assert.equal(units[0].synthesisText, 'aitch tee em el is great');
});
```

- [ ] **Step 14: Run tests to verify they pass** (lang filter already implemented in Step 3)

Run: ` pnpm test:unit -- --test-name-pattern "lang"`
Expected: PASS (filter logic in Step 3 covers this)

#### Cycle 5: Longest-match-first precedence

- [ ] **Step 15: Write failing test — longest match wins**

```typescript
test('longest match wins when multiple rules match same position', () => {
	const units = [makeUnit('USA is a country')];
	const rules = [
		makeRule('US', 'united states'),
		makeRule('USA', 'united states of america'),
	];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'united states of america is a country');
});
```

- [ ] **Step 16: Run test to verify it passes** (sort by length already in Step 3)

Run: ` pnpm test:unit -- --test-name-pattern "longest"`
Expected: PASS

#### Cycle 6: Enabled filter

- [ ] **Step 17: Write failing test — disabled rules skipped**

```typescript
test('disabled rules are skipped', () => {
	const units = [makeUnit('HTML is great')];
	const rules = [makeRule('HTML', 'aitch tee em el', { enabled: false })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, undefined);
});
```

- [ ] **Step 18: Run test to verify it passes** (enabled filter in Step 3)

Run: ` pnpm test:unit -- --test-name-pattern "disabled"`
Expected: PASS

#### Cycle 7: Existing synthesisText

- [ ] **Step 19: Write failing test — applies on existing synthesisText**

```typescript
test('applies dictionary on existing synthesisText, not text', () => {
	const units = [makeUnit('original text', 'HTML was normalized')];
	const rules = [makeRule('HTML', 'aitch tee em el')];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el was normalized');
	assert.equal(units[0].text, 'original text');
});
```

- [ ] **Step 20: Run test to verify it passes** (synthesisText ?? text fallback in Step 3)

Run: ` pnpm test:unit -- --test-name-pattern "existing synthesisText"`
Expected: PASS

#### Cycle 8: Edge cases

- [ ] **Step 21: Write failing tests — edge cases**

```typescript
test('empty rules array does not mutate units', () => {
	const units = [makeUnit('HTML is great')];
	applyPronunciationDictionary(units, [], 'en');
	assert.equal(units[0].synthesisText, undefined);
});

test('empty replacement removes matched text', () => {
	const units = [makeUnit('sponsored HTML content')];
	const rules = [makeRule('sponsored', '', { wholeWord: true })];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, ' HTML content');
});

test('multiple rules match different positions in same unit', () => {
	const units = [makeUnit('HTML and CSS')];
	const rules = [
		makeRule('HTML', 'aitch tee em el'),
		makeRule('CSS', 'see ess ess'),
	];
	applyPronunciationDictionary(units, rules, 'en');
	assert.equal(units[0].synthesisText, 'aitch tee em el and see ess ess');
});
```

- [ ] **Step 22: Run tests to verify they pass**

Run: ` pnpm test:unit`
Expected: ALL PASS

- [ ] **Step 23: Commit**

```bash
 git add src/offscreen/pronunciation_dictionary.ts tests/unit/pronunciation_dictionary.test.ts
 git commit -m "feat(pronunciation): add matching engine with TDD tests"
```

---

### Task 3: Pipeline Integration

**Files:**
- Modify: `src/offscreen/playback_preparation.ts`
- Modify: `src/offscreen/offscreen.ts`

**Interfaces:**
- Consumes: `applyPronunciationDictionary` from Task 2, `PronunciationRule` from Task 1, `browserStorage` from Task 1, `STORAGE_KEYS` from Task 1
- Produces: `preparePlaybackUnits` gains optional `pronunciationRules` parameter (internal change)

- [ ] **Step 1: Modify `preparePlaybackUnits` to accept and apply rules**

In `src/offscreen/playback_preparation.ts`:

Add imports:
```typescript
import { applyPronunciationDictionary } from './pronunciation_dictionary.ts';
import type { PronunciationRule } from '../shared/types.ts';
```

Change `preparePlaybackUnits` signature (line 52) to accept rules:
```typescript
export async function preparePlaybackUnits(
	rawText: string,
	lang: string,
	normalizer: VietnameseTextNormalizer | null,
	pronunciationRules: readonly PronunciationRule[] = [],
): Promise<SpeechUnit[]> {
```

Insert `applyPronunciationDictionary` call in the non-Vietnamese path (around line 63-66). Change from:
```typescript
if (!isVietnameseLanguage(lang)) {
	const planned = isPredominantlyLatinText(planningText)
		? plannedUnits(paragraphs, lang, null)
		: compatibilityUnits(paragraphs, lang, null);
	return attachPlainWordMap(consolidate(planned, lang));
}
```
To:
```typescript
if (!isVietnameseLanguage(lang)) {
	const planned = isPredominantlyLatinText(planningText)
		? plannedUnits(paragraphs, lang, null)
		: compatibilityUnits(paragraphs, lang, null);
	applyPronunciationDictionary(planned, pronunciationRules, lang);
	return attachPlainWordMap(consolidate(planned, lang));
}
```

Insert in Vietnamese normalizer path (around line 75-80). Change from:
```typescript
const planned = planLatinSpeechUnits(normalizeSourceText(result.text).paragraphs).filter(
	({ text: unit }) => unit.trim().length > 0,
);
return planned.length > 0
	? attachNormalizedWordMap(consolidate(validateCapacity(planned, lang), lang), result.text, result.wordMap)
	: attachPlainWordMap(consolidate(vietnameseFallback(paragraphs, lang), lang));
```
To:
```typescript
const planned = planLatinSpeechUnits(normalizeSourceText(result.text).paragraphs).filter(
	({ text: unit }) => unit.trim().length > 0,
);
applyPronunciationDictionary(planned, pronunciationRules, lang);
return planned.length > 0
	? attachNormalizedWordMap(consolidate(validateCapacity(planned, lang), lang), result.text, result.wordMap)
	: attachPlainWordMap(consolidate(vietnameseFallback(paragraphs, lang), lang));
```

Insert in Vietnamese fallback paths (line 69 and catch block ~line 85). For both `vietnameseFallback` calls, change pattern from:
```typescript
return attachPlainWordMap(consolidate(vietnameseFallback(paragraphs, lang), lang));
```
To:
```typescript
const fallback = vietnameseFallback(paragraphs, lang);
applyPronunciationDictionary(fallback, pronunciationRules, lang);
return attachPlainWordMap(consolidate(fallback, lang));
```

- [ ] **Step 2: Load rules in `offscreen.ts` and pass to `preparePlaybackUnits`**

In `src/offscreen/offscreen.ts`, around line 1335-1344.

Add imports:
```typescript
import { browserStorage } from '../shared/storage.ts';
import type { PronunciationRule } from '../shared/types.ts';
```

(`STORAGE_KEYS` should already be imported — verify.)

Before the `preparePlaybackUnits` call (line 1344), add:

```typescript
const storageResult = await browserStorage.get(STORAGE_KEYS.PRONUNCIATION_DICTIONARY);
const pronunciationRules: PronunciationRule[] =
	(storageResult[STORAGE_KEYS.PRONUNCIATION_DICTIONARY] as PronunciationRule[] | undefined) ?? [];

const preparedUnits = await preparePlaybackUnits(article.content, article.lang, normalizer, pronunciationRules);
```

Replace the existing `preparePlaybackUnits(article.content, article.lang, normalizer)` call with the new one above.

- [ ] **Step 3: Verify build compiles**

Run: ` pnpm build`
Expected: no type errors

- [ ] **Step 4: Run all unit tests to ensure no regression**

Run: ` pnpm test:unit`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
 git add src/offscreen/playback_preparation.ts src/offscreen/offscreen.ts
 git commit -m "feat(pronunciation): wire dictionary into playback pipeline"
```

---

### Task 4: Settings Page

**Files:**
- Create: `src/settings/index.tsx`
- Create: `src/settings/settings.html`
- Create: `src/settings/settings.css`
- Create: `src/settings/SettingsApp.tsx`
- Modify: `rsbuild.config.ts`
- Modify: `public/manifest.json`

**Interfaces:**
- Consumes: `PronunciationRule` from Task 1, `browserStorage` from Task 1, `STORAGE_KEYS` from Task 1, `t()` from `src/shared/i18n.ts`, i18n keys from Task 6
- Produces: Settings page at `src/settings/settings.html` (used by Task 5 for navigation)

- [ ] **Step 1: Add build entry in `rsbuild.config.ts`**

Add `settings` entry to `source.entry` alongside existing entries:
```typescript
settings: './src/settings/index.tsx',
```

Add template mapping in `html.template` function:
```typescript
if (entryName === 'settings') {
	return './src/settings/settings.html';
}
```

Add filename mapping in `tools.htmlPlugin` function:
```typescript
if (entryName === 'settings') {
	config.filename = 'src/settings/settings.html';
}
```

- [ ] **Step 2: Create `src/settings/settings.html`**

```html
<!doctype html>
<html>
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>readit.dev — Pronunciation Dictionary</title>
</head>
<body>
	<div id="root"></div>
</body>
</html>
```

- [ ] **Step 3: Create `src/settings/index.tsx`**

```typescript
import { createRoot } from 'react-dom/client';
import { SettingsApp } from './SettingsApp.tsx';
import './settings.css';

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<SettingsApp />);
}
```

- [ ] **Step 4: Create `src/settings/SettingsApp.tsx`**

React component implementing:

1. **State**: `rules: PronunciationRule[]`, `langFilter: string`, `editingId: string | null`
2. **Load**: on mount, read rules from `browserStorage.get(STORAGE_KEYS.PRONUNCIATION_DICTIONARY)`
3. **Save**: helper that writes rules to storage after each mutation
4. **Pre-fill**: on mount, read `?match=` from `window.location.search`, if present open inline add form with match pre-filled
5. **Add**: push new rule with defaults (`wholeWord: true`, `caseSensitive: true`, `enabled: true`)
6. **Edit**: inline edit mode per row
7. **Delete**: remove rule by id
8. **Toggle enabled**: checkbox on each row
9. **Language filter**: select filters displayed groups
10. **Grouping**: group rules by `rule.lang` — order: undefined → "All Languages", `'en'` → "English", `'vi'` → "Tiếng Việt", `'zh'` → "中文"
11. **Counter**: show `{count}/200`
12. **Validation**: reject add when at 200 cap, reject empty match

Key component structure:
```typescript
import { useEffect, useState } from 'react';
import { browserStorage } from '../shared/storage.ts';
import { STORAGE_KEYS } from '../shared/constants.ts';
import { t } from '../shared/i18n.ts';
import type { PronunciationRule } from '../shared/types.ts';

const LANG_ORDER: Array<PronunciationRule['lang']> = [undefined, 'en', 'vi', 'zh'];
const LANG_LABELS: Record<string, string> = {
	all: () => t('ruleLanguageAll'),
	en: () => t('ruleLanguageEn'),
	vi: () => t('ruleLanguageVi'),
	zh: () => t('ruleLanguageZh'),
};
const MAX_RULES = 200;

export function SettingsApp() {
	const [rules, setRules] = useState<PronunciationRule[]>([]);
	const [langFilter, setLangFilter] = useState<string>('all');
	const [editingId, setEditingId] = useState<string | null>(null);

	useEffect(() => {
		void loadRules();
	}, []);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const prefill = params.get('match');
		if (prefill) {
			// Open add form with match pre-filled
			handleAdd(prefill);
		}
	}, []);

	async function loadRules() {
		const result = await browserStorage.get(STORAGE_KEYS.PRONUNCIATION_DICTIONARY);
		setRules((result[STORAGE_KEYS.PRONUNCIATION_DICTIONARY] as PronunciationRule[] | undefined) ?? []);
	}

	async function saveRules(updated: PronunciationRule[]) {
		setRules(updated);
		await browserStorage.set({ [STORAGE_KEYS.PRONUNCIATION_DICTIONARY]: updated });
	}

	function handleAdd(prefillMatch = '') {
		if (rules.length >= MAX_RULES) return;
		const newRule: PronunciationRule = {
			id: crypto.randomUUID(),
			match: prefillMatch,
			replacement: '',
			wholeWord: true,
			caseSensitive: true,
			enabled: true,
			createdAt: Date.now(),
		};
		setRules([newRule, ...rules]);
		setEditingId(newRule.id);
	}

	// ... handlers for save, delete, toggle, grouping, filtering, rendering
}
```

- [ ] **Step 5: Create `src/settings/settings.css`**

Style the page following existing theme variables. Key elements:
- Page container: max-width 640px, centered
- Header with title
- Toolbar: add button, language filter select, counter
- Group headers with language names
- Rule rows: checkbox, match → replacement, lang badge, edit/delete buttons
- Inline edit form with inputs and toggles
- Use same CSS custom properties as popup for theme consistency
- Responsive for different screen sizes

- [ ] **Step 6: Verify build compiles and page renders**

Run: ` pnpm build`
Expected: no errors, `dist/chrome/src/settings/settings.html` exists

- [ ] **Step 7: Commit**

```bash
 git add src/settings/ rsbuild.config.ts public/manifest.json
 git commit -m "feat(pronunciation): add settings page with inline rule editing"
```

---

### Task 5: Context Menu & Popup Link

**Files:**
- Modify: `src/background/context_menu.ts`
- Modify: `src/background/background.ts`
- Modify: `src/popup/App.tsx`

**Interfaces:**
- Consumes: Settings page URL from Task 4, `t()` i18n, i18n keys from Task 6
- Produces: context menu item `readit-add-pronunciation-rule`, popup link to settings page

- [ ] **Step 1: Add context menu sub-item in `src/background/context_menu.ts`**

After the `readit-replay-queue` block (around line 62), before `resolve()`, add separator and new item:

```typescript
// Separator before pronunciation
chrome.contextMenus.create({
	id: 'readit-pronunciation-separator',
	parentId: 'readit-menu',
	type: 'separator',
	contexts: ['selection'],
	documentUrlPatterns: ['http://*/*', 'https://*/*'],
});

// Add pronunciation rule
chrome.contextMenus.create({
	id: 'readit-add-pronunciation-rule',
	parentId: 'readit-menu',
	title: t('contextMenuAddRule'),
	contexts: ['selection'],
	documentUrlPatterns: ['http://*/*', 'https://*/*'],
});
```

- [ ] **Step 2: Add click handler in `src/background/background.ts`**

In the `contextMenus.onClicked` listener (around line 1939), add a new branch before the existing `readit-read-selection` handler:

```typescript
if (info.menuItemId === 'readit-add-pronunciation-rule') {
	const selectedText = info.selectionText?.trim() ?? '';
	const settingsUrl = chrome.runtime.getURL(
		`src/settings/settings.html?match=${encodeURIComponent(selectedText)}`,
	);
	void chrome.tabs.create({ url: settingsUrl });
	return;
}
```

- [ ] **Step 3: Add link in popup `src/popup/App.tsx`**

Below the `<SettingsCard>` component (around line 500), add a button that opens the settings page:

```typescript
<button
	className="pronunciation-dictionary-link"
	type="button"
	onClick={() => {
		void chrome.tabs.create({
			url: chrome.runtime.getURL('src/settings/settings.html'),
		});
		window.close();
	}}
>
	📖 {t('pronunciationDictionary')}
</button>
```

Add minimal styling for the link in `src/popup/popup.css`.

- [ ] **Step 4: Verify build compiles**

Run: ` pnpm build`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
 git add src/background/context_menu.ts src/background/background.ts src/popup/App.tsx src/popup/popup.css
 git commit -m "feat(pronunciation): add context menu quick-add and popup link"
```

---

### Task 6: Localization

**Files:**
- Modify: `src/shared/locales/en.json`
- Modify: `src/shared/locales/vi.json`

**Interfaces:**
- Consumes: nothing
- Produces: i18n keys used by Tasks 4, 5

> **Note:** This task should be completed before Tasks 4-5 which reference the i18n keys. Can be done in parallel with Tasks 2-3.

- [ ] **Step 1: Add keys to `src/shared/locales/en.json`**

```json
"pronunciationDictionary": "Pronunciation Dictionary",
"addRule": "Add Rule",
"editRule": "Edit rule",
"deleteRule": "Delete rule",
"ruleMatch": "Match",
"ruleSpeaksAs": "Speaks as",
"ruleWholeWord": "Whole word",
"ruleCaseSensitive": "Case sensitive",
"ruleLanguage": "Language",
"ruleLanguageAll": "All Languages",
"ruleLanguageEn": "English",
"ruleLanguageVi": "Tiếng Việt",
"ruleLanguageZh": "中文",
"ruleLimitWarning": "Rule limit reached (200/200)",
"emptyDictionary": "No rules yet. Add a rule to customize how words are pronounced.",
"contextMenuAddRule": "Add pronunciation rule for \"%s\"",
"ruleSaveButton": "Save",
"ruleCancelButton": "Cancel",
"ruleDeleteConfirm": "Delete this rule?"
```

- [ ] **Step 2: Add keys to `src/shared/locales/vi.json`**

```json
"pronunciationDictionary": "Từ điển phát âm",
"addRule": "Thêm quy tắc",
"editRule": "Sửa quy tắc",
"deleteRule": "Xóa quy tắc",
"ruleMatch": "Từ gốc",
"ruleSpeaksAs": "Đọc là",
"ruleWholeWord": "Khớp nguyên từ",
"ruleCaseSensitive": "Phân biệt hoa thường",
"ruleLanguage": "Ngôn ngữ",
"ruleLanguageAll": "Tất cả ngôn ngữ",
"ruleLanguageEn": "English",
"ruleLanguageVi": "Tiếng Việt",
"ruleLanguageZh": "中文",
"ruleLimitWarning": "Đã đạt giới hạn quy tắc (200/200)",
"emptyDictionary": "Chưa có quy tắc nào. Thêm quy tắc để tùy chỉnh cách đọc từ.",
"contextMenuAddRule": "Thêm quy tắc phát âm cho \"%s\"",
"ruleSaveButton": "Lưu",
"ruleCancelButton": "Hủy",
"ruleDeleteConfirm": "Xóa quy tắc này?"
```

- [ ] **Step 3: Verify build compiles**

Run: ` pnpm build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
 git add src/shared/locales/en.json src/shared/locales/vi.json
 git commit -m "feat(pronunciation): add i18n keys for pronunciation dictionary"
```

---

### Task 7: E2E Tests

**Files:**
- Create: `tests/e2e/pronunciation_dictionary.spec.ts`

**Interfaces:**
- Consumes: all previous tasks (settings page, context menu, storage, pipeline)
- Produces: E2E test coverage

- [ ] **Step 1: Read existing E2E fixture patterns**

Read `tests/e2e/fixtures.ts` to understand the test setup, extension loading, and page helpers. Match existing patterns for `context`, `extensionId`, and page navigation.

- [ ] **Step 2: Write E2E test — add rule via settings page and verify persistence**

Create `tests/e2e/pronunciation_dictionary.spec.ts`:

```typescript
import { test, expect } from './fixtures.ts';

test('add pronunciation rule via settings page and verify persistence', async ({ context, extensionId }) => {
	const settingsPage = await context.newPage();
	await settingsPage.goto(`chrome-extension://${extensionId}/src/settings/settings.html`);

	// Click add rule
	await settingsPage.click('button:has-text("Add Rule")');

	// Fill in rule
	await settingsPage.fill('[aria-label="Match"]', 'HTML');
	await settingsPage.fill('[aria-label="Speaks as"]', 'aitch tee em el');
	await settingsPage.click('button:has-text("Save")');

	// Verify rule appears in list
	await expect(settingsPage.locator('text=HTML')).toBeVisible();
	await expect(settingsPage.locator('text=aitch tee em el')).toBeVisible();

	// Verify counter
	await expect(settingsPage.locator('text=1/200')).toBeVisible();

	// Close and reopen to verify persistence
	await settingsPage.close();
	const settingsPage2 = await context.newPage();
	await settingsPage2.goto(`chrome-extension://${extensionId}/src/settings/settings.html`);
	await expect(settingsPage2.locator('text=HTML')).toBeVisible();
	await expect(settingsPage2.locator('text=aitch tee em el')).toBeVisible();
});
```

- [ ] **Step 3: Write E2E test — toggle enable/disable**

```typescript
test('toggle rule enabled/disabled', async ({ context, extensionId }) => {
	const settingsPage = await context.newPage();
	await settingsPage.goto(`chrome-extension://${extensionId}/src/settings/settings.html`);

	// Add rule
	await settingsPage.click('button:has-text("Add Rule")');
	await settingsPage.fill('[aria-label="Match"]', 'CSS');
	await settingsPage.fill('[aria-label="Speaks as"]', 'see ess ess');
	await settingsPage.click('button:has-text("Save")');

	// Toggle off
	const checkbox = settingsPage.locator('.rule-row').first().locator('input[type="checkbox"]');
	await checkbox.uncheck();

	// Reload and verify still unchecked
	await settingsPage.reload();
	const reloadedCheckbox = settingsPage.locator('.rule-row').first().locator('input[type="checkbox"]');
	await expect(reloadedCheckbox).not.toBeChecked();
});
```

- [ ] **Step 4: Write E2E test — context menu opens settings with pre-filled match**

```typescript
test('context menu opens settings page with match pre-filled', async ({ context, extensionId }) => {
	// Test the URL-based pre-fill directly (Playwright has limited context menu support)
	const settingsPage = await context.newPage();
	await settingsPage.goto(
		`chrome-extension://${extensionId}/src/settings/settings.html?match=${encodeURIComponent('GPT-4')}`,
	);

	// Verify match field is pre-filled and editor is open
	await expect(settingsPage.locator('[aria-label="Match"]')).toHaveValue('GPT-4');
});
```

- [ ] **Step 5: Build extension and run E2E tests**

Run:
```bash
 pnpm build
 pnpm test:e2e -- --grep "pronunciation"
```
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
 git add tests/e2e/pronunciation_dictionary.spec.ts
 git commit -m "test(pronunciation): add E2E tests for settings page and context menu"
```
