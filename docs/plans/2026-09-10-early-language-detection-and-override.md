# Early language detection and manual override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The panel shows the right language and voice list *before* play is pressed, and lets the reader pick a language that playback will not override.

**Architecture:** Three independent layers. (1) `detectContentLanguage()` gains a script-detection step which overrides `declaredLang` only when the observed writing system contradicts the declared language's own. (2) The content script runs detection against a `body.innerText` sample inside `GET_PAGE_INFO`, so the panel knows the language from the moment it opens. (3) The panel carries a language `<select>`; its value travels with the START command and is applied to `content.lang` at the top of `startPlayback()` — the single place everything downstream reads the language from.

**Tech Stack:** Bun 1.4+, TypeScript, React 18, `node:test` + `node:assert/strict` run under `bun test`, Playwright for e2e, Biome for lint.

**Spec:** `docs/specs/2026-09-10-early-language-detection-and-override-design.md`

---

## Context for someone new to this codebase

- This is a Chrome/Firefox MV3 extension that reads web pages aloud. Three UI surfaces: **popup** (`src/popup/`), **side panel** (`src/sidepanel/`) and **reader** (`src/reader/`). All of them share `src/shared/components/SettingsCard.tsx`.
- The **service worker** is `src/background/background.ts`. It receives messages from the UI, asks the content script to extract content, then feeds that content to the **offscreen document** (`src/offscreen/`) for speech synthesis.
- There are **two TTS engines**: `edge` (Microsoft edge-tts, voices per locale) and `supertonic` (on-device, via ONNX). Edge voices are stored per base language; the on-device voice is a single global value.
- `content.lang` is **the single field** that drives the edge voice choice, the default speed, text segmentation, and whether the Vietnamese normalizer runs. This whole plan therefore comes down to getting that one field right, earlier, and making it overridable.
- Running tests: `bun test tests/unit/<file>` for unit tests, `bunx playwright test tests/e2e/<file>` for e2e. **Do not use npm/npx/node.**
- Lint: `bunx biome check --write <file>` before committing.

## File structure

**New:**

| File | Responsibility |
|---|---|
| `src/shared/script_detection.ts` | Names the dominant writing system of a piece of text. Pure — no DOM, no chrome API. |
| `src/shared/supertonic_languages.ts` | The on-device language list, split out of `supertonic_helper.ts` so the panel does not drag in the ONNX runtime. |
| `src/shared/language_options.ts` | Builds the dropdown's language list for the selected engine. |
| `src/content/page_language.ts` | Decides the page's language from URL + declared lang + text sample, and whether that sample is trustworthy. |
| `src/background/language_override.ts` | Reads and normalises `languageOverride` out of a message payload. |
| `tests/unit/script_detection.test.ts` | |
| `tests/unit/language_options.test.ts` | |
| `tests/unit/page_language.test.ts` | |
| `tests/unit/language_override.test.ts` | |

**Modified:**

| File | Change |
|---|---|
| `src/shared/language_detection.ts` | Insert the script layer into `detectContentLanguage()` |
| `src/offscreen/supertonic_helper.ts` | Re-export `AVAILABLE_LANGS` from the new module |
| `src/shared/edge_voices.ts` | Add `edgeBaseLanguages()` |
| `src/shared/types.ts` | `PageInfoResponse.langSource`, widen `ManualTextLanguage` |
| `src/content/content_script.ts` | Use `resolvePageLanguage()` inside `GET_PAGE_INFO` |
| `src/background/page_info.ts` | `pageInfoFromTab()` returns `langSource` |
| `src/background/background.ts` | `languageOverride` in `StartPlaybackInput`, `startPlayback()`, `startCurrentPage()` |
| `src/background/manual_text.ts` | Validate against the engine list; `auto` goes through the script layer |
| `src/shared/components/SettingsCard.tsx` | The language `<select>` |
| `src/shared/locales/en.json`, `vi.json` | New keys |
| `src/sidepanel/App.tsx`, `src/popup/App.tsx` | Override state, passed down to SettingsCard and onto the START command |
| `tests/unit/language_detection.test.ts`, `page_info.test.ts`, `manual_text.test.ts` | |
| `tests/e2e/side-panel.spec.ts` | |

Tasks run from the pure core outwards to the UI. Tasks 1–4 touch no UI and each commits on its own.

---

### Task 1: Detecting the dominant script

**Files:**
- Create: `src/shared/script_detection.ts`
- Test: `tests/unit/script_detection.test.ts`

This module answers one question: which writing system is this text in. It does **not** guess a language — mapping a script onto a language is Task 2's job.

`ScriptFamily` collapses Han/Hiragana/Katakana/Hangul into three families `ja`/`zh`/`ko`, because kana and hangul are the only reliable separators between those three languages.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/script_detection.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { dominantScriptFamily } from '../../src/shared/script_detection.ts';

const ENGLISH = 'Romantic rejection activates the same brain regions implicated in physical pain.';
const JAPANESE = '日本語のテキストはひらがなとカタカナと漢字を混ぜて書かれています。';
const CHINESE = '人工智能正在改变人们获取知识的方式，很多新工具让人难以跟上。';
const KOREAN = '인공지능은 사람들이 지식을 얻는 방식을 바꾸고 있습니다.';
const RUSSIAN = 'Искусственный интеллект меняет способ получения знаний людьми.';
const ARABIC = 'الذكاء الاصطناعي يغير طريقة حصول الناس على المعرفة كل يوم.';
const THAI = 'ปัญญาประดิษฐ์กำลังเปลี่ยนวิธีที่ผู้คนเข้าถึงความรู้ในทุกวันนี้';
const GREEK = 'Η τεχνητή νοημοσύνη αλλάζει τον τρόπο πρόσβασης στη γνώση.';
const HEBREW = 'הבינה המלאכותית משנה את הדרך שבה אנשים רוכשים ידע.';
const HINDI = 'कृत्रिम बुद्धिमत्ता लोगों के ज्ञान प्राप्त करने के तरीके को बदल रही है।';

test('names the family of each non-Latin script', () => {
	assert.equal(dominantScriptFamily(JAPANESE), 'ja');
	assert.equal(dominantScriptFamily(CHINESE), 'zh');
	assert.equal(dominantScriptFamily(KOREAN), 'ko');
	assert.equal(dominantScriptFamily(RUSSIAN), 'cyrillic');
	assert.equal(dominantScriptFamily(ARABIC), 'arabic');
	assert.equal(dominantScriptFamily(THAI), 'thai');
	assert.equal(dominantScriptFamily(GREEK), 'greek');
	assert.equal(dominantScriptFamily(HEBREW), 'hebrew');
	assert.equal(dominantScriptFamily(HINDI), 'devanagari');
});

test('reports latin for Latin-script prose', () => {
	assert.equal(dominantScriptFamily(ENGLISH), 'latin');
});

test('kana decides Japanese even when Han characters outnumber it', () => {
	// A headline that is mostly kanji still carries okurigana; Chinese never does.
	assert.equal(dominantScriptFamily('人工知能技術研究所の最新報告書によると、これは重要な変化である。'), 'ja');
});

