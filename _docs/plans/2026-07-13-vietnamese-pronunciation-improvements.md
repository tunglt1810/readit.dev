# Vietnamese Pronunciation Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (only with explicit delegation approval) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, local Vietnamese text normalization and punctuation-aware pause planning before Supertonic so abbreviations, dates, numbers, and semantic boundaries are pronounced naturally without changing the Free MVP privacy boundary.

**Architecture:** Keep the existing `Article` and playback-session contracts unchanged. Add a TypeScript preparation pipeline inside the offscreen layer: reversible tokenization, typed CRF detection, deterministic expansion, constrained abbreviation scoring, and `SpeechUnit[]` planning; then synthesize one unit at a time with Supertonic and append explicit silence in the audio buffer. Bundle and checksum all normalizer assets, reuse the existing `onnxruntime-web`, and treat custom Viterbi WASM as a separate conditional follow-up only if real Chrome profiling crosses every gate in the approved specification.

**Tech Stack:** TypeScript 6, ONNX Runtime Web 1.26, Supertonic 3, Chrome Manifest V3 offscreen documents, Node test runner, Playwright/Chromium, Rsbuild/Rspack, Python 3 for development-time CRF export only, GitHub Actions.

## Global Constraints

- The source of truth is `_docs/specs/2026-07-13-vietnamese-pronunciation-improvements.md`.
- Normalize only resolved language `vi`; every non-Vietnamese article retains the existing Supertonic path.
- Preserve the Free MVP local-only boundary: no backend normalization, cloud AI, telemetry, translation, durable article/audio storage, or remotely hosted executable code.
- Do not add image-caption behavior in this plan.
- Do not add a JavaScript runtime dependency; reuse `onnxruntime-web@1.26.0`.
- Pin `soe-vinorm` v0.3.2 source commit `c2b0c1eb36cec1584416ca4652b5391f4e723727`; resolve the model repository's abbreviated revision to its full immutable commit during asset export.
- Bundle CRF weights, abbreviation scorer, dictionaries, and configuration inside the extension; their combined uncompressed budget is at most 5 MiB (`5_242_880` bytes).
- Abort asset inclusion if any derived code, model, or dictionary lacks an explicit redistributable license; do not silently substitute an unreviewed source.
- Keep Supertonic parameters at `lang = "vi"`, `total_steps = 8`, existing user speed range `0.70`-`1.80` and default `1.05`, `graphOptimizationLevel = "all"`, WebGPU before WASM, and one-unit prefetch.
- Vietnamese speech units prefer 200 characters, never exceed 300 characters, and use `silenceDuration = 0` inside Supertonic.
- Centralized pauses are exactly comma `60 ms`, colon/semicolon `90 ms`, spaced dash `105 ms`, sentence end `165 ms`, and paragraph end `260 ms`; the strongest boundary wins and pauses are not additive.
- Unknown, ambiguous, malformed, non-finite, or failed normalization restores the complete original source span and playback continues.
- Store every download, generated scratch artifact, browser profile, benchmark build, and report under repository `.tmp/`; never use the operating-system temp directory.
- Preserve unrelated worktree content, especially `context_improvement.md`; stage only files named by a task.
- Do not commit during implementation until anh guộc explicitly authorizes commits. Each commit step below is a future checkpoint, not current authorization.
- Do not begin a custom Rust/WASM Viterbi implementation from this plan. Trigger a separate reviewed plan only if Chrome misses the p95 budget, Viterbi exceeds 50% of normalization time, a prototype improves end-to-end normalization by at least 20%, and output is byte-identical.

---

## File Structure

### Runtime modules

- Create `src/offscreen/vietnamese/types.ts`: shared NSW labels, source-token, portable-model, normalization-result, and speech-unit contracts.
- Create `src/offscreen/vietnamese/tokenizer.ts`: NFC/whitespace normalization, protected structured-token scanning, paragraph preservation, punctuation separation, and reversible source spans.
- Create `src/offscreen/vietnamese/features.ts`: reference-compatible CRF token features and conversion to CRFsuite attribute/value pairs.
- Create `src/offscreen/vietnamese/crf.ts`: portable CRF validation, sparse emission construction, typed-array Viterbi decoding, BIO validation, and span reconstruction.
- Create `src/offscreen/vietnamese/number_words.ts`: Vietnamese digit, integer, grouped-number, and decimal readings.
- Create `src/offscreen/vietnamese/expanders.ts`: deterministic typed expanders for date/time, numeric, sequence, URL/email, measurement, money, version, score, range, fraction, quarter, Roman numeral, and foreign-word cases.
- Create `src/offscreen/vietnamese/abbreviations.ts`: dictionary parsing, deterministic precedence, safe uppercase-letter reading, constrained candidate selection, and confidence policy.
- Create `src/offscreen/vietnamese/abbreviation_scorer.ts`: ONNX Runtime adapter for the bundled likelihood scorer.
- Create `src/offscreen/vietnamese/assets.ts`: single-flight local asset loading, checksum/schema validation, CRF construction, and optional abbreviation-scorer construction.
- Create `src/offscreen/vietnamese/normalizer.ts`: paragraph-level orchestration, deterministic-recognizer fallback, fail-open source restoration, idempotence guard, and local timing diagnostics.
- Create `src/offscreen/vietnamese/speech_units.ts`: centralized pause policy and preferred/hard-length segmentation.
- Create `src/offscreen/playback_preparation.ts`: Vietnamese-only preparation and non-Vietnamese `chunkText` compatibility path.
- Create `src/offscreen/audio.ts`: append exact silence samples to synthesized waveform data.
- Modify `src/offscreen/offscreen.ts`: queue `SpeechUnit[]`, load the normalizer locally, synthesize with zero internal silence, append unit pauses, and preserve one-unit prefetch/cancellation.
- Modify `src/offscreen/supertonic_helper.ts`: centralize the production ORT runtime variant and retain verified single-thread default unless the benchmark gate passes.

### Bundled assets and supply chain

- Create `public/assets/vietnamese-normalizer/model-manifest.json`: versioned source, full revisions, SHA-256 checksums, byte sizes, CRF labels, and calibrated abbreviation threshold.
- Create `public/assets/vietnamese-normalizer/crf-model.bin`: deterministic compact sparse CRF attributes, state weights, and transition weights.
- Create `public/assets/vietnamese-normalizer/abbreviations.txt`: pinned vetted abbreviation candidates.
- Create `public/assets/vietnamese-normalizer/vietnamese-syllables.txt`: pinned dictionary used by reference-compatible features.
- Create `public/assets/vietnamese-normalizer/abbreviation-config.json`: scorer vocabulary, context window, and sequence length.
- Create `public/assets/vietnamese-normalizer/abbreviation-scorer.onnx`: bundled constrained-candidate scorer.
- Create `scripts/sync-vietnamese-normalizer-assets.py`: development-only pinned download/export/checksum pipeline whose scratch root is `.tmp/vietnamese-normalizer-assets/`.
- Create `scripts/validate-vietnamese-normalizer-assets.mjs`: schema, checksum, license metadata, size-budget, build-output, and allowed-WASM validation.
- Modify `public/THIRD_PARTY_NOTICES.txt`: add exact `soe-vinorm` source/model/dictionary attribution and MIT terms after license review.
- Modify `package.json`: add asset validation, corpus evaluation, Chrome benchmark, and focused E2E scripts.

### Tests and evaluation data

- Create `tests/unit/vietnamese_tokenizer.test.ts`.
- Create `tests/unit/vietnamese_features.test.ts`.
- Create `tests/unit/vietnamese_crf.test.ts`.
- Create `tests/unit/vietnamese_expanders.test.ts`.
- Create `tests/unit/vietnamese_abbreviations.test.ts`.
- Create `tests/unit/vietnamese_normalizer.test.ts`.
- Create `tests/unit/vietnamese_speech_units.test.ts`.
- Create `tests/unit/offscreen_audio.test.ts`.
- Create `tests/unit/playback_preparation.test.ts`.
- Create `tests/unit/vietnamese_assets.test.ts`.
- Create `tests/fixtures/vietnamese-normalizer/reference-goldens.json`: deterministic oracle inputs, BIO labels, and expected expansions.
- Create `tests/fixtures/vietnamese-normalizer/evaluation-corpus.json`: at least 30 reviewed news excerpts, 200 labeled NSW spans, 20 abbreviation contexts, and 20 date/time/number cases.
- Create `tests/fixtures/vietnamese-normalizer/must-not-change.json`: adversarial URLs, identifiers, invalid dates, versions, phone-like sequences, and ambiguous values.
- Create `scripts/evaluate-vietnamese-normalizer.ts`: micro-F1, golden equality, preservation, source-loss, and empty-output gates.
- Create `tests/performance/vietnamese_offscreen_benchmark.html` and `tests/performance/vietnamese_offscreen_benchmark.ts`: test-build-only benchmark entry running in an actual offscreen document.
- Create `scripts/run-vietnamese-offscreen-benchmark.mjs`: build/launch/profile driver that writes reports only below `.tmp/`.
- Create `tests/e2e/vietnamese-pronunciation.spec.ts`: Vietnamese full-page/selected-text routing, fail-open startup, stop/cancellation, and ORT asset request coverage.
- Create `_docs/evaluations/vietnamese-pronunciation-listening.md`: fixed human A/B protocol and signed results table.

### Build and release

