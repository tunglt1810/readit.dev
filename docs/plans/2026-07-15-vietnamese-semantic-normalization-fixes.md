# Vietnamese Semantic Normalization Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct hour-only times, grouped USD amounts, and false Roman-numeral expansion of Vietnamese words without retraining the CRF model.

**Architecture:** Keep the tokenizer, CRF checkpoint, typed-expansion pipeline, and Supertonic runtime unchanged. Add narrow deterministic corrections after CRF detection: support hour-only `NTIM`, give only strict `MONEY` shapes override authority, and require CRF or explicit context before Roman-numeral expansion while protecting Vietnamese syllables.

**Tech Stack:** TypeScript 6, Node test runner, bundled portable CRF assets, JSON evaluation fixtures, pnpm, Rsbuild, Playwright

## Global Constraints

- Follow `_docs/specs/2026-07-15-vietnamese-semantic-normalization-fixes.md` exactly.
- Keep all article text processing local; add no network request, permission, telemetry, dependency, or model asset.
- Do not retrain or replace the CRF checkpoint or abbreviation scorer.
- Only deterministic `MONEY` may gain a positive-label override over a supported CRF label; the Roman policy may only clear a false `B-ROMA` for an unqualified Vietnamese syllable.
- Preserve fail-open behavior, source punctuation and whitespace, and normalization idempotency.
- Keep Vietnamese-English code-switch handling, including `resort`, out of scope.
- Store any manual-test HTML or other scratch artifact under the repository's `.tmp/` directory.
- Do not modify or commit the user's untracked `context_improvement.md`.

## File Map

- `src/offscreen/vietnamese/expanders.ts`: strict typed expansion and shape predicates for time, money, and Roman numerals.
- `src/offscreen/vietnamese/normalizer.ts`: CRF/deterministic precedence, malformed-money preservation, and contextual Roman-numeral policy.
- `tests/unit/vietnamese_expanders.test.ts`: direct typed-expander and recognizer regressions.
- `tests/unit/vietnamese_normalizer.test.ts`: end-to-end normalization precedence, context, preservation, and idempotency regressions.
- `tests/fixtures/vietnamese-normalizer/expansion-goldens.json`: reviewed deterministic `10h` expansion.
- `tests/fixtures/vietnamese-normalizer/evaluation-corpus.json`: production-model document covering all three semantic regressions together.
- `tests/fixtures/vietnamese-normalizer/must-not-change.json`: Vietnamese `di` preservation cases.

---

### Task 1: Expand hour-only Vietnamese times

**Files:**
- Modify: `src/offscreen/vietnamese/expanders.ts:180-193,297-332`
- Test: `tests/unit/vietnamese_expanders.test.ts`
- Test fixture: `tests/fixtures/vietnamese-normalizer/expansion-goldens.json`

**Interfaces:**
- Consumes: `expandInteger(value: string): string | null` from `number_words.ts`.
- Produces: `expandTypedSpan('NTIM', '10h') === 'mười giờ'` and `recognizeDeterministicType('10h') === 'NTIM'`.

- [ ] **Step 1: Add failing hour-only tests**

Add this focused test after the required-pronunciation-table test in `tests/unit/vietnamese_expanders.test.ts`:

```ts
test('expands valid hour-only times and preserves invalid hours', () => {
	assert.equal(expandTypedSpan('NTIM', '0h'), 'không giờ');
	assert.equal(expandTypedSpan('NTIM', '10h'), 'mười giờ');
	assert.equal(expandTypedSpan('NTIM', '23h'), 'hai mươi ba giờ');
	assert.equal(expandTypedSpan('NTIM', '24h'), null);
	assert.equal(recognizeDeterministicType('10h'), 'NTIM');
	assert.equal(recognizeDeterministicType('24h'), null);
});
```

Add a second reviewed `NTIM` entry immediately after the existing `08:30` entry in `tests/fixtures/vietnamese-normalizer/expansion-goldens.json`:

