# Vietnamese Pronunciation Improvements Specification

**Status:** Approved design; implementation pending
**Date:** July 13, 2026
**Scope:** Vietnamese pronunciation in Free MVP article playback

**Automated checkpoint (July 14, 2026):** all 82 unit tests, the 30-document
corpus (213 labeled spans covering all 19 NSW types, micro F1 `1.0`), build,
packaging, and 17 Vietnamese/full-extension E2E gates pass. Chrome 149 measured
the production full-paragraph CRF path at normalization p95 `15.30 ms` for
2,007 tokens and `62.70 ms` for 10,015 tokens, so custom Viterbi WASM is not
required. Human listening, warm-TTFA, repeated-session memory, and full CPU-TTS
thread evidence remain release gates; therefore this status is not yet
`Implemented and verified`.

## 1. Goal

Improve Vietnamese pronunciation without changing the Free MVP's
local-processing boundary. Vietnamese articles must sound more natural when
they contain abbreviations, dates, numbers, and punctuation.

This specification extends the [Free MVP Design
Specification](./2026-07-12-free-mvp-design.md). It does not add a backend,
cloud AI, telemetry, translation, or a dependency on Chrome Built-in AI.

## 2. Product decisions

- Vietnamese text is normalized before Supertonic tokenization and chunking.
- The normalizer follows the two-stage approach from *Non-Standard Vietnamese
  Word Detection and Normalization for Text-to-Speech*: detect typed
  non-standard words, then expand each type with deterministic rules.
- The first implementation uses TypeScript for tokenization, CRF inference,
  rule expansion, and pause planning.
- A small ONNX abbreviation scorer reuses the existing
  `onnxruntime-web` runtime when a dictionary entry has multiple possible
  expansions.
- Unknown or low-confidence text is preserved. The normalizer must never invent
  an expansion merely to avoid reading the original token.
- Punctuation produces explicit pause metadata instead of relying only on
  punctuation glyphs or one global silence value.
- Supertonic keeps its official medium-quality setting of eight denoising
  steps. Voice styles and the existing user speed control remain unchanged.
- Chrome Built-in AI is not required for normalization, punctuation, or
  playback.
- Custom WASM is allowed only after Chrome profiling proves that the numeric
  CRF kernel is a material bottleneck.

## 3. Current baseline and failure causes

The current repository already runs Supertonic 3 in the offscreen document,
prefers WebGPU, and falls back to ONNX Runtime WebAssembly. It uses eight
denoising steps, a default speed of `1.05`, an outer chunk target of 200
characters, and a `0.3` second internal silence value.

The reported Vietnamese problems occur before or around synthesis:

| Problem                                                          | Current cause                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Known abbreviations are spoken letter by letter                  | No Vietnamese abbreviation expansion runs before Supertonic.                                                                          |
| `11/07` does not become a spoken date                            | Supertonic preprocessing replaces `/` with a space without first classifying the expression as a date.                                |
| Commas, dashes, and sentence boundaries have inconsistent rhythm | Chunking primarily recognizes `.`, `!`, and `?`; silence is attached to internal length-based chunks rather than semantic boundaries. |

These are text preparation and segmentation problems. Increasing denoising
steps alone cannot reliably correct them.

## 4. Target architecture

```text
Page document
  -> Article extraction
     -> preserve paragraph boundaries
  -> Article contract and session coordinator
  -> Offscreen Vietnamese speech preparation
     -> protect structured tokens
     -> tokenize and compute features
     -> CRF NSW detection
     -> rule/dictionary expansion
     -> punctuation-aware speech units
  -> Supertonic 3
     -> WebGPU first
     -> ONNX Runtime WASM fallback
  -> audio queue and playback
```

Full-page and selected-text playback continue to converge on the existing
offscreen path and both receive normalization and pause planning. The `Article`
contract remains plain text, with paragraph boundaries represented by blank
lines.

## 5. Vietnamese text-normalization pipeline

Normalization runs only when the resolved article language is `vi`. Other
languages keep the existing Supertonic path.

### 5.1 Preprocessing and protection

Before tokenization, the normalizer must:

1. normalize Unicode and whitespace without removing Vietnamese diacritics;
2. preserve paragraph boundaries;
3. protect URLs, email addresses, decimal numbers, grouped numbers, dates,
   times, versions, ranges, scores, measurements, and currency expressions
   from destructive punctuation cleanup;