- Modify `rsbuild.config.ts`: optional test-only offscreen benchmark entry and selective verified ONNX Runtime WASM/MJS copying.
- Modify `public/manifest.json`: narrow ONNX Runtime web-accessible resources; add cross-origin isolation only if the thread benchmark passes all gates.
- Modify `.github/workflows/release-extension.yml`: validate assets/notices, evaluate deterministic corpus, and assert packaged assets plus allowed WASM files.
- Modify `_docs/RELEASING.md`: add pronunciation quality, listening, performance, and package-verification gates.
- Modify `_docs/specs/2026-07-13-vietnamese-pronunciation-improvements.md`: mark implemented only after every automated and human gate passes.

---

### Task 1: Pin, export, license, and validate normalizer assets

**Files:**
- Create: `scripts/sync-vietnamese-normalizer-assets.py`
- Create: `scripts/validate-vietnamese-normalizer-assets.mjs`
- Create: `tests/unit/vietnamese_assets.test.ts`
- Create: `public/assets/vietnamese-normalizer/*`
- Modify: `public/THIRD_PARTY_NOTICES.txt`
- Modify: `package.json`

**Interfaces:**
- Produces the immutable asset directory consumed by `loadVietnameseNormalizerAssets()` in Task 6.
- Produces `validateVietnameseNormalizerAssets(rootDir: string, options?): Promise<AssetValidationReport>` from the validator module, where `AssetValidationReport` is `{ totalBytes: number; fileCount: number; modelRevision: string; wasmFiles: string[] }`.
- Produces manifest format version `1`, total-byte budget `5_242_880`, the 30 ordered native checkpoint labels, and a full 40-character model revision.
- Consumes only pinned source commit `c2b0c1eb36cec1584416ca4652b5391f4e723727` and the model revision resolved from the reference's `cb9705b` ref.

- [ ] **Step 1: Write failing validator tests**

Create `tests/unit/vietnamese_assets.test.ts` with repository-local scratch setup and these cases:

```ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { validateVietnameseNormalizerAssets } from '../../scripts/validate-vietnamese-normalizer-assets.mjs';

function scratchDir(): string {
	mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
	return mkdtempSync(join(process.cwd(), '.tmp', 'vi-assets-test-'));
}

test('rejects a manifest with a non-immutable model revision', async (t) => {
	const root = scratchDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, 'model-manifest.json'), JSON.stringify({
		formatVersion: 1,
		source: { commit: 'c2b0c1eb36cec1584416ca4652b5391f4e723727' },
		modelSource: { revision: 'cb9705b' },
		assetBudgetBytes: 5_242_880,
		files: [],
	}));
	await assert.rejects(() => validateVietnameseNormalizerAssets(root), /full 40-character model revision/);
});

test('rejects a checksum mismatch and an over-budget asset set', async (t) => {
	const root = scratchDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, 'abbreviations.txt'), 'ĐH:đại học\n');
	writeFileSync(join(root, 'model-manifest.json'), JSON.stringify({
		formatVersion: 1,
		source: { commit: 'c2b0c1eb36cec1584416ca4652b5391f4e723727', license: 'MIT' },
		modelSource: { revision: '1234567890123456789012345678901234567890', license: 'MIT' },
		assetBudgetBytes: 1,
		files: [{ path: 'abbreviations.txt', bytes: 14, sha256: '0'.repeat(64), license: 'MIT' }],
	}));
	await assert.rejects(() => validateVietnameseNormalizerAssets(root), /checksum|budget/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_assets.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/validate-vietnamese-normalizer-assets.mjs`.

- [ ] **Step 3: Implement the validator as both a module and CLI**

The validator must:

1. parse `model-manifest.json` and require `formatVersion === 1`;
2. require the exact source commit and a 40-character lowercase hexadecimal model revision;
3. require an explicit license string on each source and file record;
4. reject duplicate paths, absolute paths, `..`, missing files, wrong byte sizes, or SHA-256 mismatches;
5. reject an asset total above `assetBudgetBytes` or `5_242_880`, whichever is lower;
6. require the exact 30 unique labels exposed by the immutable checkpoint, in native order: 28 recognized BIO labels covering the 19 approved types, `O`, and legacy `B-USS`; do not synthesize absent `I-*` states;
7. when passed a built `dist` directory, require the same asset files and `THIRD_PARTY_NOTICES.txt` there;
8. when passed `--check-wasm`, allow only the exact ONNX Runtime files declared by Task 10.

Export this exact API:

```js
export async function validateVietnameseNormalizerAssets(rootDir, options = {}) {
	// options.distDir?: string; options.checkWasm?: boolean
	// returns { totalBytes, fileCount, modelRevision, wasmFiles }
}
```

The CLI invocation is:

```bash
node scripts/validate-vietnamese-normalizer-assets.mjs public/assets/vietnamese-normalizer
```

Expected after only this step: validation still fails because the pinned assets do not exist yet, proving the validator is active.

- [ ] **Step 4: Implement the pinned development-time sync/export script**

`scripts/sync-vietnamese-normalizer-assets.py` must:

- refuse an output directory outside the repository;
- use `.tmp/vietnamese-normalizer-assets/` for clone, Hugging Face cache, virtual environment instructions, and intermediate files;
- verify the `soe-vinorm` Git checkout equals the exact v0.3.2 commit;
- resolve `vinhdq842/soe-vinorm` revision `cb9705b` through the Hugging Face API and record the returned full commit;
- download only `abbreviation_expander/v0.2/config.json`, `abbreviation_expander/v0.2/scorer.onnx`, and `nsw_detector/crf.pkl`;
- copy the two pinned dictionaries from the verified source checkout;
- load `crf.pkl` only in Python, export `classes_`, `state_features_`, and `transition_features_` to the deterministic binary format below, and never copy the pickle into `public/`;
- write the final files atomically, compute SHA-256 and byte size after writing, and generate manifest format version `1`;
- leave the abbreviation threshold field unset until Task 5's deterministic calibration command writes it; the asset validator may accept `null` only before Task 5 and must reject it in `--release` mode.

Use this little-endian portable CRF binary format so the 5 MiB package budget is not consumed by JSON string/number expansion:

```text
4 bytes   magic ASCII "VCRF"
u16       format version = 1
u16       label count = 30
u32       attribute count
u32       state-feature count
u32       transition-feature count
repeat attribute count:
  u32     UTF-8 byte length
  bytes   UTF-8 attribute
repeat state-feature count (16 bytes each):
  u32     attribute index
  u8      label index
  3 bytes zero padding
  f64     weight
repeat transition-feature count (12 bytes each):
  u8      from-label index
  u8      to-label index
  u16     zero padding
  f64     weight
```

Labels stay in ordered `model-manifest.json`. Sort the attribute table lexicographically, state records by `(attributeIndex, labelIndex)`, and transitions by `(fromLabelIndex, toLabelIndex)` before writing. Preserve weights as Float64 and reject a generated file that does not decode back to the exact exported values.

Run the pinned sync from a repository-local virtual environment:

```bash
python3 -m venv .tmp/vietnamese-normalizer-assets/venv
.tmp/vietnamese-normalizer-assets/venv/bin/pip install 'huggingface-hub>=0.33,<1' 'soe-vinorm==0.3.2'
.tmp/vietnamese-normalizer-assets/venv/bin/python scripts/sync-vietnamese-normalizer-assets.py \
  --output public/assets/vietnamese-normalizer
```

Expected: five bundled data/model assets plus `model-manifest.json`; no `.pkl`, Python package, cache file, or virtual environment below `public/`.

- [ ] **Step 5: Perform and record the license gate**

Inspect the pinned Git `LICENSE`, the Hugging Face repository metadata/files, and every derived asset. Add an MIT section to `public/THIRD_PARTY_NOTICES.txt` containing project/model URLs, source version, full source commit, full model revision, copyright owner, and which files are derived.

Run:

```bash
node scripts/validate-vietnamese-normalizer-assets.mjs public/assets/vietnamese-normalizer
```

Expected: PASS with total bytes at or below `5_242_880`. If any asset has no explicit redistribution permission, stop the task and do not include that asset.

- [ ] **Step 6: Add stable package commands and run GREEN**

Add:

```json
"validate:vi-assets": "node scripts/validate-vietnamese-normalizer-assets.mjs public/assets/vietnamese-normalizer",
"validate:vi-assets:release": "node scripts/validate-vietnamese-normalizer-assets.mjs public/assets/vietnamese-normalizer --release --dist dist --check-wasm"
```

Run:

```bash
pnpm validate:vi-assets
node --experimental-strip-types --test tests/unit/vietnamese_assets.test.ts
```

Expected: validator PASS; both negative tests PASS by observing their expected rejection.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

Future commit scope:

```bash
git add scripts/sync-vietnamese-normalizer-assets.py scripts/validate-vietnamese-normalizer-assets.mjs \
  tests/unit/vietnamese_assets.test.ts public/assets/vietnamese-normalizer \
  public/THIRD_PARTY_NOTICES.txt package.json
git commit -m "Bundle Vietnamese normalizer assets"
```

Do not run these commands until anh guộc explicitly authorizes commits.

---

### Task 2: Reversible Vietnamese tokenizer and protected structured spans

**Files:**
- Create: `src/offscreen/vietnamese/types.ts`
- Create: `src/offscreen/vietnamese/tokenizer.ts`
- Create: `tests/unit/vietnamese_tokenizer.test.ts`