```json
{ "type": "NTIM", "input": "10h", "expected": "mười giờ", "oracle": "manual-review-2026-07-15" },
```

- [ ] **Step 2: Run the focused test and confirm the regression**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts
```

Expected: FAIL because `expandTypedSpan('NTIM', '10h')` and `recognizeDeterministicType('10h')` currently return `null`.

- [ ] **Step 3: Implement the minimal hour-only expansion**

At the start of `expandTime` in `src/offscreen/vietnamese/expanders.ts`, parse the hour-only shape before the existing hour-minute shape:

```ts
function expandTime(source: string): string | null {
	const input = source.trim();
	const hourOnly = /^(\d{1,2})h$/u.exec(input);
	if (hourOnly) {
		const hour = Number(hourOnly[1]);
		return hour <= 23 ? `${expandInteger(hourOnly[1])} giờ` : null;
	}

	const match = /^(\d{1,2})[:hg](\d{1,2})(?:[:mp](\d{1,2}))?$/u.exec(input);
	if (!match) {
		return null;
	}
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = match[3] === undefined ? undefined : Number(match[3]);
	if (hour > 23 || minute > 59 || (second !== undefined && second > 59)) {
		return null;
	}
	const base = `${expandInteger(match[1])} giờ ${expandInteger(match[2])} phút`;
	return second === undefined ? base : `${base} ${expandInteger(match[3])} giây`;
}
```

Replace the current deterministic time check with:

```ts
if ((/^\d{1,2}h$/u.test(source) || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(source)) && expandTime(source)) {
	return 'NTIM';
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts
```

Expected: PASS with no failed tests.

- [ ] **Step 5: Commit the hour-only behavior**

```bash
git add src/offscreen/vietnamese/expanders.ts tests/unit/vietnamese_expanders.test.ts tests/fixtures/vietnamese-normalizer/expansion-goldens.json
git commit -m "Fix hour-only Vietnamese time expansion"
```

---

### Task 2: Give strict money shapes narrow override authority

**Files:**
- Modify: `src/offscreen/vietnamese/expanders.ts:168-178,297-332`
- Modify: `src/offscreen/vietnamese/normalizer.ts:1-63`
- Test: `tests/unit/vietnamese_expanders.test.ts`
- Test: `tests/unit/vietnamese_normalizer.test.ts`

**Interfaces:**
- Consumes: `expandTypedSpan('MONEY', source)` and `recognizeDeterministicType(source)` from `expanders.ts`.
- Produces: `isCurrencyShapedToken(rawSource: string): boolean`; valid money becomes `B-MONEY`, while rejected currency-shaped tokens become `O` and retain their source text.

- [ ] **Step 1: Add failing strict-money and precedence tests**

Extend the import in `tests/unit/vietnamese_expanders.test.ts`:

```ts
import {
	expandTypedSpan,
	isCurrencyShapedToken,
	recognizeDeterministicType,
} from '../../src/offscreen/vietnamese/expanders.ts';
```

Add:

```ts
test('expands strict money shapes and identifies rejected currency-shaped tokens', () => {
	assert.equal(expandTypedSpan('MONEY', '1.000 USD'), 'một nghìn đô la');
	assert.equal(expandTypedSpan('MONEY', '1.000,50 USD'), 'một nghìn phẩy năm không đô la');
	assert.equal(expandTypedSpan('MONEY', '1.00 USD'), null);
	assert.equal(isCurrencyShapedToken('1.000 USD'), true);
	assert.equal(isCurrencyShapedToken('1.00 USD'), true);
	assert.equal(isCurrencyShapedToken('USD'), false);
});
```

Add this test to `tests/unit/vietnamese_normalizer.test.ts`:

```ts
test('lets strict money override CRF LSEQ and preserves rejected money shapes', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token) => (token.text.endsWith('USD') ? 'B-LSEQ' : 'O'));
		},
	};
	const source = 'Chi phí 1.000 USD. Mã 1.00 USD.';
	const first = await normalizeVietnameseText(source, dependencies);
	const second = await normalizeVietnameseText(first.text, dependencies);
	assert.equal(first.text, 'Chi phí một nghìn đô la. Mã 1.00 USD.');
	assert.equal(second.text, first.text);
});
```

- [ ] **Step 2: Run both focused test files and confirm failure**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts tests/unit/vietnamese_normalizer.test.ts
```