4. distinguish a punctuation dash surrounded by spaces from a hyphen inside a
   range, date, identifier, or compound token;
5. retain a reversible mapping to the original token and source span.

The existing Supertonic preprocessing remains the final model-specific cleanup,
but it must receive an already normalized date or URL rather than the original
structured token.

### 5.2 Non-standard-word detection

The detector ports the light CRF path rather than a BERT-family model. Its
feature extractor must match the pinned reference model and cover token shape,
casing, numeric shape, prefixes, suffixes, neighbor tokens, dictionary
membership, and sentence-boundary flags.

The immutable checkpoint exposes 30 native states in its original class order:
28 recognized BIO labels covering the 19 NSW types below, `O`, and a legacy
`B-USS` state. Not every type has an observed `I-*` state. The exporter and
runtime must preserve this exact checkpoint order rather than synthesize
zero-weight labels that are absent from the model. `B-USS` and any unknown
checkpoint label are unsupported and must fail open by restoring the original
source span.

| Group               | Types                                                            |
| ------------------- | ---------------------------------------------------------------- |
| Words and sequences | abbreviation, character/digit sequence, foreign word, URL/email  |
| Date and time       | date, day, month, quarter, time                                  |
| Numeric             | digit, number, fraction, percentage, range, score, Roman numeral |
| Domain values       | measurement, money, version                                      |

The Python `pickle` model is a development-time source only. A pinned export
step must convert its labels, state features, transitions, and weights to a
versioned portable artifact committed with the extension. Production and test
runtime code must not require Python, `sklearn-crfsuite`, or pickle loading.

### 5.3 Typed expansion

Each detected span is sent to exactly one expander. Expanders are deterministic
unless the abbreviation dictionary contains multiple candidates.

Required behavior includes:

| Input category             | Example target speech form                                                      |
| -------------------------- | ------------------------------------------------------------------------------- |
| Abbreviation               | `ĐH` -> `đại học`; `TP.HCM` -> `Thành phố Hồ Chí Minh`                          |
| Short date                 | `11/07` -> `mười một tháng bảy`                                                 |
| Full date                  | `11/07/2026` -> `ngày mười một tháng bảy năm hai nghìn không trăm hai mươi sáu` |
| Decimal and grouped number | `7,9` -> `bảy phẩy chín`; `178.000` -> `một trăm bảy mươi tám nghìn`            |
| Measurement                | `42 km` -> `bốn mươi hai ki lô mét`                                             |
| Percentage                 | `12,5%` -> `mười hai phẩy năm phần trăm`                                        |
| Range                      | `10-12` -> `mười đến mười hai`                                                  |
| Money                      | `700.000đ` -> `bảy trăm nghìn đồng`                                             |
| Version                    | `v1.2.3` remains a version and is not interpreted as a decimal or date          |

Rules must preserve surrounding punctuation and whitespace. Running the
normalizer twice over its output must not change the text a second time.
Vietnamese numeric dates use `DD/MM[/YYYY]`; invalid calendar dates are
preserved instead of being coerced.

### 5.4 Abbreviation policy

Abbreviations use this precedence:

1. one unambiguous dictionary expansion;
2. the bundled ONNX scorer for a dictionary entry with multiple candidates;
3. a safe letter-sequence reading for a recognized uppercase sequence;
4. the original token.

The initial feature does not expose a custom-dictionary UI. The first release
ships only the vetted bundled dictionary.

The scorer must use a constrained candidate list from the dictionary. It must
not generate free-form replacements. If its model cannot load, its confidence
is below the calibrated threshold, or its result is not one of the candidates,
the original token or deterministic letter sequence is used.

### 5.5 Fail-open behavior

Normalization is an enhancement, not a playback prerequisite:

- CRF load failure falls back to high-confidence deterministic recognizers.
- Abbreviation scorer failure falls back to an unambiguous dictionary value,
  safe letter sequence, or original token.
- An empty, malformed, or non-finite model result is rejected.
- A failed expansion restores the complete original source span.
- Normalizer failure is reported only as local developer diagnostics; article
  playback continues with the original text.

## 6. Punctuation and pause planning

The normalizer produces ordered speech units rather than only one normalized
string:

```ts
type SpeechUnit = {
  text: string;
  pauseAfterMs: number;
};
```