test('a quoted foreign phrase does not flip the family', () => {
	assert.equal(dominantScriptFamily(`${ENGLISH} The author's name is 王小明.`), 'latin');
});

test('returns null when no script reaches the dominance threshold', () => {
	assert.equal(dominantScriptFamily('123 456 --- 789'), null);
	assert.equal(dominantScriptFamily(''), null);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test tests/unit/script_detection.test.ts
```

Expected: FAIL — `Cannot find module '../../src/shared/script_detection.ts'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/shared/script_detection.ts`:

```ts
/**
 * The writing system a piece of text uses, at the granularity that matters for choosing a voice.
 *
 * Han, kana and hangul collapse into `ja`/`zh`/`ko` rather than staying separate scripts because
 * the three languages share the Han block: kana and hangul are the only reliable separators, and a
 * caller that received "Han" would have to redo that test itself.
 */
export type ScriptFamily = 'ja' | 'zh' | 'ko' | 'cyrillic' | 'arabic' | 'thai' | 'devanagari' | 'greek' | 'hebrew' | 'latin';

const LETTERS = /\p{L}/gu;
const COUNTERS: { family: Exclude<ScriptFamily, 'ja' | 'ko'>; pattern: RegExp }[] = [
	{ family: 'zh', pattern: /\p{Script=Han}/gu },
	{ family: 'cyrillic', pattern: /\p{Script=Cyrillic}/gu },
	{ family: 'arabic', pattern: /\p{Script=Arabic}/gu },
	{ family: 'thai', pattern: /\p{Script=Thai}/gu },
	{ family: 'devanagari', pattern: /\p{Script=Devanagari}/gu },
	{ family: 'greek', pattern: /\p{Script=Greek}/gu },
	{ family: 'hebrew', pattern: /\p{Script=Hebrew}/gu },
	{ family: 'latin', pattern: /\p{Script=Latin}/gu },
];
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL = /\p{Script=Hangul}/gu;

/** A script has to carry most of the text to count; a quoted phrase must not decide the language. */
const DOMINANT_RATIO = 0.3;
/** Japanese prose always carries okurigana, so even a kanji-heavy headline clears this. */
const KANA_RATIO = 0.05;

function countOf(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

/**
 * The writing system that carries this text, or null when nothing dominates it.
 *
 * `latin` is a real answer, not a fallback: it says "not one of the others", which is what the
 * caller needs to know before deciding whether to trust a declared locale.
 */
export function dominantScriptFamily(text: string): ScriptFamily | null {
	const letters = countOf(text, LETTERS);
	if (letters === 0) {
		return null;
	}

	// Tested before the general counters: both scripts sit inside a CJK text whose Han count would
	// otherwise win and report Chinese.
	if (countOf(text, HANGUL) / letters >= KANA_RATIO) {
		return 'ko';
	}
	if (countOf(text, KANA) / letters >= KANA_RATIO) {
		return 'ja';
	}

	let best: ScriptFamily | null = null;
	let bestCount = 0;
	for (const counter of COUNTERS) {
		const count = countOf(text, counter.pattern);
		if (count > bestCount) {
			best = counter.family;
			bestCount = count;
		}
	}
	return best !== null && bestCount / letters >= DOMINANT_RATIO ? best : null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
bun test tests/unit/script_detection.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check --write src/shared/script_detection.ts tests/unit/script_detection.test.ts
git add src/shared/script_detection.ts tests/unit/script_detection.test.ts
git commit -m "feat: detect the dominant script of a piece of text"
```

---

### Task 2: The script layer inside detectContentLanguage

**Files:**
- Modify: `src/shared/language_detection.ts`
- Test: `tests/unit/language_detection.test.ts`

The rule: override `declaredLang` only when the observed script **contradicts** the declared language's own script. Overriding unconditionally would force a correctly declared Persian page from `fa` into `ar`.

The `latin` family is skipped entirely: it cannot separate en/fr/de/es, and letting it override would turn an undeclared Latin page (`na`) into a guess of `en` — today it returns `na`, which is the correct behaviour.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/language_detection.test.ts`:

```ts
const JAPANESE = '日本語のテキストはひらがなとカタカナと漢字を混ぜて書かれています。とても読みやすいです。';
const RUSSIAN = 'Искусственный интеллект меняет способ получения знаний людьми каждый день.';
const PERSIAN = 'هوش مصنوعی روش دسترسی مردم به دانش را تغییر می‌دهد و ابزارهای تازه‌ای می‌سازد.';
const UKRAINIAN = 'Штучний інтелект змінює спосіб, у який люди отримують знання щодня.';

test('replaces a declared locale whose script the text contradicts', () => {
	// A Japanese newspaper served under an English locale: the declaration is about the site chrome.
	assert.equal(detectContentLanguage(JAPANESE, 'en'), 'ja');
	assert.equal(detectContentLanguage(RUSSIAN, 'na'), 'ru');
});

test('keeps a declared locale that agrees with the observed script', () => {
	// Persian and Arabic share a script; overriding would swap a correct declaration for a wrong one.
	assert.equal(detectContentLanguage(PERSIAN, 'fa'), 'fa');
	assert.equal(detectContentLanguage(UKRAINIAN, 'uk'), 'uk');
});

test('leaves Latin-script text to the declared locale', () => {
	// Latin cannot separate en/fr/de, so the script layer must not answer for them at all.
	assert.equal(detectContentLanguage(ENGLISH, 'na'), 'na');
	assert.equal(detectContentLanguage(FRENCH, 'na'), 'na');
	assert.equal(detectContentLanguage(`${ENGLISH} The author is 王小明.`, 'en'), 'en');
});

test('the Vietnamese layer still runs before the script layer', () => {
	assert.equal(detectContentLanguage(VIETNAMESE, 'ru'), 'vi');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test tests/unit/language_detection.test.ts
```

Expected: FAIL — `detectContentLanguage(JAPANESE, 'en')` returns `'en'` where `'ja'` is expected.

- [ ] **Step 3: Write the minimal implementation**

In `src/shared/language_detection.ts`, add an import at the top of the file:

```ts
import { dominantScriptFamily, type ScriptFamily } from './script_detection.ts';
```

Add this immediately before `export function detectContentLanguage`:

```ts
/**
 * The script each non-Latin language the engines can speak is written in.
 *
 * Only non-Latin languages appear: a language missing from the table has no script on record, which
 * makes it disagree with any non-Latin observation — exactly the answer wanted for `en` on a
 * Cyrillic page, and for `na`.
 */
const SCRIPT_BY_LANGUAGE: Record<string, ScriptFamily> = {
	ja: 'ja',
	zh: 'zh',
	yue: 'zh',
	ko: 'ko',
	ru: 'cyrillic',
	uk: 'cyrillic',
	bg: 'cyrillic',
	sr: 'cyrillic',
	mk: 'cyrillic',
	be: 'cyrillic',
	kk: 'cyrillic',
	ky: 'cyrillic',
	mn: 'cyrillic',
	tg: 'cyrillic',
	ar: 'arabic',
	fa: 'arabic',
	ur: 'arabic',
	ps: 'arabic',
	ku: 'arabic',
	sd: 'arabic',
	th: 'thai',
	hi: 'devanagari',
	mr: 'devanagari',
	ne: 'devanagari',
	sa: 'devanagari',
	el: 'greek',
	he: 'hebrew',
	yi: 'hebrew',
};

/** The language to assume when a script is observed but the declaration does not name one of its own. */
const DEFAULT_LANGUAGE_BY_SCRIPT: Record<Exclude<ScriptFamily, 'latin'>, string> = {
	ja: 'ja',
	zh: 'zh',
	ko: 'ko',
	cyrillic: 'ru',
	arabic: 'ar',
	thai: 'th',
	devanagari: 'hi',
	greek: 'el',
	hebrew: 'he',
};
```

Then replace the body of `detectContentLanguage`:

```ts
export function detectContentLanguage(content: string, declaredLang: string): string {
	const letterCount = content.match(LETTERS)?.length ?? 0;
	const vietnameseCount = content.match(VIETNAMESE_LETTERS)?.length ?? 0;
	if (letterCount > 0 && vietnameseCount / letterCount >= VIETNAMESE_LETTER_RATIO) {
		return 'vi';
	}

	// Latin is skipped deliberately: it cannot separate en/fr/de/es, and letting it answer would turn
	// an undeclared Latin page into a guess of English.
	const observed = dominantScriptFamily(content);
	if (observed !== null && observed !== 'latin') {
		const declaredScript = SCRIPT_BY_LANGUAGE[declaredLang.split('-')[0].toLowerCase()];
		if (declaredScript !== observed) {
			return DEFAULT_LANGUAGE_BY_SCRIPT[observed];
		}
		return declaredLang;
	}

	return declaredLang === 'vi' ? 'na' : declaredLang;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
bun test tests/unit/language_detection.test.ts
```

Expected: PASS, with every existing Vietnamese test still green.

- [ ] **Step 5: Run the whole unit suite to confirm nothing else broke**

```bash
bun test tests/unit
```

Expected: everything PASSes.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check --write src/shared/language_detection.ts tests/unit/language_detection.test.ts
git add src/shared/language_detection.ts tests/unit/language_detection.test.ts
git commit -m "feat: detect language by script when the declared locale contradicts it"
```

---

### Task 3: Split the on-device language list into a leaf module

**Files:**
- Create: `src/shared/supertonic_languages.ts`
- Modify: `src/offscreen/supertonic_helper.ts:5`

`supertonic_helper.ts` imports `./ort_runtime.ts` (ONNX Runtime). Task 4 needs the language list in the side panel; importing the helper directly would pull ORT into the panel bundle. Move the constant into a leaf module and re-export it so there is still one source of truth.

- [ ] **Step 1: Create the leaf module**

Move the `AVAILABLE_LANGS` array (`src/offscreen/supertonic_helper.ts:5`) into a new file `src/shared/supertonic_languages.ts`, keeping its order and contents unchanged:

```ts
/**
 * Languages the on-device engine can speak. `na` is its placeholder for "not detected", not a
 * language, so anything offering these as choices must drop it.
 *
 * Kept in a leaf module: the side panel needs this list, and importing the helper would pull the
 * ONNX runtime into the panel bundle.
 */
export const AVAILABLE_LANGS = [
	'en',
	'ko',
	'ja',
	'ar',
	'bg',
	'cs',
	'da',
	'de',
	'el',
	'es',
	'et',
	'fi',
	'fr',
	'hi',
	'hr',
	'hu',
	'id',
	'it',
	'lt',
	'lv',
	'nl',
	'pl',
	'pt',
	'ro',
	'ru',
	'sk',
	'sl',
	'sv',
	'tr',
	'uk',
	'vi',
	'na',
];
```

- [ ] **Step 2: Re-export from the helper**

In `src/offscreen/supertonic_helper.ts`, replace the array declaration with:

```ts
export { AVAILABLE_LANGS } from '../shared/supertonic_languages.ts';
import { AVAILABLE_LANGS } from '../shared/supertonic_languages.ts';
```

Every use of `AVAILABLE_LANGS` in the file stays as it is.

- [ ] **Step 3: Run typecheck and the unit suite**

```bash
bunx tsc --noEmit && bun test tests/unit
```

Expected: PASS, no type errors.

- [ ] **Step 4: Lint and commit**

```bash
bunx biome check --write src/shared/supertonic_languages.ts src/offscreen/supertonic_helper.ts
git add src/shared/supertonic_languages.ts src/offscreen/supertonic_helper.ts
git commit -m "refactor: split the on-device language list into a leaf module"
```

---

### Task 4: The dropdown's language list, per engine

**Files:**
- Create: `src/shared/language_options.ts`
- Modify: `src/shared/edge_voices.ts` (add `edgeBaseLanguages()`)
- Test: `tests/unit/language_options.test.ts`

The list follows what the engine can actually do: picking a language the engine has no voice for is a state that need not exist. Display names come from `Intl.DisplayNames`, so no hand-written translation table is needed.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/language_options.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { isEdgeSupportedLanguage } from '../../src/shared/edge_voices.ts';
import { isOfferableLanguage, languageDisplayName, languageOptionsFor } from '../../src/shared/language_options.ts';
import { AVAILABLE_LANGS } from '../../src/shared/supertonic_languages.ts';

test('every edge option is a language edge-tts actually has a voice for', () => {
	const options = languageOptionsFor('edge');
	assert.ok(options.length > 10);
	for (const option of options) {
		assert.ok(isEdgeSupportedLanguage(option.code), `${option.code} has no edge voice`);
	}
});

test('the on-device list is the engine list without its not-detected placeholder', () => {
	const codes = languageOptionsFor('supertonic').map((option) => option.code);
	assert.deepEqual([...codes].sort(), AVAILABLE_LANGS.filter((lang) => lang !== 'na').sort());
});

test('options carry a human name and are sorted by it', () => {
	const options = languageOptionsFor('edge');
	for (const option of options) {
		assert.ok(option.name.length > 0);
	}
	const names = options.map((option) => option.name);
	assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('names a language for the auto label', () => {
	assert.equal(typeof languageDisplayName('vi'), 'string');
	assert.ok(languageDisplayName('vi').length > 0);
});

test('a language either engine can speak is offerable; nonsense is not', () => {
	// Validation spans both engines on purpose: the manual-text path validates before the engine for
	// that session has been settled, and rejecting a language the other engine speaks would be wrong.
	assert.equal(isOfferableLanguage('de'), true);
	assert.equal(isOfferableLanguage('vi'), true);
	assert.equal(isOfferableLanguage('xx'), false);
	assert.equal(isOfferableLanguage('na'), false);
	assert.equal(isOfferableLanguage('auto'), false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test tests/unit/language_options.test.ts
```

Expected: FAIL — `Cannot find module '../../src/shared/language_options.ts'`

- [ ] **Step 3: Add edgeBaseLanguages()**

Append to `src/shared/edge_voices.ts`:

```ts
/** The base languages edge-tts has at least one voice for, for offering as choices. */
export function edgeBaseLanguages(): string[] {
	return [...new Set(VOICES.map((voice) => voice.locale.split('-')[0].toLowerCase()))];
}
```

- [ ] **Step 4: Write language_options.ts**

Create `src/shared/language_options.ts`:

```ts
import { edgeBaseLanguages } from './edge_voices.ts';
import type { TtsProviderId } from './edge_voice_preferences.ts';
import { uiLang } from './i18n.ts';
import { AVAILABLE_LANGS } from './supertonic_languages.ts';

export interface LanguageOption {
	code: string;
	name: string;
}

const DISPLAY_NAMES = new Intl.DisplayNames([uiLang], { type: 'language' });

/**
 * The language's name in the interface language.
 *
 * `Intl.DisplayNames` is the whole implementation on purpose: a hand-written table for forty
 * languages in two interface languages is eighty strings that go stale, and the browser already
 * ships the data.
 */
export function languageDisplayName(code: string): string {
	try {
		return DISPLAY_NAMES.of(code) ?? code;
	} catch {
		// `of` throws on a structurally invalid tag rather than returning undefined.
		return code;
	}
}

/**
 * The languages worth offering for an engine.
 *
 * Bound to what the engine can actually speak: offering a language with no voice behind it names a
 * choice the listener will never hear, which is the same class of bug that made the reader list
 * on-device voices while edge-tts was speaking.
 */
export function languageOptionsFor(provider: TtsProviderId): LanguageOption[] {
	const codes = provider === 'edge' ? edgeBaseLanguages() : AVAILABLE_LANGS.filter((lang) => lang !== 'na');
	return codes
		.map((code) => ({ code, name: languageDisplayName(code) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

const OFFERABLE = new Set([...edgeBaseLanguages(), ...AVAILABLE_LANGS.filter((lang) => lang !== 'na')]);

/**
 * Whether some engine can speak this language.
 *
 * Spans both engines rather than the selected one: a request carries a language, not an engine, and
 * the engine that ends up speaking is settled later — rejecting a language the other engine handles
 * would turn a working choice into a silent failure.
 */
export function isOfferableLanguage(code: string): boolean {
	return OFFERABLE.has(code);
}
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
bun test tests/unit/language_options.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check --write src/shared/language_options.ts src/shared/edge_voices.ts tests/unit/language_options.test.ts
git add src/shared/language_options.ts src/shared/edge_voices.ts tests/unit/language_options.test.ts
git commit -m "feat: per-engine language list for the dropdown"
```

---

### Task 5: Decide the page language from a text sample

**Files:**
- Create: `src/content/page_language.ts`
- Test: `tests/unit/page_language.test.ts`

A pure function, kept out of the content script so it can be tested without a DOM. It answers two things: what the language is, and whether that answer can be trusted.

Google Docs and Word Online render into a canvas — their `body.innerText` is just chrome, and Google Docs' `<html lang>` is the Google account's locale rather than the document's language. Both report `unknown` whatever the page declares.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/page_language.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePageLanguage } from '../../src/content/page_language.ts';

const VIETNAMESE_SAMPLE = (
	'Trí tuệ nhân tạo đang thay đổi cách con người tiếp cận tri thức mỗi ngày, và nhiều công cụ ' +
	'mới ra đời khiến việc theo kịp trở nên khó khăn hơn trước rất nhiều. '
).repeat(3);
const ENGLISH_SAMPLE = 'Romantic rejection activates the same brain regions implicated in physical pain. '.repeat(3);

test('reads the language from the sample when the page declares the wrong one', () => {
	const result = resolvePageLanguage({
		url: 'https://vnexpress.net/bai-viet',
		declared: 'en',
		sample: VIETNAMESE_SAMPLE,
	});
	assert.deepEqual(result, { lang: 'vi', langSource: 'detected' });
});

test('refuses to read a Google Docs page, whose declaration is the account locale', () => {
	const result = resolvePageLanguage({
		url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
		declared: 'en',
		sample: ENGLISH_SAMPLE,
	});
	assert.deepEqual(result, { lang: 'en', langSource: 'unknown' });
});

test('refuses to read a Word Online page', () => {
	const result = resolvePageLanguage({
		url: 'https://contoso-my.sharepoint.com/personal/me/_layouts/15/Doc.aspx?sourcedoc=%7B123%7D&file=a.docx',
		declared: 'en',
		sample: ENGLISH_SAMPLE,
	});
	assert.equal(result.langSource, 'unknown');
});

test('refuses to read a page with too little text to judge', () => {
	const result = resolvePageLanguage({ url: 'https://example.com', declared: 'fr', sample: 'Bonjour' });
	assert.deepEqual(result, { lang: 'fr', langSource: 'unknown' });
});

test('keeps the declared language when the sample agrees with it', () => {
	const result = resolvePageLanguage({ url: 'https://example.com', declared: 'en', sample: ENGLISH_SAMPLE });
	assert.deepEqual(result, { lang: 'en', langSource: 'detected' });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test tests/unit/page_language.test.ts
```

Expected: FAIL — `Cannot find module '../../src/content/page_language.ts'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/content/page_language.ts`:

```ts
import { detectContentLanguage } from '../shared/language_detection.ts';
import { parseGoogleDocsDocumentId } from './google_docs_extractor.ts';
import { parseWordOnlineDocument } from './word_online_extractor.ts';

/** Enough prose to judge a script ratio from; a nav bar alone should not decide a language. */
const MIN_SAMPLE_LETTERS = 100;
/** More than this buys no accuracy and costs the panel a slower page-info round trip. */
const SAMPLE_LIMIT = 4000;

export interface PageLanguage {
	lang: string;
	/** `unknown` means the value is the page's own claim, which is weak evidence at best. */
	langSource: 'detected' | 'unknown';
}

/**
 * The language of the page in front of the reader, decided before anything is read aloud.
 *
 * Google Docs and Word Online render into a canvas: their `innerText` is chrome, and Google Docs'
 * `<html lang>` is the Google account's locale rather than the document's language. Guessing from
 * either would be confident and wrong, so both surfaces report `unknown` and let the reader choose.
 */
export function resolvePageLanguage(input: { url: string; declared: string; sample: string }): PageLanguage {
	const sample = input.sample.slice(0, SAMPLE_LIMIT);
	const trustworthy =
		parseGoogleDocsDocumentId(input.url) === null &&
		parseWordOnlineDocument(input.url) === null &&
		(sample.match(/\p{L}/gu)?.length ?? 0) >= MIN_SAMPLE_LETTERS;

	if (!trustworthy) {
		return { lang: input.declared, langSource: 'unknown' };
	}
	return { lang: detectContentLanguage(sample, input.declared), langSource: 'detected' };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
bun test tests/unit/page_language.test.ts
```

Expected: PASS, 5 tests.

If the Word Online test fails, open `src/content/word_online_extractor.ts:13` to see what URL shape `parseWordOnlineDocument` expects and fix the URL in the test to match — do not loosen the implementation.

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check --write src/content/page_language.ts tests/unit/page_language.test.ts
git add src/content/page_language.ts tests/unit/page_language.test.ts
git commit -m "feat: decide the page language from a text sample before reading"
```

---

### Task 6: Carry langSource through GET_PAGE_INFO

**Files:**
- Modify: `src/shared/types.ts:31`
- Modify: `src/content/content_script.ts:57-65`
- Modify: `src/background/page_info.ts:31`
- Test: `tests/unit/page_info.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/page_info.test.ts`:

```ts
test('a tab with no content script reports its language as unknown', () => {
	const info = pageInfoFromTab({ url: 'https://example.com/a', title: 'A' });
	assert.deepEqual(info, { available: true, title: 'A', url: 'https://example.com/a', lang: 'na', langSource: 'unknown' });
});
```

`pageInfoFromTab` is already imported in that file; if it is not, add it to the existing import line.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test tests/unit/page_info.test.ts
```

Expected: FAIL — the object is missing `langSource`.

- [ ] **Step 3: Widen the type**

In `src/shared/types.ts`, replace line 31:

```ts
export type PageInfoResponse =
	| { available: true; title: string; url: string; lang: string; langSource: 'detected' | 'unknown' }
	| { available: false };
```

- [ ] **Step 4: Update pageInfoFromTab**

In `src/background/page_info.ts`, replace `return { available: true, title: tab.title ?? '', url: tab.url, lang: 'na' };` with:

```ts
	return { available: true, title: tab.title ?? '', url: tab.url, lang: 'na', langSource: 'unknown' };
```

- [ ] **Step 5: Update the content script**

In `src/content/content_script.ts`, add the import:

```ts
import { resolvePageLanguage } from './page_language.ts';
```

Replace the `GET_PAGE_INFO` block (lines 57–65) with:

```ts
			if (msg.action === 'GET_PAGE_INFO') {
				const page = resolvePageLanguage({
					url: document.location.href,
					declared: getDocumentLanguage(),
					sample: document.body?.innerText ?? '',
				});
				sendResponse({
					available: true,
					title: document.title,
					url: document.location.href,
					lang: page.lang,
					langSource: page.langSource,
				});
				return;
			}
```

- [ ] **Step 6: Typecheck and run the whole unit suite**

```bash
bunx tsc --noEmit && bun test tests/unit
```

Expected: PASS. If `tsc` flags anywhere that builds a `PageInfoResponse` without `langSource` (a mock in a test, say), add `langSource: 'unknown'` there.

- [ ] **Step 7: Lint and commit**

```bash
bunx biome check --write src/shared/types.ts src/content/content_script.ts src/background/page_info.ts tests/unit/page_info.test.ts
git add src/shared/types.ts src/content/content_script.ts src/background/page_info.ts tests/unit/page_info.test.ts
git commit -m "feat: GET_PAGE_INFO returns the detected language and its confidence"
```

---

### Task 7: Read languageOverride out of the payload

**Files:**
- Create: `src/background/language_override.ts`
- Test: `tests/unit/language_override.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/language_override.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLanguageOverride } from '../../src/background/language_override.ts';

test('accepts a language tag and normalises it', () => {
	assert.equal(parseLanguageOverride({ languageOverride: 'JA' }), 'ja');
	assert.equal(parseLanguageOverride({ languageOverride: ' vi ' }), 'vi');
	assert.equal(parseLanguageOverride({ languageOverride: 'zh_CN' }), 'zh-cn');
});

test('treats auto and anything unusable as no override', () => {
	assert.equal(parseLanguageOverride({ languageOverride: 'auto' }), undefined);
	assert.equal(parseLanguageOverride({ languageOverride: '' }), undefined);
	assert.equal(parseLanguageOverride({ languageOverride: 42 }), undefined);
	assert.equal(parseLanguageOverride({}), undefined);
	assert.equal(parseLanguageOverride(undefined), undefined);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test tests/unit/language_override.test.ts
```

Expected: FAIL — `Cannot find module '../../src/background/language_override.ts'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/background/language_override.ts`:

```ts
/**
 * The reader's explicit language choice, or undefined when they left it on automatic.
 *
 * `auto` collapses to undefined rather than travelling as a value: everything downstream reads a
 * language code, and a sentinel that only the UI understands would have to be unwrapped again in
 * `startPlayback`, where getting it wrong means speaking a real article in a made-up language.
 */
export function parseLanguageOverride(payload: unknown): string | undefined {
	const value = (payload as { languageOverride?: unknown } | undefined)?.languageOverride;
	if (typeof value !== 'string') {
		return undefined;
	}
	const normalized = value.trim().replaceAll('_', '-').toLowerCase();
	return normalized && normalized !== 'auto' ? normalized : undefined;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
bun test tests/unit/language_override.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check --write src/background/language_override.ts tests/unit/language_override.test.ts
git add src/background/language_override.ts tests/unit/language_override.test.ts
git commit -m "feat: read languageOverride out of the START payload"
```

---

### Task 8: Apply languageOverride inside startPlayback

**Files:**
- Modify: `src/background/background.ts:125-134` (`StartPlaybackInput`)
- Modify: `src/background/background.ts:876-883` (`startPlayback`)

`content.lang` is the one field everything downstream reads: `readEdgeVoice()`, `resolveStoredPlaybackSpeed()`, `preparePlaybackUnits()`, the Vietnamese normalizer. Apply the override **once, at the top of the function**, so no one has to remember to apply it again at each of them.

Placing it before the translation block is deliberate: that branch overwrites `lang` with `targetLanguage` afterwards, and rightly so — the override names the source language, and a translated article is spoken in the target language.

- [ ] **Step 1: Add the field to the type**

In `src/background/background.ts`, in the `contentScope: 'article'` branch of `StartPlaybackInput` (lines 126–134), add after `translate?: boolean;`:

```ts
			/** The reader's explicit language choice, which outranks whatever extraction detected. */
			languageOverride?: string;
```

- [ ] **Step 2: Apply the override at the top of startPlayback**

In `startPlayback` (line 876), immediately after `let input = initialInput;` and **before** the `let translationForSession` line, insert:

```ts
	// Applied here and nowhere else: `content.lang` is the single field the voice, the speed, the
	// segmentation and the Vietnamese normalizer all read, so one assignment covers every consumer.
	if (input.contentScope === 'article' && input.languageOverride) {
		input = { ...input, content: { ...input.content, lang: input.languageOverride } };
	}
```

- [ ] **Step 3: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
bunx biome check --write src/background/background.ts
git add src/background/background.ts
git commit -m "feat: apply languageOverride to content.lang when playback starts"
```

---

### Task 9: Carry languageOverride through startCurrentPage

**Files:**
- Modify: `src/background/background.ts:1092-1097` (the `startCurrentPage` signature)
- Modify: `src/background/background.ts:1149-1161` (the `startPlayback` call)
- Modify: `src/background/background.ts:1189`, `1652`, `1656`, `1736`, `1739` (call sites)

`startCurrentPage` already takes four positional parameters; a fifth would turn the call site `startCurrentPage(undefined, undefined, undefined, true)` into `(undefined, undefined, undefined, true, override)`, which is unreadable. Switch it to an options object.

- [ ] **Step 1: Switch the signature to an options object**

Replace lines 1092–1097:

```ts
interface StartCurrentPageOptions {
	targetTabId?: number;
	queueItemId?: string;
	fallbackUrl?: string;
	translate?: boolean;
	/** The reader's explicit language choice; the queue and the context menu never carry one. */
	languageOverride?: string;
}

async function startCurrentPage(options: StartCurrentPageOptions = {}): Promise<CommandResponse> {
	const { targetTabId, queueItemId, fallbackUrl, translate = false, languageOverride } = options;
	await ensureHydrated();
```

The rest of the body is unchanged — it already uses exactly these names.

- [ ] **Step 2: Pass the override down to startPlayback**

In the `return startPlayback({...})` at the end of `startCurrentPage` (around line 1149), add after `translate,`:

```ts
		...(languageOverride ? { languageOverride } : {}),
```

- [ ] **Step 3: Update the four call sites**

Around line 1189, in `playQueueItem`:

```ts
		const result = await startCurrentPage({ targetTabId, queueItemId: item.id, fallbackUrl: item.url });
```

Around lines 1652 and 1656 (the two consecutive calls once queue navigation finishes):

```ts
	let result = await startCurrentPage({ targetTabId: tabId, queueItemId: pending.itemId, fallbackUrl: pending.expectedUrl });
```

```ts
		result = await startCurrentPage({ targetTabId: tabId, queueItemId: pending.itemId, fallbackUrl: pending.expectedUrl });
```

Around lines 1735–1739, the two message cases:

```ts
		case 'START_CURRENT_PAGE':
			return respondFromQueue(() => startCurrentPage({ languageOverride: parseLanguageOverride(msg.payload) }), sendResponse);

		case 'START_CURRENT_PAGE_TRANSLATED':
			return respondFromQueue(
				() => startCurrentPage({ translate: true, languageOverride: parseLanguageOverride(msg.payload) }),
				sendResponse,
			);
```

Add the import at the top of `background.ts`:

```ts
import { parseLanguageOverride } from './language_override.ts';
```

- [ ] **Step 4: Typecheck and run the whole unit suite**

```bash
bunx tsc --noEmit && bun test tests/unit
```

Expected: PASS. `tsc` points straight at any call site still passing positional arguments.

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check --write src/background/background.ts
git add src/background/background.ts
git commit -m "refactor: startCurrentPage takes an options object and carries languageOverride"
```

---

### Task 10: i18n keys for the language dropdown

**Files:**
- Modify: `src/shared/locales/en.json`
- Modify: `src/shared/locales/vi.json`

- [ ] **Step 1: Add the keys to en.json**

Add next to `"selectVoice"` (line 21):

```json
	"contentLanguage": "Content language",
	"contentLanguageAuto": "Auto ({language})",
```

- [ ] **Step 2: Add the keys to vi.json**

Add next to `"selectVoice"` (line 21):

```json
	"contentLanguage": "Ngôn ngữ nội dung",
	"contentLanguageAuto": "Tự động ({language})",
```

- [ ] **Step 3: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: no errors. `TranslationKey` is derived from `en.json`, so both files must carry the same key set — if they diverge, `tsc` reports it at `THEME_TRANSLATIONS`.

- [ ] **Step 4: Commit**

```bash
git add src/shared/locales/en.json src/shared/locales/vi.json
git commit -m "feat: interface strings for the content-language dropdown"
```

---

### Task 11: The language dropdown in SettingsCard

**Files:**
- Modify: `src/shared/components/SettingsCard.tsx`

Placed directly **above** the voice select: the language decides the voice list, so it should come first in reading order.

Reuse the existing `isVoiceDisabled` (line 67) — same reason: changing the language mid-read would require re-segmenting everything currently playing.

- [ ] **Step 1: Add the import**

```ts
import { languageDisplayName, languageOptionsFor } from '../language_options';
```

- [ ] **Step 2: Add the props**

Into `SettingsCardProps`, after `contentLang`:

```ts
	/** The reader's explicit language choice, or `null` while it follows detection. */
	languageOverride: string | null;
	onLanguageOverrideChange: (language: string | null) => void;
```

And into `SettingsCard`'s destructuring list, after `contentLang,`:

```ts
	languageOverride,
	onLanguageOverrideChange,
```

- [ ] **Step 3: Add the select**

Immediately **before** the `<label className="selection-button-setting voice-setting">` block containing `t('selectVoice')`, insert:

```tsx
					<label className="selection-button-setting voice-setting">
						<span className="setting-label">{t('contentLanguage')}</span>
						<select
							id="content-language-select"
							className="form-select inline-select"
							aria-label={t('contentLanguage')}
							value={languageOverride ?? 'auto'}
							onChange={(e) => onLanguageOverrideChange(e.target.value === 'auto' ? null : e.target.value)}
							disabled={isVoiceDisabled}
						>
							{/* The automatic option names what it resolved to, so a wrong detection is visible
							    without opening the list. */}
							<option value="auto">{t('contentLanguageAuto').replace('{language}', languageDisplayName(contentLang))}</option>
							{languageOptionsFor(ttsProvider).map((language) => (
								<option key={language.code} value={language.code}>
									{language.name}
								</option>
							))}
						</select>
					</label>
```

- [ ] **Step 4: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: FAIL in `src/sidepanel/App.tsx` and `src/popup/App.tsx` — required props missing. Tasks 12 and 13 fix those. If `src/reader/App.tsx` also renders `SettingsCard` it appears here too; see Step 5.

- [ ] **Step 5: Handle every remaining SettingsCard call site**

```bash
grep -rn "<SettingsCard" src/
```

For a call site that is **not** the side panel or the popup (the reader, say), pass two neutral props to keep its behaviour unchanged:

```tsx
	languageOverride={null}
	onLanguageOverrideChange={() => {}}
```

- [ ] **Step 6: Commit**

```bash
bunx biome check --write src/shared/components/SettingsCard.tsx
git add src/shared/components/SettingsCard.tsx src/reader/App.tsx
git commit -m "feat: content-language dropdown in SettingsCard"
```

(Drop `src/reader/App.tsx` from the `git add` if Step 5 turned out not to touch it.)

---

### Task 12: Wire the override into the side panel

**Files:**
- Modify: `src/sidepanel/App.tsx:597`, the `START_CURRENT_PAGE` calls (around lines 430 and 471), and the `SettingsCard` render (around line 996)

The override lives per page: it resets when the active tab or the URL changes. Nothing is written to storage — a globally sticky choice would read an English page in a Vietnamese voice once the reader forgot to change it back.

- [ ] **Step 1: Add the state**

Next to `const [pageInfo, setPageInfo] = useState<PageInfoResponse>(EMPTY_PAGE_INFO);` (around line 87):

```tsx
	const [languageOverride, setLanguageOverride] = useState<string | null>(null);
```

- [ ] **Step 2: Reset when the page changes**

Add an effect after the state declarations:

```tsx
	// The choice is about the page in front of the reader, so it does not follow them to the next one.
	const pageKey = pageInfo.available ? pageInfo.url : '';
	useEffect(() => {
		setLanguageOverride(null);
	}, [pageKey]);
```

- [ ] **Step 3: Let the override beat detection**

Replace line 597:

```tsx
	const contentLang = languageOverride ?? session?.lang ?? (pageInfo.available ? pageInfo.lang : null) ?? uiLang;
```

Update the comment above it, adding one sentence:

```
	// An explicit choice outranks both: it exists precisely because detection got it wrong, and a
	// starting session must not pull the panel back to what it detected.
```

- [ ] **Step 4: Send the override with the START command**

Around line 430:

```tsx
		const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE', payload: { languageOverride } });
```

Around line 471:

```tsx
		const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE_TRANSLATED', payload: { languageOverride } });
```

`parseLanguageOverride` ignores `null`, so no conditional wrapper is needed.

- [ ] **Step 5: Pass the props down to SettingsCard**

Next to `contentLang={contentLang}` (around line 996):

```tsx
					languageOverride={languageOverride}
					onLanguageOverrideChange={setLanguageOverride}
```

- [ ] **Step 6: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: only `src/popup/App.tsx` still errors. If `sendPlaybackCommand`'s message type does not allow a `payload` for these two actions, widen it in `src/shared/playback_client.ts` to match.

- [ ] **Step 7: Commit**

```bash
bunx biome check --write src/sidepanel/App.tsx
git add src/sidepanel/App.tsx
git commit -m "feat: the side panel lets the language be chosen before reading"
```

---

### Task 13: Wire the override into the popup

**Files:**
- Modify: `src/popup/App.tsx:381`, the START calls (around lines 254 and 334), and the `SettingsCard` render (around line 645)

The popup is rebuilt from scratch on every open, so no reset effect is needed — the component lifetime already is "this page".

- [ ] **Step 1: Add the state**

Next to the other `useState` calls in `src/popup/App.tsx`:

```tsx
	const [languageOverride, setLanguageOverride] = useState<string | null>(null);
```

- [ ] **Step 2: Let the override beat detection**

Replace line 381:

```tsx
	const contentLang = languageOverride ?? session?.lang ?? (pageInfo.available ? pageInfo.lang : null) ?? uiLang;
```

- [ ] **Step 3: Send the override with the START command**

Around line 254:

```tsx
			const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE', payload: { languageOverride } });
```

Around line 334:

```tsx
			const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE_TRANSLATED', payload: { languageOverride } });
```

- [ ] **Step 4: Pass the props down to SettingsCard**

Next to `contentLang={contentLang}` (around line 645):

```tsx
				languageOverride={languageOverride}
				onLanguageOverrideChange={setLanguageOverride}
```

- [ ] **Step 5: Typecheck and run the whole unit suite**

```bash
bunx tsc --noEmit && bun test tests/unit
```

Expected: PASS, with no type errors left.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write src/popup/App.tsx
git add src/popup/App.tsx
git commit -m "feat: the popup lets the language be chosen before reading"
```

---

### Task 14: Merge the manual-text language dropdown

**Files:**
- Modify: `src/shared/types.ts:20-21`
- Modify: `src/background/manual_text.ts:6`, `:29-36`, `:44-58`
- Modify: `src/sidepanel/App.tsx:805-811`
- Test: `tests/unit/manual_text.test.ts`

After Task 12 the same panel carries two language dropdowns with different lists — four entries on the paste-text tab, around forty on the page tab.

Beyond merging the lists, the paste-text tab's `auto` also goes through the script layer: `detectManualTextLanguage` today knows only zh/vi/en, so pasting Japanese into it makes `auto` return `en`. The Vietnamese function-word heuristic (which recognises unaccented Vietnamese) stays as it is — the script layer runs before it and answers only for non-Latin scripts.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/manual_text.test.ts`:

```ts
test('accepts a language outside the original four', () => {
	const prepared = prepareManualText({ text: 'Guten Tag, wie geht es Ihnen heute?', language: 'de' });
	assert.equal(prepared?.lang, 'de');
});

test('rejects a language no engine can speak', () => {
	assert.equal(prepareManualText({ text: 'hello there', language: 'xx' }), null);
});

test('auto detection reaches languages the old heuristic could not name', () => {
	assert.equal(detectManualTextLanguage('日本語のテキストはひらがなとカタカナを混ぜて書かれています。'), 'ja');
	assert.equal(detectManualTextLanguage('인공지능은 사람들이 지식을 얻는 방식을 바꾸고 있습니다.'), 'ko');
});

test('auto detection still recognises unaccented Vietnamese', () => {
	assert.equal(detectManualTextLanguage('toi va cac ban khong duoc mot cho nao trong danh sach'), 'vi');
});
```

Make sure the import line at the top of the file brings in both `detectManualTextLanguage` and `prepareManualText`.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test tests/unit/manual_text.test.ts
```

Expected: FAIL — `prepareManualText` returns `null` for `'de'`, and `detectManualTextLanguage` returns `'en'` for Japanese.

- [ ] **Step 3: Widen the type**

In `src/shared/types.ts`, replace lines 20–21:

```ts
/** `auto` lets detection decide; any other value is a language code the chosen engine can speak. */
export type ManualTextLanguage = 'auto' | (string & {});
export type ResolvedManualTextLanguage = string;
```

- [ ] **Step 4: Validate against the engine list and use the script layer**

In `src/background/manual_text.ts`, replace line 6:

```ts
import { isOfferableLanguage } from '../shared/language_options.ts';
import { dominantScriptFamily } from '../shared/script_detection.ts';
```

and delete the `MANUAL_LANGUAGES` constant.

Add this immediately above `detectManualTextLanguage`:

```ts
/** Scripts that name a language on their own; Latin does not, so it falls through to the heuristics. */
const LANGUAGE_BY_SCRIPT: Record<string, string> = {
	ja: 'ja',
	ko: 'ko',
	cyrillic: 'ru',
	arabic: 'ar',
	thai: 'th',
	devanagari: 'hi',
	greek: 'el',
	hebrew: 'he',
};
```

Update `detectManualTextLanguage` — add this right after the `const normalized = ...` line:

```ts
	// Answered before the zh/vi/en heuristics below, which have no way to name any other language.
	const script = dominantScriptFamily(normalized);
	if (script !== null && script !== 'latin' && script !== 'zh') {
		return LANGUAGE_BY_SCRIPT[script];
	}
```

(`zh` deliberately falls through: the existing 0.2 Han ratio already handles it and is pinned by a test.)

Update the validation in `prepareManualText` — replace the existing `if (...) { return null; }` condition with:

```ts
	if (typeof input.text !== 'string' || typeof input.language !== 'string') {
		return null;
	}
	const language = input.language;
	if (language !== 'auto' && !isOfferableLanguage(language)) {
		return null;
	}
```

and at the end of the function drop the old `const language = input.language as ManualTextLanguage;` line (now declared above), leaving only:

```ts
	return { content, lang: language === 'auto' ? detectManualTextLanguage(content) : language };
```

The function stays synchronous: `isOfferableLanguage` reads no storage, so `prepareManualStart` and every call site are unchanged.

- [ ] **Step 5: Update the dropdown in the side panel**

In `src/sidepanel/App.tsx`, replace the manual-text language `<select>` block (around lines 805–811):

```tsx
					<select
						className="form-select inline-select"
						aria-label={t('contentLanguage')}
						value={language}
						onChange={(e) => setLanguage(e.target.value)}
					>
						<option value="auto">{t('languageAuto')}</option>
						{languageOptionsFor(ttsProvider).map((option) => (
							<option key={option.code} value={option.code}>
								{option.name}
							</option>
						))}
					</select>
```

Keep the `<select>`'s other existing attributes (className, id if present). Add `languageOptionsFor` to the import from `../shared/language_options`.

- [ ] **Step 6: Run the tests and typecheck**

```bash
bunx tsc --noEmit && bun test tests/unit
```

Expected: everything PASSes.

- [ ] **Step 7: Lint and commit**

```bash
bunx biome check --write src/shared/types.ts src/background/manual_text.ts src/sidepanel/App.tsx tests/unit/manual_text.test.ts
git add src/shared/types.ts src/background/manual_text.ts src/sidepanel/App.tsx tests/unit/manual_text.test.ts
git commit -m "feat: the paste-text tab shares the page tab's language list"
```

---

### Task 15: E2E — the original bug is gone

**Files:**
- Modify: `tests/e2e/side-panel.spec.ts`

This is the plan's real success criterion. `installExtensionUiRuntimeMock` lets `pageInfo` be injected directly, so this pins the panel's behaviour without standing up a real page.

The repo has no component-test infrastructure (not one `.test.tsx` file), so the UI is verified here.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/side-panel.spec.ts`:

```ts
const vietnamesePageInfo = {
	available: true as const,
	title: 'Bài viết tiếng Việt',
	url: 'https://example.com/vi/bai-viet',
	lang: 'vi',
	langSource: 'detected' as const,
};

test('offers Vietnamese voices before anything is read, on a page that declares English', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, vietnamesePageInfo);
	await openSidePanel(page);

	await expect(page.locator('#content-language-select')).toHaveValue('auto');
	const voices = await page.locator('#voice-select option').allTextContents();
	expect(voices.length).toBeGreaterThan(0);
	expect(voices.some((name) => /Hoai My|Nam Minh/u.test(name))).toBe(true);
});

test('an explicit language choice re-lists the voices', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, vietnamesePageInfo);
	await openSidePanel(page);

	await page.locator('#content-language-select').selectOption('ja');
	const voices = await page.locator('#voice-select option').allTextContents();
	expect(voices.some((name) => /Nanami|Keita/u.test(name))).toBe(true);
});

test('locks the language while a session is playing', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: documentSession }, vietnamesePageInfo);
	await openSidePanel(page);

	await expect(page.locator('#content-language-select')).toBeDisabled();
});
```

- [ ] **Step 2: Adjust the selectors to match reality**

```bash
grep -n "id=\"voice-select\"\|id='voice-select'\|aria-label={t('selectVoice')}" src/shared/components/SettingsCard.tsx
```

If the voice select has no `id`, add `id="voice-select"` to it — the same way `#reader-voice-select` was added in `src/reader/App.tsx` for `tests/e2e/reader-provider-selector.spec.ts`.

Check the real voice names so the regexes match:

```bash
grep -o '"friendlyName": "[^"]*"' public/assets/edge_voices.json | grep -iE "vi-VN|ja-JP" | head
```

Fix the two regexes in the test to match the real names.

Check whether `documentSession` in that file has `status: 'playing'`; if not, use another session in the file that does, or make a copy with `status: 'playing'`.

- [ ] **Step 3: Run the e2e suite and watch it go from failing to passing**

```bash
bunx playwright test tests/e2e/side-panel.spec.ts
```

Expected: the three new tests PASS. If `#content-language-select` is not found, check whether `SettingsCard` is rendered expanded — it is `collapsible` in the side panel, so the header may need clicking first:

```ts
	await page.locator('.settings-card-header.clickable').click();
```

- [ ] **Step 4: Commit**

```bash
bunx biome check --write tests/e2e/side-panel.spec.ts src/shared/components/SettingsCard.tsx
git add tests/e2e/side-panel.spec.ts src/shared/components/SettingsCard.tsx
git commit -m "test: pin choosing the language and voice before reading"
```

---

### Task 16: Verify everything

- [ ] **Step 1: Lint, typecheck, unit**

```bash
bunx biome check . && bunx tsc --noEmit && bun test tests/unit
```

Expected: all three PASS.

- [ ] **Step 2: Build both targets**

```bash
bun run build
```

Expected: the chrome and firefox builds both complete without errors.

- [ ] **Step 3: Check that ONNX did not leak into the panel bundle**

```bash
grep -c "onnxruntime" dist/chrome/static/js/sidepanel*.js || echo "no onnx in the sidepanel bundle"
```

Expected: `no onnx in the sidepanel bundle`. If there is, Task 3 did not split it cleanly — re-check the import path of `AVAILABLE_LANGS`.

- [ ] **Step 4: E2E**

```bash
bunx playwright test
```

Expected: PASS. If a test was already red before starting, compare against `git stash` to confirm this plan did not cause it.

- [ ] **Step 5: Check by hand on a real page**

Load `dist/chrome` into Chrome in developer mode, open an article on `vnexpress.net`, and open the side panel **without pressing play**. Confirm:
1. The language dropdown reads `Tự động (Tiếng Việt)`
2. The voice dropdown lists Vietnamese voices
3. Press play — the voice does not change

- [ ] **Step 6: A final commit if anything else changed**

```bash
git status
```

---

## Where this plan departs from the spec

- The spec lists a verification row for "the dropdown locks during playback" as a *component test*. The repo has no component-test infrastructure (not one `.test.tsx` file in `tests/unit`), so that row moves to e2e in Task 15.
- The spec does not record that `src/background/manual_text.ts` already holds **a second detector** (`detectManualTextLanguage`) with its own zh/vi/en logic. Task 14 has it share the script layer rather than letting two detectors diverge, and keeps the Vietnamese function-word heuristic because it is the only thing that recognises unaccented Vietnamese.
- The spec did not anticipate that `AVAILABLE_LANGS` lives in a module that pulls in the ONNX Runtime. Task 3 splits it out so the language list does not bloat the panel bundle.