Expected: FAIL because `isCurrencyShapedToken` is not exported and the normalizer currently retains the CRF `LSEQ` label.

- [ ] **Step 3: Add the currency-shape predicate**

Add this exported helper immediately before `expandMoney` in `src/offscreen/vietnamese/expanders.ts`:

```ts
export function isCurrencyShapedToken(rawSource: string): boolean {
	const source = rawSource.trim();
	return /^(?:[$€¥£₩]\s*\S+|\S+\s*(?:₫|đ|VND|USD|EUR))$/iu.test(source);
}
```

This helper recognizes the outer currency shape only. `expandMoney` remains the strict validator for numeric grouping and supported units.

- [ ] **Step 4: Implement valid-money override and invalid-money preservation**

Update the import at the top of `src/offscreen/vietnamese/normalizer.ts`:

```ts
import { expandTypedSpan, isCurrencyShapedToken, recognizeDeterministicType } from './expanders.ts';
```

Replace the generic deterministic-label block inside `deterministicOverlay` with:

```ts
const type = recognizeDeterministicType(source);
if (type === 'MONEY') {
	labels[index] = 'B-MONEY';
	continue;
}
if (isCurrencyShapedToken(source)) {
	labels[index] = 'O';
	continue;
}
if (type && (labels[index] === 'O' || type === 'NVER')) {
	labels[index] = `B-${type}`;
	continue;
}
```

Do not add any other type to the override condition.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts tests/unit/vietnamese_normalizer.test.ts
```

Expected: PASS with strict USD expansion, malformed grouping preservation, and idempotency.

- [ ] **Step 6: Commit the money precedence fix**

```bash
git add src/offscreen/vietnamese/expanders.ts src/offscreen/vietnamese/normalizer.ts tests/unit/vietnamese_expanders.test.ts tests/unit/vietnamese_normalizer.test.ts
git commit -m "Fix Vietnamese money normalization precedence"
```

---

### Task 3: Make Roman-numeral expansion contextual

**Files:**
- Modify: `src/offscreen/vietnamese/expanders.ts:90-119,286-332`
- Modify: `src/offscreen/vietnamese/normalizer.ts:1-85`
- Test: `tests/unit/vietnamese_expanders.test.ts`
- Test: `tests/unit/vietnamese_normalizer.test.ts`

**Interfaces:**
- Consumes: `VietnameseNormalizerAssets.vietnameseSyllables`, CRF `CheckpointLabel[]`, and source-token neighbors.
- Produces: `isUppercaseRomanNumeral(rawSource: string): boolean`; generic deterministic recognition no longer returns `ROMA`; `deterministicOverlay` applies Vietnamese-syllable veto and explicit-context fallback.

- [ ] **Step 1: Add failing Roman-numeral safety tests**

Add `isUppercaseRomanNumeral` to the multiline expander import introduced in Task 2, then add:

```ts
test('keeps generic deterministic recognition away from Roman-shaped words', () => {
	assert.equal(isUppercaseRomanNumeral('XIV'), true);
	assert.equal(isUppercaseRomanNumeral('DI'), true);
	assert.equal(isUppercaseRomanNumeral('di'), false);
	assert.equal(expandTypedSpan('ROMA', 'XIV'), 'mười bốn');
	assert.equal(recognizeDeterministicType('XIV'), null);
	assert.equal(recognizeDeterministicType('DI'), null);
});
```

Add these tests to `tests/unit/vietnamese_normalizer.test.ts`:

```ts
test('protects Roman-shaped Vietnamese syllables even when CRF labels them ROMA', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.vietnameseSyllables = new Set([...dependencies.assets.vietnameseSyllables, 'di']);
	dependencies.assets.detector = {
		detect(tokens) {
			return tokens.map((token) => (/^(?:di|xiv)$/iu.test(token.text) ? 'B-ROMA' : 'O'));
		},
	};
	const source = 'thiết bị di động. DI CHUYỂN. Mục XIV.';
	const first = await normalizeVietnameseText(source, dependencies);
	const second = await normalizeVietnameseText(first.text, dependencies);
	assert.equal(first.text, 'thiết bị di động. DI CHUYỂN. Mục mười bốn.');
	assert.equal(second.text, first.text);
});