Punctuation remains in `text` so Supertonic can generate natural prosody. The
offscreen audio path adds the following initial silence after a unit boundary:

| Boundary                             | Additional pause |
| ------------------------------------ | ---------------: |
| Comma                                |            60 ms |
| Colon or semicolon                   |            90 ms |
| Spaced dash (` - `, ` – `, or ` — `) |           105 ms |
| Sentence end (`.`, `?`, `!`, or `…`) |           165 ms |
| Paragraph end                        |           260 ms |

The strongest applicable boundary wins; pauses are not added together. A dash
inside `10-12`, `11-07-2026`, a URL, or an identifier is never treated as a
pause boundary.

The pause values are production starting values, not user-facing settings.
This July 14 pacing adjustment reduces the original explicit pauses by about
25% while preserving their relative hierarchy. The pending listening
evaluation must validate the reduced set before release. The implementation
must keep the table centralized and testable.

Speech-unit construction prefers natural boundaries near 200 characters and
must not exceed Supertonic's 300-character non-Korean/Japanese input limit. A
unit over the hard limit is split at the nearest whitespace. Very short clauses
may remain joined when splitting would create a fragment under 20 characters;
in that case the retained punctuation supplies the model's natural pause.

Because outer speech units own silence, the Supertonic call uses
`silenceDuration = 0` for these units. This avoids stacking the current hidden
`0.3` second length-based silence on top of a semantic pause.

## 7. Supertonic runtime parameters

The Vietnamese path uses these initial settings:

| Parameter                    | Setting                                   | Rationale                                                                                            |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `lang`                       | `vi`                                      | Use Supertonic's Vietnamese language conditioning.                                                   |
| `total_steps`                | `8`                                       | Official medium-quality default; higher steps add latency without solving text-normalization errors. |
| User speed                   | Existing `0.70x`-`1.80x`, default `1.05x` | Preserve the current Free MVP contract and Supertonic's supported range.                             |
| Preferred speech-unit length | 200 characters                            | Preserve current time-to-first-audio behavior.                                                       |
| Hard speech-unit length      | 300 characters                            | Match Supertonic's non-Korean/Japanese internal limit.                                               |
| `silenceDuration`            | `0` inside a prepared unit                | Pause planning owns explicit silence.                                                                |
| Execution provider           | WebGPU, then WASM                         | Preserve current fallback behavior.                                                                  |
| Graph optimization           | `all`                                     | Preserve current ONNX session optimization.                                                          |
| Prefetch depth               | One upcoming unit                         | Preserve bounded memory and cancellation behavior.                                                   |

Voice-style assets remain unchanged. Expression tags are not automatically
injected; they represent performance style rather than semantic normalization.

## 8. Chrome Built-in AI decision

Chrome Built-in AI is not on the required path:

| API                   | Decision                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt API            | Do not use. Its published expected text languages currently exclude Vietnamese, generative output is less deterministic than constrained expansion, and device/model availability would make speech quality inconsistent. |
| Proofreader API       | Do not use. It is a developer-trial API for grammar, spelling, and punctuation correction, not TTS normalization, and it may alter source meaning.                                                                        |
| Language Detector API | Optional future fallback when page language is absent or unreliable. It must be feature-detected, confidence-gated, and non-blocking.                                                                                     |

Any future Language Detector integration must preserve these rules:

- `document.documentElement.lang` remains the first signal;
- detection uses a representative article sample, not a single word;
- Vietnamese is accepted only above a calibrated confidence threshold;
- unavailable or downloadable models never block playback;
- Chromium browsers without the API retain the existing language fallback;
- no article text is sent to Google or another remote inference service.

## 9. TypeScript and WASM strategy

### 9.1 Normalizer baseline

Tokenization, CRF features, rule expansion, dictionaries, and Viterbi decoding
ship in TypeScript first. Viterbi uses typed numeric arrays and processes a
whole sentence or article batch per call.

A design-time V8 microbenchmark of the pinned checkpoint's 30-state numeric kernel measured about
`2.08 ms` p50 for 2,000 tokens and `10.45 ms` p50 for 10,000 tokens on the
development machine. This is directional evidence only; Chrome offscreen
profiling remains the acceptance source.

### 9.2 Conditional hybrid WASM

Custom WASM may be introduced only when all of these are true:

1. the actual Chrome p95 normalization budget is missed;
2. profiling shows Viterbi consumes more than 50% of normalization time;
3. a prototype improves end-to-end normalization latency by at least 20%;
4. normalized output remains byte-for-byte identical to the TypeScript path.

If required, only the numeric Viterbi kernel moves to Rust/WASM. JavaScript
keeps all string, regex, dictionary, and DOM work. The boundary accepts batched
numeric emission and transition arrays in one call; it never passes individual
tokens or strings repeatedly across the JS/WASM boundary.

A full Rust/Emscripten normalizer is out of scope.

### 9.3 Existing ONNX Runtime WASM

The abbreviation scorer and Supertonic already reuse ONNX Runtime Web. The
implementation must separately benchmark the CPU fallback with
`numThreads = 1`, automatic selection, `2`, and `4` threads.

Shipping multithreaded WASM requires:

- verified extension cross-origin isolation;
- successful Hugging Face model downloads and cache reads;
- working WebGPU and WASM fallback sessions;
- no CSP, worker-loading, stop/cancellation, or lifecycle regression;
- at least 15% improvement in time-to-first-audio or synthesis real-time
  factor on representative CPU-fallback devices.

If those conditions are not met, the current single-thread setting remains.
The July 14 automated checkpoint keeps `numThreads = 1`; no production
cross-origin-isolation change is justified without the complete CPU-TTS gate.

### 9.4 WASM packaging

The previous build copied every ONNX Runtime `.wasm` variant and produced about
74 MB of WASM artifacts. Instrumented Chrome loading verified the Asyncify
loader/WASM pair plus the hashed bundled `ort.webgpu.min` frontend for the
selected `onnxruntime-web/webgpu` import. Other variants are excluded and the
release validator rejects them recursively.

A custom reduced-operator ONNX Runtime build is considered only after selective
packaging, and only if its generation is reproducible in CI. WASM and worker
code must be bundled with the MV3 extension; remotely hosted executable code is
not allowed.

## 10. Assets, privacy, and attribution

The research baseline is `soe-vinorm` v0.3.2 at source commit
`c2b0c1eb36cec1584416ca4652b5391f4e723727`. An implementation may adopt a
newer revision only through an explicit fixture, license, size, and quality
review.

The selected CRF weights, abbreviation scorer, dictionaries, and configuration
must be pinned by source revision and checksum. Their measured uncompressed
size is `4,097,681` bytes and their budget is no more than 5 MiB beyond the
existing ONNX Runtime and Supertonic assets.

The normalizer assets are bundled with the extension rather than downloaded at
article-read time. Article text, detected labels, normalized text, speech units,
and generated audio remain on the device and are not persisted as product data
or sent to a backend.

`THIRD_PARTY_NOTICES.txt` must add the source, revision, copyright, and MIT
license notice for any code, weights, or dictionaries derived from
`soe-vinorm`. The implementation must also verify whether every derived data
asset has an explicit redistributable license before including it.

## 11. Error and fallback behavior

| Case                           | Required behavior                                               |
| ------------------------------ | --------------------------------------------------------------- |
| Non-Vietnamese article         | Bypass Vietnamese normalization and retain existing playback.   |
| Missing CRF asset              | Run deterministic recognizers and continue.                     |
| Missing abbreviation scorer    | Use unambiguous dictionary values or preserve the token.        |
| Unknown abbreviation           | Use a safe recognized letter sequence or preserve the original. |
| Ambiguous date/number          | Preserve the source token when type confidence is insufficient. |
| Normalizer exception           | Restore original article text and continue playback.            |
| Empty normalized unit          | Drop only the empty unit; never discard adjacent source text.   |
| Chrome Built-in AI unavailable | Continue without it and show no error.                          |
| WebGPU failure                 | Preserve the existing WASM fallback.                            |
| Multithreaded WASM failure     | Fall back to verified single-thread WASM.                       |

No fallback may invoke a cloud normalizer, Prompt API polyfill, remote LLM, or
readit.dev backend.

## 12. Test and evaluation strategy

### 12.1 Unit and golden tests

Add deterministic coverage for:

- all 19 CRF NSW types and BIO span reconstruction;
- every rule expander, including invalid and boundary values;
- known, ambiguous, unknown, dotted, mixed-case, and adjacent abbreviations;
- `11/07`, full dates, leap dates, invalid dates, times, decimals, grouped
  numbers, ranges, scores, versions, phone-like sequences, URLs, and emails;