**Interfaces:**
- Produces `tokenizeVietnameseText(input: string): TokenizedDocument`.
- Produces `restoreSource(tokens: readonly SourceToken[], trailing?: string): string`.
- Produces `SourceToken` with exact normalized-source offsets for Tasks 3-6.
- Produces paragraph boundaries as document structure, never as a lexical CRF token.

- [ ] **Step 1: Define the shared contracts**

Create `src/offscreen/vietnamese/types.ts` with these public types:

```ts
export const NSW_TYPES = [
	'LABB', 'LSEQ', 'LWRD', 'MEA', 'MONEY', 'NDAT', 'NDAY', 'NDIG', 'NFRC',
	'NMON', 'NNUM', 'NPER', 'NQUA', 'NRNG', 'NSCR', 'NTIM', 'NVER', 'ROMA', 'URLE',
] as const;

export type NswType = (typeof NSW_TYPES)[number];
export type BioLabel = `B-${NswType}` | `I-${NswType}` | 'O';
export type TokenKind = 'word' | 'structured' | 'punctuation';

export interface SourceToken {
	text: string;
	original: string;
	leading: string;
	start: number;
	end: number;
	kind: TokenKind;
}

export interface TokenizedParagraph {
	source: string;
	start: number;
	end: number;
	tokens: SourceToken[];
	trailing: string;
}

export interface TokenizedDocument {
	normalizedSource: string;
	paragraphs: TokenizedParagraph[];
}

export interface DetectedSpan {
	type: NswType;
	startToken: number;
	endToken: number;
}

export interface SpeechUnit {
	text: string;
	pauseAfterMs: number;
}
```

- [ ] **Step 2: Write failing tokenizer tests**

The tests must assert exact text, kind, and source restoration for:

```ts
test('protects structured Vietnamese tokens before punctuation separation', () => {
	const document = tokenizeVietnameseText(
		'Ngày 11/07/2026, đạt 12,5% tại https://example.vn/a-b. Email a@b.vn; bản v1.2.3.',
	);
	const tokens = document.paragraphs[0].tokens;
	assert.deepEqual(
		tokens.filter((token) => token.kind === 'structured').map((token) => token.text),
		['11/07/2026', '12,5%', 'https://example.vn/a-b', 'a@b.vn', 'v1.2.3'],
	);
	assert.equal(restoreSource(tokens), document.paragraphs[0].source);
});

test('preserves paragraph boundaries and distinguishes spaced dash from a range', () => {
	const document = tokenizeVietnameseText('Khoảng 10-12 km - thử nghiệm.\n\nĐoạn hai.');
	assert.equal(document.paragraphs.length, 2);
	assert.equal(document.paragraphs[0].tokens.find((token) => token.text === '10-12')?.kind, 'structured');
	assert.equal(document.paragraphs[0].tokens.find((token) => token.text === '-')?.kind, 'punctuation');
});

test('normalizes to NFC without removing Vietnamese diacritics', () => {
	const document = tokenizeVietnameseText('Tha\u0300nh pho\u0302\u0301 Ho\u0302\u0300 Chi\u0301 Minh');
	assert.equal(document.normalizedSource, 'Thành phố Hồ Chí Minh');
});
```