test('uses explicit context for Roman numerals when CRF is unavailable', async () => {
	const dependencies = createTestNormalizationDependencies();
	dependencies.assets.vietnameseSyllables = new Set([...dependencies.assets.vietnameseSyllables, 'di']);
	dependencies.assets.detector = null;
	assert.equal(
		(await normalizeVietnameseText('Mục DI. Chương IV. thế kỷ XXI. IV. Phạm vi.', dependencies)).text,
		'Mục năm trăm linh một. Chương bốn. thế kỷ hai mươi mốt. bốn. Phạm vi.',
	);
});
```

- [ ] **Step 2: Run the focused tests and confirm false Roman expansion**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts tests/unit/vietnamese_normalizer.test.ts
```

Expected: FAIL because generic deterministic recognition currently returns `ROMA` for `DI`, `di`, and `XIV` without context.

- [ ] **Step 3: Export an uppercase Roman-shape predicate and remove unconditional recognition**

Add after `parseRoman` in `src/offscreen/vietnamese/expanders.ts`:

```ts
export function isUppercaseRomanNumeral(rawSource: string): boolean {
	const source = rawSource.trim();
	return source.length > 0 && source === source.toUpperCase() && parseRoman(source) !== null;
}
```

Delete this block from `recognizeDeterministicType`:

```ts
if (parseRoman(source) !== null) {
	return 'ROMA';
}
```

Keep `expandTypedSpan('ROMA', source)` unchanged so CRF-confirmed and contextual spans still use the existing canonical-number conversion.

- [ ] **Step 4: Add explicit Roman context and Vietnamese-syllable veto**

Update the expander import in `src/offscreen/vietnamese/normalizer.ts`:

```ts
import {
	expandTypedSpan,
	isCurrencyShapedToken,
	isUppercaseRomanNumeral,
	recognizeDeterministicType,
} from './expanders.ts';
```

Add these helpers before `deterministicOverlay`:

```ts
const ROMAN_CONTEXT_WORDS = new Set(['mục', 'chương', 'phần', 'quý', 'điều', 'khoản']);

function hasExplicitRomanContext(tokens: readonly SourceToken[], index: number): boolean {
	const previousWords = tokens
		.slice(Math.max(0, index - 3), index)
		.filter((token) => token.kind === 'word')
		.map((token) => token.text.toLocaleLowerCase('vi'));
	const previous = previousWords.at(-1);
	const previousPhrase = previousWords.slice(-2).join(' ');
	const isOutlineMarker =
		/^[.)]$/u.test(tokens[index + 1]?.text ?? '') && (index === 0 || tokens[index - 1]?.kind === 'punctuation');
	return Boolean((previous && ROMAN_CONTEXT_WORDS.has(previous)) || previousPhrase === 'thế kỷ' || isOutlineMarker);
}
```

Change the function signature to receive the existing syllable dictionary:

```ts
function deterministicOverlay(
	tokens: readonly SourceToken[],
	labels: CheckpointLabel[],
	vietnameseSyllables: ReadonlySet<string>,
): void {
```