- punctuation dash versus range/date/identifier hyphen;
- idempotence and restoration of original text on failure;
- pause precedence and speech-unit length limits;
- non-Vietnamese bypass and selected-text behavior.

Golden fixtures derived from the pinned Python reference implementation are
checked into the repository. Python is allowed to generate or audit fixtures
during development but is not required to run the extension test suite.

### 12.2 Corpus evaluation

Maintain a checked-in evaluation corpus containing at least:

- 30 Vietnamese news excerpts from varied domains;
- 200 manually reviewed non-standard-word spans;
- 20 abbreviation cases with surrounding context;
- 20 date/time/number cases;
- adversarial cases that must remain unchanged.

Required results:

- at least 90% micro F1 for NSW type detection on the internal labeled corpus;
- 100% match for deterministic golden expansion cases;
- 100% preservation for explicit must-not-change cases;
- no empty article or lost source span after normalization.

This internal corpus does not claim reproduction of the paper's reported
metrics because the paper's original annotated dataset and trained checkpoint
are not part of this repository.

### 12.3 Listening evaluation

Compare the baseline and improved audio using the same voice, speed, and random
seed where the test harness can control it. Reviewers must cover abbreviation
meaning, date correctness, pause naturalness, repeated/skipped speech, and
time-to-first-audio.

The improved path must be preferred in at least 80% of the targeted problem
samples and must not introduce a semantic reading regression in the
must-not-change set.

### 12.4 Performance and release verification

Measure cold and warm runs in the actual Chrome offscreen document on WebGPU
and CPU fallback:

- normalization p95 at or below 50 ms for a 2,000-token article;
- normalization p95 at or below 150 ms for a 10,000-token stress article;
- normalization below 5% of warm time-to-first-audio;
- no unbounded growth across repeated article sessions;
- production build and full unit/E2E suites pass;
- built extension and release ZIP contain the pinned normalizer assets and
  updated third-party notice;
- built extension contains no unused ONNX Runtime WASM variant after selective
  packaging is enabled.

## 13. Acceptance criteria

Implementation is complete only when:

1. known Vietnamese abbreviations expand to reviewed spoken forms and unknown
   abbreviations fail open;
2. `11/07` and the required date/number categories produce the specified
   spoken forms without corrupting versions, URLs, ranges, or identifiers;
3. commas, spaced dashes, sentence ends, and paragraphs follow the centralized
   pause policy;
4. Supertonic runs with the specified Vietnamese parameters and preserves
   WebGPU/WASM fallback behavior;
5. Chrome Built-in AI remains optional and playback works identically when it
   is unavailable;
6. TypeScript meets the Chrome performance budget, or the conditional numeric
   WASM kernel passes every gate in section 9.2;
7. normalizer assets, notices, privacy behavior, build output, unit tests, E2E
   tests, corpus evaluation, and listening evaluation satisfy this document;
8. no backend, cloud AI, telemetry, translation, new user setting, or remote
   executable code is introduced.

## 14. Out of scope

This specification defers semantic image-caption announcements and does not add
arbitrary image descriptions, OCR, SSML, automatic expression tags,
translation, voice cloning, a pronunciation editor, user dictionaries, cloud
fallback, Prompt API rewriting, Proofreader-based correction, BERT/BiLSTM
normalization, a full Rust normalizer, or changes to non-Vietnamese
normalization.

## 15. Research references

- [Supertonic official repository](https://github.com/supertone-inc/supertonic)
- [Non-Standard Vietnamese Word Detection and Normalization for Text-to-Speech](https://arxiv.org/abs/2209.02971)
- [`soe-vinorm` reference implementation](https://github.com/vinhdq842/soe-vinorm)
- [`soe-vinorm` model assets and license](https://huggingface.co/vinhdq842/soe-vinorm)
- [Chrome Built-in AI API status](https://developer.chrome.com/docs/ai/built-in-apis)
- [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
- [Chrome Proofreader API](https://developer.chrome.com/docs/ai/proofreader-api)
- [Chrome Language Detector API](https://developer.chrome.com/docs/ai/language-detection)
- [ONNX Runtime Web environment flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)
- [ONNX Runtime Web deployment](https://onnxruntime.ai/docs/tutorials/web/deploy.html)
- [Chrome extension cross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation)