- [ ] **Step 3: Run the tokenizer test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_tokenizer.test.ts
```

Expected: FAIL because `tokenizer.ts` does not exist.

- [ ] **Step 4: Implement ordered protection and reversible scanning**

Use one left-to-right scanner. At each source index, match the following ordered anchored patterns before ordinary word/punctuation scanning: URL, email, version, full date, short date, time/range, currency, measurement, percentage, grouped/decimal number, numeric range/score, then identifier. Longest valid match wins within the same priority.

Required implementation invariants:

```ts
const PARAGRAPH_BREAK = /\n[\t ]*\n+/y;
const WHITESPACE = /[\t \r\n]+/y;
const PUNCTUATION = /[….,!?;:()[\]{}"'“”‘’]|(?:[-–—](?=\s|$))/uy;

export function restoreSource(tokens: readonly SourceToken[], trailing = ''): string {
	return tokens.map(({ leading, original }) => leading + original).join('') + trailing;
}
```

The first token's `leading` is the paragraph's leading whitespace; trailing whitespace remains on `TokenizedParagraph.trailing` so `restoreSource(paragraph.tokens, paragraph.trailing)` restores the whole normalized paragraph exactly. Do not use global mutable source state.

Reject no input. Empty and whitespace-only input returns zero paragraphs. Normalize with `input.normalize('NFC')`, collapse horizontal whitespace to one space, and canonicalize paragraph separators to exactly `\n\n` while retaining offsets against that normalized source.

- [ ] **Step 5: Run focused and full unit suites**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_tokenizer.test.ts
pnpm test:unit
```

Expected: tokenizer tests PASS; existing unit suite remains GREEN.

- [ ] **Step 6: Commit checkpoint only after explicit authorization**

```bash
git add src/offscreen/vietnamese/types.ts src/offscreen/vietnamese/tokenizer.ts \
  tests/unit/vietnamese_tokenizer.test.ts
git commit -m "Add reversible Vietnamese tokenization"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 3: Reference-compatible CRF features and typed-array Viterbi

**Files:**
- Create: `src/offscreen/vietnamese/features.ts`
- Create: `src/offscreen/vietnamese/crf.ts`
- Create: `tests/unit/vietnamese_features.test.ts`
- Create: `tests/unit/vietnamese_crf.test.ts`

**Interfaces:**
- Consumes `SourceToken`, `BioLabel`, `CheckpointLabel`, `DetectedSpan`, `NswType`, ordered manifest labels, and Task 1's portable CRF binary.
- Produces `extractCrfFeatures(tokens, index, dictionaries): CrfFeatureMap`.
- Produces `encodeCrfsuiteAttributes(features): readonly [string, number][]`.
- Produces `decodePortableCrfModel(buffer, labels): PortableCrfModel`.
- Produces `createCrfDetector(model): CrfDetector` where `detect(tokens): CheckpointLabel[]`.
- Produces `reconstructDetectedSpans(labels): DetectedSpan[]` with invalid `I-*` repaired to a new `B-*` span and unsupported `B-USS` restored from the original source span.

Use these exact supporting interfaces:

```ts
export type CrfFeatureValue = string | boolean | number;
export type CrfFeatureMap = Record<string, CrfFeatureValue>;
export type CheckpointLabel = BioLabel | 'B-USS';

export interface FeatureDictionaries {
	vietnameseSyllables: ReadonlySet<string>;
	abbreviations: ReadonlySet<string>;
	moneyUnits: ReadonlySet<string>;
	measurementUnits: ReadonlySet<string>;
}

export interface CrfDetector {
	detect(tokens: readonly SourceToken[]): BioLabel[];
}
```

- [ ] **Step 1: Write exact reference-feature tests**

Cover the reference implementation's basic, context, morphology, shape, dictionary, special-character, and date/time flags. One fixture must assert all values for token `11/07/2026`; another must assert previous/next two-token context around `ĐH`.

```ts
assert.deepEqual(extractCrfFeatures(tokens, 1, dictionaries), {
	wi: 'ĐH',
	is_first_capital: true,
	is_first_word: false,
	is_last_word: false,
	is_complete_capital: true,
	is_alphanumeric: false,
	is_numeric: false,
	prev_word: 'Trường',
	next_word: 'tuyển',
	prev_word_2: '',
	next_word_2: 'sinh',
	prefix_1: 'Đ', prefix_2: 'ĐH', prefix_3: 'ĐH', prefix_4: 'ĐH',
	suffix_1: 'H', suffix_2: 'ĐH', suffix_3: 'ĐH', suffix_4: 'ĐH',
	ws: 'XX', short_ws: 'X',
	in_vn_dict: 0, in_abbr_dict: 1, in_money_dict: 0, in_measurement_dict: 0,
	word_has_hyphen: false, word_has_tilde: false, word_has_at: false,
	word_has_comma: false, word_has_colon: false, word_has_dot: false,
	word_has_ws_xxslashxxxx: false, word_has_romanslashxxxx: false,
	word_has_num_dash_colon_num: false, word_contain_only_roman: false,
	word_has_time_shape: false, word_has_day_shape: false,
	word_has_date_shape: false, word_has_month_shape: false,
});
```

- [ ] **Step 2: Write a toy-model Viterbi and BIO reconstruction test**

Use a three-label model (`B-NDAY`, `I-NDAY`, `O`) whose emissions prefer a two-token date span but whose transition weight changes the locally greedy answer. Encode it in the Task 1 binary format, decode it, and assert the globally optimal labels, exact Float64 weights, finite score rejection, deterministic tie-breaking by lower label index, rejection of bad magic/truncation/non-zero padding, and repair of `['I-NDAY', 'O']` to one `NDAY` span.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --experimental-strip-types --test \
  tests/unit/vietnamese_features.test.ts tests/unit/vietnamese_crf.test.ts
```

Expected: FAIL with missing modules.

- [ ] **Step 4: Port the feature extractor exactly**

Match `soe_vinorm/nsw_detector.py` v0.3.2 feature names and semantics. For CRFsuite conversion:

- string value `v` becomes attribute `name:v` with numeric value `1`;
- boolean `true` becomes attribute `name` with value `1`; boolean `false` is omitted;
- finite numeric values retain attribute `name` and their numeric value;
- empty strings still become `name:` because the reference emits them;
- non-finite values throw during model preparation and trigger Task 6 fail-open.

Do not add features absent from the pinned model.

- [ ] **Step 5: Implement portable-model validation and Viterbi**

Define:

```ts
export interface PortableCrfModel {
	formatVersion: 1;
	labels: BioLabel[];
	stateFeatures: Array<[attribute: string, labelIndex: number, weight: number]>;
	transitionFeatures: Array<[fromLabelIndex: number, toLabelIndex: number, weight: number]>;
}
```

Build a sparse attribute-to-`[labelIndex, weight]` map once. For each token, fill a dense `Float64Array(tokenCount * labelCount)` emission matrix. Decode with two rolling `Float64Array(labelCount)` score rows and an `Int16Array(tokenCount * labelCount)` backpointer matrix. Missing state/transition weights are zero. Reject duplicate labels, out-of-range indices, empty label sets, and non-finite weights.

The decoder must never allocate inside the inner `(token, previousLabel, nextLabel)` loop.

- [ ] **Step 6: Verify against exported reference goldens**

Add at least ten token sequences with labels generated by the pinned Python oracle to `tests/fixtures/vietnamese-normalizer/reference-goldens.json`. Assert byte-for-byte label equality in `vietnamese_crf.test.ts`.

Run:

```bash
node --experimental-strip-types --test \
  tests/unit/vietnamese_features.test.ts tests/unit/vietnamese_crf.test.ts
```

Expected: all focused tests PASS, including reference labels.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

```bash
git add src/offscreen/vietnamese/features.ts src/offscreen/vietnamese/crf.ts \
  tests/unit/vietnamese_features.test.ts tests/unit/vietnamese_crf.test.ts \
  tests/fixtures/vietnamese-normalizer/reference-goldens.json
git commit -m "Port Vietnamese CRF detection"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 4: Deterministic Vietnamese typed expanders

**Files:**
- Create: `src/offscreen/vietnamese/number_words.ts`
- Create: `src/offscreen/vietnamese/expanders.ts`
- Create: `tests/unit/vietnamese_expanders.test.ts`
- Modify: `tests/fixtures/vietnamese-normalizer/reference-goldens.json`
- Create: `tests/fixtures/vietnamese-normalizer/must-not-change.json`

**Interfaces:**
- Produces `expandInteger(value: string): string | null` and `expandDecimal(value: string): string | null`.
- Produces `recognizeDeterministicType(source: string): NswType | null` for high-confidence fallback.
- Produces `expandTypedSpan(type: Exclude<NswType, 'LABB'>, source: string, context?: ExpansionContext): string | null`.
- Returning `null` always means “restore the exact original span”; it never means empty speech.

```ts
export interface ExpansionContext {
	previousText?: string;
	nextText?: string;
}
```

- [ ] **Step 1: Write the required user-facing expansion table as failing tests**

Assert these exact results:

```ts
const cases: Array<[NswType, string, string]> = [
	['NDAY', '11/07', 'mười một tháng bảy'],
	['NDAT', '11/07/2026', 'ngày mười một tháng bảy năm hai nghìn không trăm hai mươi sáu'],
	['NNUM', '7,9', 'bảy phẩy chín'],
	['NNUM', '178.000', 'một trăm bảy mươi tám nghìn'],
	['MEA', '42 km', 'bốn mươi hai ki lô mét'],
	['NPER', '12,5%', 'mười hai phẩy năm phần trăm'],
	['NRNG', '10-12', 'mười đến mười hai'],
	['MONEY', '700.000đ', 'bảy trăm nghìn đồng'],
	['NVER', 'v1.2.3', 'vê một chấm hai chấm ba'],
];
for (const [type, input, expected] of cases) {
	assert.equal(expandTypedSpan(type, input), expected);
}
```

Also assert leap date `29/02/2024` expands, `29/02/2023` and `31/04/2026` return `null`, URL/email text is not interpreted as a date/decimal, and a phone-like `0901234567` remains unchanged unless the CRF explicitly labels it `LSEQ` or `NDIG`.

- [ ] **Step 2: Add one golden case for every non-abbreviation NSW type**

The fixture must cover `LSEQ`, `LWRD`, `MEA`, `MONEY`, `NDAT`, `NDAY`, `NDIG`, `NFRC`, `NMON`, `NNUM`, `NPER`, `NQUA`, `NRNG`, `NSCR`, `NTIM`, `NVER`, `ROMA`, and `URLE`. Each entry contains `type`, `input`, `expected`, and the pinned oracle version; exact outputs are reviewed before merging.

The must-not-change fixture must include at least:

```json
[
  "https://example.vn/11/07?id=v1.2.3",
  "dev-team@example.vn",
  "29/02/2023",
  "31/04/2026",
  "AB-123-CD",
  "0901234567",
  "IPv4 192.168.1.1",
  "mã 11/99/2026"
]
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts
```

Expected: FAIL because the expander modules do not exist.

- [ ] **Step 4: Implement Vietnamese number words without floating-point parsing**

Parse strings, not JavaScript `Number`, so grouped values and long digit sequences are not rounded. Support a leading minus, groups through `tỷ tỷ`, comma decimals, and Vietnamese contextual forms `mốt`, `tư`, and `lăm`. Reject malformed grouping instead of guessing.

Use calendar validation through an explicit Gregorian day table plus leap-year calculation; do not rely on locale-dependent `Date` parsing.

- [ ] **Step 5: Implement typed dispatch with strict recognizers**

`expandTypedSpan()` must have an exhaustive `switch` over all non-`LABB` types. Each branch validates the whole trimmed span before expanding. Preserve punctuation outside the span in Task 6 rather than swallowing it here.

Deterministic fallback recognition may classify only exact high-confidence shapes: valid dates/times, percentages, explicit currency, known measurement units, unambiguous numeric ranges/scores, versions prefixed with `v`, valid Roman numerals, URLs/emails, and pure numeric values up to the reviewed limit. It must not classify arbitrary alphanumeric identifiers or phone-like digit runs.

- [ ] **Step 6: Run goldens, preservation cases, and full unit suite**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_expanders.test.ts
pnpm test:unit
```

Expected: every required example and all 18 non-abbreviation type goldens PASS; all must-not-change inputs are returned unchanged by deterministic recognition.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

```bash
git add src/offscreen/vietnamese/number_words.ts src/offscreen/vietnamese/expanders.ts \
  tests/unit/vietnamese_expanders.test.ts tests/fixtures/vietnamese-normalizer/reference-goldens.json \
  tests/fixtures/vietnamese-normalizer/must-not-change.json
git commit -m "Add Vietnamese typed expansion rules"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 5: Constrained abbreviation expansion and ONNX scoring

**Files:**
- Create: `src/offscreen/vietnamese/abbreviations.ts`
- Create: `src/offscreen/vietnamese/abbreviation_scorer.ts`
- Create: `tests/unit/vietnamese_abbreviations.test.ts`
- Modify: `public/assets/vietnamese-normalizer/model-manifest.json`
- Modify: `tests/fixtures/vietnamese-normalizer/reference-goldens.json`

**Interfaces:**
- Produces `parseAbbreviationDictionary(text): ReadonlyMap<string, readonly string[]>`.
- Produces `expandAbbreviation(request): Promise<string | null>`.
- Produces `OnnxAbbreviationScorer.create(modelSource, config): Promise<AbbreviationScorer>`, where `modelSource` is an extension-local URL or `Uint8Array` read by the Node evaluator.
- `AbbreviationScorer.score(candidates, leftContext, rightContext): Promise<readonly number[]>` returns one finite logit per supplied dictionary candidate and cannot generate text.

Use this request contract:

```ts
export interface AbbreviationExpansionRequest {
	source: string;
	leftContext: string;
	rightContext: string;
	dictionary: ReadonlyMap<string, readonly string[]>;
	scorer: AbbreviationScorer | null;
	confidenceThreshold: number;
	confidenceMargin: number;
}
```

- [ ] **Step 1: Write precedence and failure tests with a fake scorer**

Cover:

1. `ĐH` with one dictionary value returns `đại học` without calling the scorer;
2. dotted `TP.HCM` is cleaned only for dictionary lookup and returns `Thành phố Hồ Chí Minh`;
3. an ambiguous entry selects only a dictionary candidate when softmax confidence and margin pass;
4. low confidence, wrong score count, `NaN`, exception, and a result outside the candidate set return the safe letter sequence or original;
5. unknown recognized uppercase `KPI` uses the vetted Vietnamese letter map;
6. mixed-case normal word `Covid` and arbitrary identifier `AB-123-CD` return `null`.

Use this exact scorer interface in the tests:

```ts
export interface AbbreviationScorer {
	score(
		candidates: readonly string[],
		leftContext: string,
		rightContext: string,
	): Promise<readonly number[]>;
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_abbreviations.test.ts
```

Expected: FAIL because abbreviation modules do not exist.

- [ ] **Step 3: Implement deterministic precedence and safe spelling**

Dictionary parsing trims keys/candidates, preserves candidate order, merges duplicate keys, removes duplicate candidates, and rejects malformed empty records. Lookup order is exact token, punctuation-cleaned token, then joined dotted/hyphen parts.

Safe spelling is allowed only for a reviewed uppercase sequence of 2-8 Vietnamese/Latin letters with optional internal dots; digits, lowercase mixtures, slashes, and hyphenated identifiers are excluded. Use the pinned reference letter mapping and join letter names with spaces.

- [ ] **Step 4: Implement the ONNX Runtime adapter**

Load the bundled model with:

```ts
const session = await ort.InferenceSession.create(modelSource, {
	executionProviders: ['wasm'],
	graphOptimizationLevel: 'all',
});
```

Build one lowercased context example per candidate using the pinned `window_size`, `vocab`, and `seq_len`. Pad/truncate deterministically, create `BigInt64Array` input and `ort.Tensor('int64', data, [candidateCount, seqLen])`, then return the first output as finite JavaScript numbers. Never fetch a model URL outside `chrome.runtime.getURL('assets/vietnamese-normalizer/...')`.

- [ ] **Step 5: Calibrate and pin the confidence threshold deterministically**

Add at least 20 reviewed ambiguous abbreviation contexts to the golden fixture. Run candidate thresholds from `0.50` through `0.95` in `0.01` increments and margins from `0.05` through `0.30` in `0.01` increments. Select the pair with zero wrong accepted expansions, then highest correct coverage, then highest threshold, then highest margin as deterministic tie-breakers. Store both exact values in `model-manifest.json`.

The release validator must now reject `null`, out-of-range, or non-finite threshold/margin fields.

- [ ] **Step 6: Run focused tests and asset release validation**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_abbreviations.test.ts
node scripts/validate-vietnamese-normalizer-assets.mjs public/assets/vietnamese-normalizer --release
```

Expected: all precedence/failure cases PASS; release validation confirms pinned non-null calibration.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

```bash
git add src/offscreen/vietnamese/abbreviations.ts src/offscreen/vietnamese/abbreviation_scorer.ts \
  tests/unit/vietnamese_abbreviations.test.ts public/assets/vietnamese-normalizer/model-manifest.json \
  tests/fixtures/vietnamese-normalizer/reference-goldens.json
git commit -m "Add constrained Vietnamese abbreviation scoring"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 6: Local asset loading and fail-open normalization orchestration

**Files:**
- Create: `src/offscreen/vietnamese/assets.ts`
- Create: `src/offscreen/vietnamese/normalizer.ts`
- Create: `tests/unit/vietnamese_normalizer.test.ts`
- Create: `tests/fixtures/vietnamese-normalizer/evaluation-corpus.json`
- Create: `scripts/evaluate-vietnamese-normalizer.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes Tasks 1-5 modules/assets.
- Produces `loadVietnameseNormalizerAssets(): Promise<VietnameseNormalizerAssets>` with single-flight caching.
- Produces `normalizeVietnameseText(text, dependencies): Promise<NormalizationResult>`.
- `NormalizationResult` contains normalized text plus in-memory timings/counters only; it contains no storage or network operation.
- Produces CLI evaluation exit code `0` only when all specification thresholds pass.

- [ ] **Step 1: Define normalization contracts and failing integration tests**

Add to `types.ts`:

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

export interface VietnameseNormalizerAssets {
	detector: CrfDetector | null;
	vietnameseSyllables: ReadonlySet<string>;
	abbreviations: ReadonlyMap<string, readonly string[]>;
	abbreviationScorer: AbbreviationScorer | null;
	confidenceThreshold: number;
	confidenceMargin: number;
}

export interface NormalizationDependencies {
	assets: VietnameseNormalizerAssets;
	now: () => number;
}
```

Tests must cover exact required examples in sentences, preservation of punctuation/paragraphs, normalization idempotence, CRF missing/malformed, scorer missing/throwing, malformed label sequences, expansion exceptions, empty expansion, no lost adjacent source text, and no fetch/storage call involving article text.

```ts
function createTestNormalizationDependencies(): NormalizationDependencies {
	let clock = 0;
	return {
		assets: {
			detector: {
				detect: (tokens) => tokens.map((token) => token.text === 'ĐH' ? 'B-LABB' : 'O'),
			},
			vietnameseSyllables: new Set(['mở', 'đăng', 'ký', 'ngày', 'học', 'phí', 'tỷ', 'lệ', 'đạt']),
			abbreviations: new Map([['ĐH', ['đại học']]]),
			abbreviationScorer: null,
			confidenceThreshold: 0.5,
			confidenceMargin: 0.05,
		},
		now: () => ++clock,
	};
}

test('normalizes required Vietnamese cases and is idempotent', async () => {
	const source = 'ĐH mở đăng ký ngày 11/07/2026, học phí 700.000đ.\n\nTỷ lệ đạt 12,5%.';
	const testDependencies = createTestNormalizationDependencies();
	const first = await normalizeVietnameseText(source, testDependencies);
	const second = await normalizeVietnameseText(first.text, testDependencies);
	assert.equal(first.text, 'đại học mở đăng ký ngày mười một tháng bảy năm hai nghìn không trăm hai mươi sáu, học phí bảy trăm nghìn đồng.\n\nTỷ lệ đạt mười hai phẩy năm phần trăm.');
	assert.equal(second.text, first.text);
});
```

The typed date expander must avoid duplicate lexical `ngày`: if the source token is immediately preceded by lexical `ngày`, expand the full date without its own leading `ngày`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_normalizer.test.ts
```

Expected: FAIL because asset/orchestration modules do not exist.

- [ ] **Step 3: Implement local single-flight asset loading**

All URLs use `chrome.runtime.getURL('assets/vietnamese-normalizer/<file>')`. Load text/JSON/binary/ONNX from the extension package, not `fetchWithCache()` and not Hugging Face. Validate format version, labels, finite weights, binary bounds/padding, checksums, and calibration before constructing runtime objects.

Return a usable fallback dependency set when CRF or scorer construction fails:

- dictionary and deterministic expanders remain available if their files validate;
- a missing CRF yields `detector: null`;
- a missing scorer yields `abbreviationScorer: null`;
- a manifest/dictionary failure yields the minimal deterministic recognizer set;
- no asset error is sent to a backend or persisted.

- [ ] **Step 4: Implement paragraph/span orchestration**

For each paragraph:

1. tokenize with source spans;
2. get CRF labels when available, else an all-`O` label array;
3. overlay only high-confidence deterministic labels on exact protected shapes;
4. reconstruct BIO spans;
5. expand each span exactly once, passing left/right context only to abbreviation scoring;
6. on any invalid output, restore every original token/gap in the span;
7. preserve untouched token spelling and punctuation;
8. join paragraphs with exactly `\n\n`;
9. if the final output is empty while input was non-empty, return the entire original input.

Do not call the whole normalizer recursively for the idempotence check. Idempotence is enforced by rules producing ordinary Vietnamese words and tested by a second public invocation.

- [ ] **Step 5: Add and validate the reviewed corpus**

Create `evaluation-corpus.json` with this schema:

```ts
interface EvaluationDocument {
	id: string;
	domain: 'general' | 'business' | 'technology' | 'health' | 'science' | 'sports';
	text: string;
	spans: Array<{ start: number; end: number; type: NswType; expected: string }>;
}
```

Include at least five excerpts per domain, at least 200 manually reviewed spans total, at least 20 abbreviation contexts, and at least 20 date/time/number cases. Keep excerpts short and record source/license metadata outside the spoken text when external material is used.

`scripts/evaluate-vietnamese-normalizer.ts` must calculate exact span micro precision/recall/F1, compare every deterministic golden, compare every must-not-change input, and reject an empty/lost source span. Add:

The evaluator reads manifest/dictionaries/binary CRF/scorer bytes directly from `public/assets/vietnamese-normalizer/` with Node `fs`, constructs the same pure detector/expander/scorer objects, and passes them to `normalizeVietnameseText()`. It must not import browser-only `assets.ts`, require `chrome`, download a model, or invoke Python.

```json
"evaluate:vi": "node --experimental-strip-types scripts/evaluate-vietnamese-normalizer.ts"
```

- [ ] **Step 6: Run quality gates**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_normalizer.test.ts
pnpm evaluate:vi
```

Expected:

- micro F1 at least `0.90`;
- deterministic golden equality `100%`;
- must-not-change preservation `100%`;
- zero empty non-empty documents and zero lost source spans.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

```bash
git add src/offscreen/vietnamese/assets.ts src/offscreen/vietnamese/normalizer.ts \
  src/offscreen/vietnamese/types.ts tests/unit/vietnamese_normalizer.test.ts \
  tests/fixtures/vietnamese-normalizer/evaluation-corpus.json \
  scripts/evaluate-vietnamese-normalizer.ts package.json
git commit -m "Assemble Vietnamese normalization pipeline"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 7: Punctuation-aware speech units and exact audio silence

**Files:**
- Create: `src/offscreen/vietnamese/speech_units.ts`
- Create: `src/offscreen/audio.ts`
- Create: `tests/unit/vietnamese_speech_units.test.ts`
- Create: `tests/unit/offscreen_audio.test.ts`

**Interfaces:**
- Consumes normalized text with blank-line paragraph separators.
- Produces `planSpeechUnits(text: string): SpeechUnit[]`.
- Produces `appendSilenceSamples(wav, sampleRate, pauseAfterMs): Float32Array`.
- Guarantees non-empty unit text, preferred length 200, hard maximum 300, and exact centralized pause values.

- [ ] **Step 1: Write pause-precedence and segmentation tests**

Tests must assert:

```ts
assert.deepEqual(planSpeechUnits(
	'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.\n\nĐoạn cuối cùng đủ dài!',
), [
	{ text: 'Mệnh đề thứ nhất đủ dài,', pauseAfterMs: 60 },
	{ text: 'mệnh đề thứ hai cũng đủ dài;', pauseAfterMs: 90 },
	{ text: 'mệnh đề thứ ba vẫn đủ dài —', pauseAfterMs: 105 },
	{ text: 'mệnh đề thứ tư kết thúc.', pauseAfterMs: 260 },
	{ text: 'Đoạn cuối cùng đủ dài!', pauseAfterMs: 165 },
]);

assert.deepEqual(planSpeechUnits('Một, hai; rồi ba.'), [
	{ text: 'Một, hai; rồi ba.', pauseAfterMs: 165 },
]);
```

Also assert:

- `10-12`, `11-07-2026`, `https://a-b.vn`, and `AB-123` do not create dash units;
- sentence end plus paragraph end yields only `260 ms`;
- clauses under 20 characters remain joined when a split would create a short fragment;
- every returned unit is at most 300 characters;
- a long sentence chooses the nearest whitespace to 200, falling back before 300;
- empty/whitespace input yields `[]`.

- [ ] **Step 2: Write exact sample-count tests**

```ts
test('appends the requested silence without changing waveform samples', () => {
	const output = appendSilenceSamples(new Float32Array([0.25, -0.5]), 1_000, 80);
	assert.equal(output.length, 82);
	assert.deepEqual(Array.from(output.slice(0, 2)), [0.25, -0.5]);
	assert.ok(output.slice(2).every((sample) => sample === 0));
});
```

Reject non-positive/non-finite sample rates and negative/non-finite pauses. `0 ms` returns a copy, not the caller's mutable buffer.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --experimental-strip-types --test \
  tests/unit/vietnamese_speech_units.test.ts tests/unit/offscreen_audio.test.ts
```

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement centralized boundary scanning**

Export immutable constants:

```ts
export const VI_PAUSE_MS = Object.freeze({
	comma: 60,
	colonOrSemicolon: 90,
	spacedDash: 105,
	sentenceEnd: 165,
	paragraphEnd: 260,
});
export const VI_PREFERRED_UNIT_LENGTH = 200;
export const VI_MAX_UNIT_LENGTH = 300;
export const VI_MIN_FRAGMENT_LENGTH = 20;
```

Scan protected structured forms before boundary punctuation. Keep punctuation in unit text. When multiple boundaries terminate the same unit, take `Math.max`; never sum. Paragraph boundaries are structure, not literal text in a unit.

- [ ] **Step 5: Implement silence as a waveform append**

Calculate `silenceSamples = Math.round(sampleRate * pauseAfterMs / 1000)`, allocate one `Float32Array`, copy the waveform once, and rely on zero initialization for silence. Do not build a JavaScript `number[]` of zeros.

- [ ] **Step 6: Run focused and full unit tests**

Run the Step 3 command, then `pnpm test:unit`.

Expected: all new and existing unit tests PASS.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

```bash
git add src/offscreen/vietnamese/speech_units.ts src/offscreen/audio.ts \
  tests/unit/vietnamese_speech_units.test.ts tests/unit/offscreen_audio.test.ts
git commit -m "Plan Vietnamese speech pauses"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 8: Offscreen playback integration and fail-open behavior

**Files:**
- Create: `src/offscreen/playback_preparation.ts`
- Create: `tests/unit/playback_preparation.test.ts`
- Modify: `src/offscreen/offscreen.ts`

**Interfaces:**
- Consumes `normalizeVietnameseText()`, `planSpeechUnits()`, existing `chunkText()`, and `appendSilenceSamples()`.
- Produces `preparePlaybackUnits(text, lang, normalizer): Promise<SpeechUnit[]>`.
- Changes offscreen queue from `string[]` to `SpeechUnit[]` without changing background/popup messages.
- Keeps one upcoming synthesized `AudioBuffer` and the existing session/speed invalidation semantics.

- [ ] **Step 1: Write pure preparation tests**

Assert:

- `vi` invokes the normalizer once and speech-unit planner once;
- `vi-VN` is not accepted silently here; callers must pass resolved `vi` and other values use the compatibility path;
- normalizer rejection/throw returns units made from the exact original text;
- `en`, `na`, and other supported languages never invoke Vietnamese assets and match `chunkText(text, 200).map(text => ({ text, pauseAfterMs: 0 }))`;
- selected text and full article content receive identical output for identical `text/lang` inputs;
- empty normalized units are dropped without dropping adjacent non-empty text.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/playback_preparation.test.ts
```

Expected: FAIL because `playback_preparation.ts` does not exist.

- [ ] **Step 3: Implement the pure preparation seam**

Use dependency injection so Node tests do not require `chrome`, ONNX, AudioContext, or network access:

```ts
export interface VietnameseTextNormalizer {
	normalize(text: string): Promise<NormalizationResult>;
}

export async function preparePlaybackUnits(
	text: string,
	lang: string,
	normalizer: VietnameseTextNormalizer | null,
): Promise<SpeechUnit[]>;
```

On Vietnamese failure, call `planSpeechUnits(originalText)`; if even that throws, return the existing `chunkText(originalText, 200)` compatibility units.

- [ ] **Step 4: Convert offscreen queue and synthesis to `SpeechUnit`**

In `offscreen.ts`:

- replace `textChunks: string[]` with `speechUnits: SpeechUnit[]` and update progress counts/indexes;
- load normalizer assets only for `article.lang === 'vi'`;
- prepare units before model/style synthesis so text failures do not become model-load failures;
- call `ttsEngine.call(unit.text, lang, style, 8, speed, 0)`;
- convert returned `wav` to `Float32Array`, append `unit.pauseAfterMs`, then call `writeWavFile()`;
- prefetch exactly `currentUnitIndex + 1` and retain session/speed guards;
- keep WebGPU then WASM initialization and `graphOptimizationLevel: 'all'` unchanged;
- keep user speed unchanged and do not inject expression tags.

The empty-input response remains `No readable text content found.`. Normalizer failure must not report playback `error` if the original text can still be synthesized.

- [ ] **Step 5: Verify parameter and cancellation behavior**

Add a source-level integration test seam around synthesis dependencies so the unit test asserts exact arguments `(lang: 'vi', steps: 8, speed: suppliedSpeed, silenceDuration: 0)` and one-unit prefetch. Add a regression that stopping or changing speed while normalization/prefetch is pending prevents the stale buffer from playing.

Run:

```bash
node --experimental-strip-types --test tests/unit/playback_preparation.test.ts
pnpm test:unit
pnpm build
```

Expected: tests PASS and strict TypeScript/production build PASS.

- [ ] **Step 6: Commit checkpoint only after explicit authorization**

```bash
git add src/offscreen/playback_preparation.ts src/offscreen/offscreen.ts \
  tests/unit/playback_preparation.test.ts
git commit -m "Integrate Vietnamese speech preparation"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 9: Browser integration, corpus, listening, and Chrome offscreen performance gates

**Files:**
- Create: `tests/e2e/vietnamese-pronunciation.spec.ts`
- Create: `tests/performance/vietnamese_offscreen_benchmark.html`
- Create: `tests/performance/vietnamese_offscreen_benchmark.ts`
- Create: `scripts/run-vietnamese-offscreen-benchmark.mjs`
- Create: `_docs/evaluations/vietnamese-pronunciation-listening.md`
- Modify: `rsbuild.config.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `pnpm test:e2e:vi` as deterministic browser integration coverage.
- Produces `pnpm benchmark:vi` report at `.tmp/vietnamese-performance/latest.json`.
- Produces a human listening result with at least 80% preference and zero semantic regressions in the must-not-change set.
- Produces the custom-WASM decision fields `required`, `budgetPassed`, `viterbiShare`, and `reason` without adding a WASM implementation.

- [ ] **Step 1: Add deterministic extension E2E coverage**

The E2E test must use routed local Vietnamese HTML and assert:

- full-page extraction keeps `lang: vi` and paragraph boundaries;
- selected-text and full-page starts both reach the offscreen `PLAY` path;
- start responds while TTS model loading is pending;
- stop/cancellation remains responsive while normalization/model work is pending;
- a missing/corrupt normalizer asset in a test build still starts original-text playback rather than surfacing a normalization error;
- no request sends article text to a remote normalizer, readit.dev backend, or telemetry endpoint;
- the actual ONNX Runtime request set is recorded for Task 10.

Do not require downloading Supertonic weights for the deterministic E2E path; abort/intercept model fetch after verifying preparation and cancellation behavior.

- [ ] **Step 2: Add a test-build-only offscreen benchmark entry**

When `READIT_VI_BENCHMARK=1`, `rsbuild.config.ts` must replace only the offscreen entry with `tests/performance/vietnamese_offscreen_benchmark.ts` and write the build below `.tmp/vietnamese-performance/extension/`. The default `pnpm build` entry/output must remain byte-for-byte configured as before except for Task 10's asset pruning.

The benchmark offscreen script imports the production tokenizer/features/CRF/expander/normalizer modules, loads bundled local assets, warms three times, runs 20 measured iterations, and exposes one resolved JSON result to the Playwright driver. Measure separately:

- tokenize/features;
- Viterbi;
- expansion;
- total normalization;
- 2,000-token representative article;
- 10,000-token stress article.

For the warm TTFA ratio, the driver also launches the normal production offscreen entry with a pre-warmed Supertonic cache, reads the `NormalizationDiagnostics.totalMs` performance measure and the coordinator's loading-to-playing duration, and reports `normalizationMs / warmTtfaMs`. Performance entries contain timing/counts only, never article or normalized text.

The Node driver launches a persistent profile below `.tmp/vietnamese-performance/profile/`, creates the offscreen document through the extension background path, attaches through CDP, collects the result, computes p50/p95, and writes only `.tmp/vietnamese-performance/latest.json`.

- [ ] **Step 3: Add exact package commands**

```json
"test:e2e:vi": "playwright test tests/e2e/vietnamese-pronunciation.spec.ts",
"benchmark:vi": "node scripts/run-vietnamese-offscreen-benchmark.mjs"
```

- [ ] **Step 4: Run deterministic gates**

Run:

```bash
pnpm build
pnpm test:unit
pnpm evaluate:vi
pnpm test:e2e:vi
```

Expected: build/tests PASS, F1 and preservation gates from Task 6 PASS, and no prohibited network request occurs.

- [ ] **Step 5: Run and classify actual Chrome performance**

Run on the declared reference Chrome/device:

```bash
pnpm benchmark:vi
```

Expected acceptance:

- 2,000-token normalization p95 `<= 50 ms`;
- 10,000-token normalization p95 `<= 150 ms`;
- warm normalization `< 5%` of time-to-first-audio when the model is available;
- no unbounded retained-memory growth across repeated sessions.

Set `customViterbiWasm.required` to `false` when both p95 budgets pass. If either misses, calculate Viterbi's share of total normalization. Only if it is greater than `0.50` may execution stop and request a separate Rust/WASM prototype plan. A custom WASM implementation is still forbidden unless its later prototype also proves at least 20% end-to-end improvement with byte-identical output.

- [ ] **Step 6: Complete the fixed listening evaluation**

Create at least 20 targeted A/B samples covering abbreviations, dates, numeric/domain values, comma/dash/sentence/paragraph pauses, repeated/skipped speech, and must-not-change inputs. Use the same voice, speed, and controlled random seed where supported. Randomize A/B order and hide path labels from reviewers.

Record sample ID, reviewer, preference, semantic error, pause issue, repeated/skipped speech, and TTFA concern. Acceptance is improved-path preference `>= 80%` and zero semantic regressions in must-not-change samples. If it fails, adjust only deterministic rules/pause constants backed by failed samples and rerun Tasks 4-9.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

```bash
git add tests/e2e/vietnamese-pronunciation.spec.ts tests/performance \
  scripts/run-vietnamese-offscreen-benchmark.mjs _docs/evaluations/vietnamese-pronunciation-listening.md \
  rsbuild.config.ts package.json
git commit -m "Verify Vietnamese pronunciation quality"
```

Do not add `.tmp` benchmark outputs and do not commit until anh guộc explicitly authorizes commits.

---

### Task 10: Selective ONNX Runtime WASM packaging and measured thread decision

**Files:**
- Modify: `rsbuild.config.ts`
- Modify: `public/manifest.json` only if required by verified packaging/thread results
- Modify: `src/offscreen/supertonic_helper.ts` only if the multithread gate passes
- Modify: `scripts/run-vietnamese-offscreen-benchmark.mjs`
- Modify: `scripts/validate-vietnamese-normalizer-assets.mjs`
- Modify: `tests/e2e/vietnamese-pronunciation.spec.ts`
- Modify: `tests/unit/vietnamese_assets.test.ts`

**Interfaces:**
- Produces a built extension containing only the verified ONNX Runtime Asyncify pair plus the hashed bundled WebGPU frontend requested by Rsbuild.
- Produces CPU-fallback benchmark rows for `numThreads = 1`, automatic selection, `2`, and `4`.
- Keeps production `ort.env.wasm.numThreads = 1` unless every multithread shipping condition passes and measured TTFA or real-time factor improves by at least 15%.

- [ ] **Step 1: Capture the actual ORT artifact requests before pruning**

Run the E2E test once against the current all-artifact build, forcing one WebGPU session and one WASM session. Record requested extension-local `.mjs`/`.wasm` basenames. The initial design expected JSEP, but the instrumented Chrome benchmark proved that the selected `onnxruntime-web@1.26.0/webgpu` frontend requests this union:

```text
ort-wasm-simd-threaded.asyncify.mjs
ort-wasm-simd-threaded.asyncify.wasm
static/assets/ort.webgpu.min.<content-hash>.mjs
```

If actual successful WebGPU/WASM paths request another runtime file, stop and reconcile that evidence before deleting files; do not guess based on filename alone.

- [ ] **Step 2: Make package-size tests fail before changing the build**

Extend the validator test to scan a fake build and reject `jspi`, JSEP, non-Asyncify base WASM, or any unlisted `.mjs`. Extend E2E to assert WebGPU and forced-WASM initialization request no file outside the verified union.

Run:

```bash
pnpm build
pnpm validate:vi-assets:release
```

Expected before pruning: FAIL because current `dist/` contains all four WASM variants and unrelated ORT `.mjs` files.

- [ ] **Step 3: Copy only the verified runtime pair**

Replace wildcard copy patterns in `rsbuild.config.ts` with exact source files:

```ts
{
	from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm',
	to: 'ort-wasm-simd-threaded.asyncify.wasm',
},
{
	from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs',
	to: 'ort-wasm-simd-threaded.asyncify.mjs',
},
```

Narrow `web_accessible_resources` to those exact basenames if ORT still requires them to be web-accessible; otherwise remove the broad `*.wasm`/`*.mjs` exposure after E2E proves extension-local loading works.

- [ ] **Step 4: Verify selective packaging before considering a custom ORT build**

Run:

```bash
pnpm build
pnpm validate:vi-assets:release
pnpm test:e2e:vi
```

Expected: WebGPU and forced WASM both initialize, the validator reports exactly one Asyncify WASM plus its loader MJS and the single hashed WebGPU frontend, and no JSEP, JSPI, or unqualified base variant exists in `dist/`.

Do not create a reduced-operator ONNX Runtime build in this plan. Selective packaging is the required first optimization.

- [ ] **Step 5: Benchmark existing ORT threading in isolated test builds**

Extend the benchmark driver to produce four builds under `.tmp/vietnamese-performance/threads/{one,auto,two,four}/`. For auto/2/4, patch only the copied test manifest with:

```json
"cross_origin_embedder_policy": { "value": "require-corp" },
"cross_origin_opener_policy": { "value": "same-origin" }
```

For each test build, the driver writes `.tmp/vietnamese-performance/threads/<variant>/benchmark-config.json` with `{ "numThreads": 1 }`, `{ "numThreads": "auto" }`, `{ "numThreads": 2 }`, or `{ "numThreads": 4 }`. The test-only offscreen entry loads `onnxruntime-web`, then dynamically imports `supertonic_helper.ts`, applies the requested setting before creating any inference session (`undefined` for `"auto"`, the exact integer otherwise), and forces `executionProviders: ['wasm']`. Production `supertonic_helper.ts` remains unchanged during measurement.

Run cold and warm CPU-fallback synthesis, verify `crossOriginIsolated === true`, successful local normalizer assets, successful cached Hugging Face Supertonic fetches, worker/CSP behavior, stop/cancellation, and repeated session lifecycle. Record TTFA and real-time factor for each thread setting.

- [ ] **Step 6: Apply the exact production decision gate**

Keep `ort.env.wasm.numThreads = 1` and leave production manifest isolation unchanged unless one tested setting:

- works with cross-origin isolation and all model/cache paths;
- has no WebGPU/WASM, CSP, worker, stop, cancellation, or lifecycle regression;
- improves median and p95 TTFA or synthesis real-time factor by at least `15%` versus one thread on representative CPU-fallback devices.

If a setting passes, choose the smallest passing thread count, add the two manifest isolation policies, set that exact count in `supertonic_helper.ts`, and rerun every command in Step 4 plus the full E2E suite. If none passes, commit only asset pruning and the benchmark evidence; production remains single-threaded.

- [ ] **Step 7: Commit checkpoint only after explicit authorization**

```bash
git add rsbuild.config.ts public/manifest.json src/offscreen/supertonic_helper.ts \
  scripts/run-vietnamese-offscreen-benchmark.mjs scripts/validate-vietnamese-normalizer-assets.mjs \
  tests/e2e/vietnamese-pronunciation.spec.ts tests/unit/vietnamese_assets.test.ts
git commit -m "Trim ONNX Runtime extension assets"
```

Stage `public/manifest.json` and `supertonic_helper.ts` only if their measured production decision changed. Do not commit until anh guộc explicitly authorizes commits.

---

### Task 11: Release pipeline, documentation, and final acceptance closure

**Files:**
- Modify: `.github/workflows/release-extension.yml`
- Modify: `_docs/RELEASING.md`
- Modify: `_docs/specs/2026-07-13-vietnamese-pronunciation-improvements.md`
- Test/verify: all files from Tasks 1-10

**Interfaces:**
- Consumes every automated report and the signed listening evaluation.
- Produces a release ZIP containing pinned normalizer assets, exact notices, and only verified ORT runtime artifacts.
- Changes spec status only after all required gates pass.

- [ ] **Step 1: Add release CI assertions after production build**

The workflow order must be:

1. `pnpm build`;
2. existing Free manifest validation;
3. `pnpm validate:vi-assets:release`;
4. `pnpm test:unit`;
5. `pnpm evaluate:vi`;
6. full E2E;
7. package ZIP;
8. assert the ZIP contains `assets/vietnamese-normalizer/model-manifest.json`, every manifest-listed asset, updated `THIRD_PARTY_NOTICES.txt`, and only the allowed ORT pair.

Do not run hardware/listening benchmarks in GitHub Actions. `_docs/RELEASING.md` must require a current local signed report before tagging.

- [ ] **Step 2: Document the release gate and rollback boundary**

Document exact commands, reference Chrome/device fields, where `.tmp/vietnamese-performance/latest.json` is generated, listening acceptance, asset/license review, package inspection, and rollback behavior. A pronunciation rollback removes the Vietnamese preparation call and assets while leaving the existing non-Vietnamese Supertonic path intact.

- [ ] **Step 3: Run complete automated verification from a clean build output**

Run:

```bash
pnpm build
pnpm validate:manifest
pnpm validate:vi-assets:release
pnpm test:unit
pnpm evaluate:vi
CI=true pnpm test:e2e
git diff --check
git status --short
```

Expected:

- all commands exit `0`;
- build contains all pinned normalizer assets and notice;
- only verified ORT WASM/MJS files exist;
- no prohibited host/API/runtime dependency was introduced;
- only task files plus pre-existing `context_improvement.md`/approved spec work remain changed.

- [ ] **Step 4: Confirm manual quality/performance evidence**

Run or inspect current results for:

- listening preference `>= 80%` with zero must-not-change semantic regression;
- Chrome p95 `<= 50 ms` at 2,000 tokens and `<= 150 ms` at 10,000 tokens;
- normalization `< 5%` of warm TTFA;
- memory stable across repeated sessions;
- thread decision follows the 15% gate;
- custom Viterbi WASM is absent unless a separately approved prototype plan passed all four gates.

Do not mark the feature complete while any of these fields is missing or failing.

- [ ] **Step 5: Mark the specification implemented**

Only after Steps 3-4 pass, change the spec status from `Approved design; implementation pending` to `Implemented and verified`, and add the verification date plus exact commands/report identifiers. Do not alter the approved product decisions.

- [ ] **Step 6: Final commit checkpoint only after explicit authorization**

```bash
git add .github/workflows/release-extension.yml _docs/RELEASING.md \
  _docs/specs/2026-07-13-vietnamese-pronunciation-improvements.md
git commit -m "Complete Vietnamese pronunciation improvements"
```

Do not run until anh guộc explicitly authorizes commits.

---

### Task 12: Reduce explicit Vietnamese pause durations

**Files:**
- Modify: `tests/unit/vietnamese_speech_units.test.ts`
- Modify: `tests/unit/playback_preparation.test.ts`
- Modify: `src/offscreen/vietnamese/speech_units.ts`
- Modify: `_docs/specs/2026-07-13-vietnamese-pronunciation-improvements.md`
- Modify: `_docs/plans/2026-07-13-vietnamese-pronunciation-improvements.md`

**Interfaces:**
- Consumes the existing `planSpeechUnits(text: string): SpeechUnit[]` boundary and strongest-pause precedence.
- Produces the same `SpeechUnit[]` structure with reduced explicit silence values only.
- Does not change segmentation, punctuation retention, Supertonic parameters, non-Vietnamese playback, or user settings.

- [x] **Step 1: Update exact pause expectations before production code**

Change the existing speech-unit assertions to require:

```ts
assert.deepEqual(
	planSpeechUnits(
		'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.\n\nĐoạn cuối cùng đủ dài!',
	),
	[
		{ text: 'Mệnh đề thứ nhất đủ dài,', pauseAfterMs: 60 },
		{ text: 'mệnh đề thứ hai cũng đủ dài;', pauseAfterMs: 90 },
		{ text: 'mệnh đề thứ ba vẫn đủ dài —', pauseAfterMs: 105 },
		{ text: 'mệnh đề thứ tư kết thúc.', pauseAfterMs: 260 },
		{ text: 'Đoạn cuối cùng đủ dài!', pauseAfterMs: 165 },
	],
);

assert.deepEqual(planSpeechUnits('Một, hai; rồi ba.'), [
	{ text: 'Một, hai; rồi ba.', pauseAfterMs: 165 },
]);

assert.deepEqual(planSpeechUnits('Câu đầu.\n\nCâu sau.'), [
	{ text: 'Câu đầu.', pauseAfterMs: 260 },
	{ text: 'Câu sau.', pauseAfterMs: 165 },
]);

assert.deepEqual(planSpeechUnits('Câu đầu… Câu sau.'), [
	{ text: 'Câu đầu…', pauseAfterMs: 165 },
	{ text: 'Câu sau.', pauseAfterMs: 165 },
]);
```

Also update the three Vietnamese `preparePlaybackUnits` integration
expectations from sentence pause `220 ms` to `165 ms`. These assertions cover
the normalized, normalization-failure, and whitespace-normalization fallback
paths, all of which consume `planSpeechUnits`.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_speech_units.test.ts
```

Expected: four assertions FAIL because production still returns
`80 / 120 / 140 / 220 / 350 ms`.

- [x] **Step 3: Apply the minimal centralized constant change**

Replace only the values in `VI_PAUSE_MS`:

```ts
export const VI_PAUSE_MS = Object.freeze({
	comma: 60,
	colonOrSemicolon: 90,
	spacedDash: 105,
	sentenceEnd: 165,
	paragraphEnd: 260,
});
```

Do not change `scanBoundaries`, `planParagraph`, `planSpeechUnits`, unit
length limits, or waveform generation.

- [x] **Step 4: Run focused and full automated verification**

Run:

```bash
node --experimental-strip-types --test tests/unit/vietnamese_speech_units.test.ts
node --experimental-strip-types --test tests/unit/playback_preparation.test.ts tests/unit/vietnamese_speech_units.test.ts
pnpm test:unit
pnpm build
CI=true pnpm test:e2e
git diff --check
```

Expected: focused tests, all unit tests, production build, and all E2E tests
PASS; `git diff --check` exits `0`.

- [x] **Step 5: Verify documentation and listening-gate consistency**

Run:

```bash
rg -n "60 ms|90 ms|105 ms|165 ms|260 ms|80 ms|120 ms|140 ms|220 ms|350 ms" \
  _docs/specs/2026-07-13-vietnamese-pronunciation-improvements.md \
  _docs/plans/2026-07-13-vietnamese-pronunciation-improvements.md
```

Expected: active pause tables, constraints, examples, and code snippets use
only the reduced values. Historical prose may mention that the new values are
approximately 25% below the original set. The 20-sample signed listening gate
remains pending and must evaluate the reduced timings before release.

- [ ] **Step 6: Commit only after explicit authorization**

Future commit scope:

```bash
git add src/offscreen/vietnamese/speech_units.ts \
  tests/unit/playback_preparation.test.ts \
  tests/unit/vietnamese_speech_units.test.ts \
  _docs/specs/2026-07-13-vietnamese-pronunciation-improvements.md \
  _docs/plans/2026-07-13-vietnamese-pronunciation-improvements.md
git commit -m "Reduce Vietnamese speech pauses"
```

Do not run these commands until anh guộc explicitly authorizes commits.

---

## Execution Order and Stop Conditions

Execute Tasks 1-8 sequentially because each consumes contracts/assets from the previous tasks. Task 9 validates the TypeScript baseline in real Chrome. Task 10 may prune ONNX Runtime artifacts regardless of custom Viterbi results, but it may change production threading only after its explicit 15% gate. Task 11 closes release documentation and status.
Task 12 is the only new executable task for the approved pause-timing
adjustment and runs after the existing implementation is present.

Stop and request review when any of these occurs:

- an asset or dictionary has no explicit redistributable license;
- the exported model does not reproduce the pinned oracle labels;
- deterministic normalization corrupts any must-not-change input or loses a source span;
- corpus micro F1 is below 90%;
- listening preference is below 80% or introduces a semantic regression;
- TypeScript misses Chrome p95 and Viterbi exceeds 50% of time, because that condition requires a separate custom-WASM prototype plan;
- ORT multithreading needs production cross-origin isolation but fails model/cache/CSP/lifecycle checks;
- completing the task would require a backend, telemetry, a new runtime dependency, or image-caption work.

## Final Success Criteria

- Known Vietnamese abbreviations expand by the approved precedence; unknown/low-confidence abbreviations fail open.
- `11/07`, full dates, decimals, grouped numbers, measurements, percentages, ranges, money, versions, and all 19 NSW classes pass reviewed tests without corrupting URLs/identifiers/invalid dates.
- Comma, colon/semicolon, spaced dash, sentence, and paragraph pauses follow the centralized strongest-boundary policy.
- Supertonic receives Vietnamese units with eight steps, existing speed, zero internal silence, WebGPU/WASM fallback, graph optimization `all`, and one-unit prefetch.
- Production remains fully local.
- TypeScript meets the Chrome budget, or work stops for the separately reviewed numeric-WASM prototype gate; no speculative full WASM normalizer is added.
- Bundled assets are immutable, checksummed, licensed, at most 5 MiB, present in build/ZIP, and covered by notices.
- Selective packaging removes unused ORT variants; threading changes only with measured cross-origin-safe improvement of at least 15%.
- Unit, corpus, E2E, listening, performance, memory, build, manifest, and release-package gates all pass before the spec is marked implemented.