Immediately after the IP/identifier protection block inside the loop, add:

```ts
const explicitRomanContext = isUppercaseRomanNumeral(source) && hasExplicitRomanContext(tokens, index);
const isVietnameseRomanWord = /^[IVXLCDM]+$/iu.test(source) && vietnameseSyllables.has(source.toLocaleLowerCase('vi'));
if (isVietnameseRomanWord && !explicitRomanContext && labels[index] === 'B-ROMA') {
	labels[index] = 'O';
}
```

After the money/generic deterministic block from Task 2 and before `if (labels[index] !== 'O')`, add:

```ts
if (explicitRomanContext && labels[index] === 'O') {
	labels[index] = 'B-ROMA';
	continue;
}
```

Pass the dictionary from `detectVietnameseLabels`:

```ts
deterministicOverlay(tokens, labels, assets.vietnameseSyllables);
```

- [ ] **Step 5: Run focused and complete unit tests**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts tests/unit/vietnamese_normalizer.test.ts
pnpm test:unit
```

Expected: both commands PASS; `DI CHUYỂN` remains unchanged while CRF-confirmed `XIV` and contextual fallback examples expand.

- [ ] **Step 6: Commit contextual Roman handling**

```bash
git add src/offscreen/vietnamese/expanders.ts src/offscreen/vietnamese/normalizer.ts tests/unit/vietnamese_expanders.test.ts tests/unit/vietnamese_normalizer.test.ts
git commit -m "Protect Vietnamese words from Roman expansion"
```

---

### Task 4: Extend the production-model evaluation gate

**Files:**
- Modify: `tests/fixtures/vietnamese-normalizer/evaluation-corpus.json`
- Modify: `tests/fixtures/vietnamese-normalizer/must-not-change.json`

**Interfaces:**
- Consumes: `pnpm evaluate:vi`, which loads the bundled CRF model and compares detected spans plus complete normalized text against fixture goldens.
- Produces: a 31-document, 216-span evaluation corpus and preservation checks for lowercase and uppercase Vietnamese `di` contexts.

- [ ] **Step 1: Append the reviewed production-model document**

Append this object to `tests/fixtures/vietnamese-normalizer/evaluation-corpus.json`, adding a comma after the preceding object:

```json
{
	"id": "semantic-regressions-1",
	"domain": "general",
	"scenario": "semantic-regressions",
	"text": "DI CHUYỂN lúc 10h, chi phí 1.000 USD. Mục XIV quy định phạm vi áp dụng.",
	"spans": [
		{
			"start": 14,
			"end": 17,
			"type": "NTIM",
			"expected": "mười giờ"
		},
		{
			"start": 27,
			"end": 36,
			"type": "MONEY",
			"expected": "một nghìn đô la"
		},
		{
			"start": 42,
			"end": 45,
			"type": "ROMA",
			"expected": "mười bốn"
		}
	],
	"source": "manual semantic regression review 2026-07-15",
	"license": "CC0-1.0"
}
```

- [ ] **Step 2: Replace the preservation fixture with the complete reviewed list**

Use this exact content for `tests/fixtures/vietnamese-normalizer/must-not-change.json`:

```json
[
	"https://example.vn/11/07?id=v1.2.3",
	"dev-team@example.vn",
	"29/02/2023",
	"31/04/2026",
	"AB-123-CD",
	"0901234567",
	"IPv4 192.168.1.1",
	"mã 11/99/2026",
	"thiết bị di động",
	"DI CHUYỂN"
]
```

- [ ] **Step 3: Run the production evaluator**

Run:

```bash
pnpm evaluate:vi
```

Expected JSON fields:

```json
{
	"documents": 31,
	"spans": 216,
	"precision": 1,
	"recall": 1,
	"f1": 1,
	"deterministicRate": 1,
	"preservationRate": 1,
	"emptyDocuments": 0,
	"fallbackDocuments": 0,
	"mismatchSamples": [],
	"normalizationMismatches": [],
	"preservationFailures": []
}
```

The actual report also contains the same named fields in its existing order. Stop and diagnose rather than weakening a threshold if any value differs.

- [ ] **Step 4: Commit the production regression corpus**

```bash
git add tests/fixtures/vietnamese-normalizer/evaluation-corpus.json tests/fixtures/vietnamese-normalizer/must-not-change.json
git commit -m "Add Vietnamese semantic regression corpus"
```

---

### Task 5: Verify the extension and complete listening checks

**Files:**
- Create temporary manual fixture: `.tmp/vietnamese-semantic-normalization.html`
- Verify generated output: `dist/manifest.json`
- Verify existing E2E behavior: `tests/e2e/vietnamese-pronunciation.spec.ts` and full `tests/e2e/`

**Interfaces:**
- Consumes: all implementation and fixture commits from Tasks 1-4.
- Produces: build, manifest, unit, corpus, browser-runtime, and human-listening evidence required by the approved spec.

- [ ] **Step 1: Run all normalization and unit gates from the repository root**

```bash
pnpm test:unit
pnpm evaluate:vi
```

Expected: both commands exit 0; the evaluator reports 31 documents, 216 spans, F1 `1`, preservation rate `1`, and no mismatches or fallbacks.

- [ ] **Step 2: Build and validate the production extension**

```bash
CI=true pnpm build
pnpm validate:manifest
pnpm validate:vi-assets:release
```

Expected: all commands exit 0; `dist/manifest.json` passes the Free manifest boundary and all checksummed Vietnamese/runtime assets exist in `dist/`.

- [ ] **Step 3: Run Vietnamese and full browser suites**

```bash
CI=true pnpm test:e2e:vi
CI=true pnpm test:e2e
```

Expected: both Playwright commands exit 0 with no failed, skipped-by-error, or flaky-final-result tests.

- [ ] **Step 4: Create the local manual-listening fixture under `.tmp/`**

Create `.tmp/vietnamese-semantic-normalization.html` with exactly:

```html
<!doctype html>
<html lang="vi">
	<head>
		<meta charset="utf-8" />
		<title>Kiểm thử semantic normalization</title>
	</head>
	<body>
		<main>
			<article>
				<h1>Kiểm thử semantic normalization</h1>
				<p>Lịch bắt đầu lúc 10h.</p>
				<p>Chi phí dự kiến là 1.000 USD.</p>
				<p>Đây là thiết bị di động.</p>
				<p>DI CHUYỂN — Mục XIV quy định phạm vi áp dụng.</p>
			</article>
		</main>
	</body>
</html>
```

Serve it from the repository root:

```bash
python3 -m http.server 4173 --directory .tmp
```

Expected: `http://127.0.0.1:4173/vietnamese-semantic-normalization.html` returns the fixture. Keep the server in a managed terminal session while listening; do not write scratch files outside `.tmp/`.

- [ ] **Step 5: Listen through the unpacked production build**

Load `dist/` as an unpacked Chrome extension, open the local fixture, and play the article with the same Vietnamese voice and speed for every line.

Acceptance evidence:

- `10h` conveys `mười giờ`.
- `1.000 USD` conveys `một nghìn đô la`.
- Neither lowercase nor uppercase `DI` is spoken as 501.
- `XIV` is still spoken as fourteen.
- No line is skipped, repeated, or blocked by normalization.

If human listening cannot be performed in the execution environment, report this gate as outstanding; do not claim the implementation complete.

- [ ] **Step 6: Check repository hygiene**

```bash
git diff --check
git status --short
```

Expected: `git diff --check` prints nothing. `git status --short` contains no implementation/test changes after the task commits; the pre-existing untracked `context_improvement.md` and ignored `.tmp/` artifacts are not staged or committed.
