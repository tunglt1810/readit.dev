# Vietnamese Semantic Normalization Fixes

**Status:** Implemented and verified
**Date:** July 15, 2026
**Scope:** Three Vietnamese semantic normalization regressions in Free MVP playback

## 1. Goal

Correct three manually observed semantic pronunciation failures without
retraining the CRF model or changing the extension's local-only TTS boundary:

| Input | Current normalized form | Target normalized form |
| --- | --- | --- |
| `10h` | `10h` | `mười giờ` |
| `1.000 USD` | `một chấm không không không u ét đê` | `một nghìn đô la` |
| `thiết bị di động` | `thiết bị năm trăm linh một động` | unchanged |

The fix must preserve the currently correct behavior for dates, times with
minutes, measurements, and known abbreviations.

English code-switch pronunciation such as `resort` is a separate feature and
is not part of this change.

## 2. Verified causes

The failures reproduce with the bundled production CRF model and normalizer:

- The CRF labels `10h` as `NTIM`, but the time expander requires a minute
  component and therefore restores the source token. Supertonic subsequently
  drops the unsupported `h` sound.
- The tokenizer correctly protects `1.000 USD` as one structured token. The
  CRF labels that token `LSEQ`, and the current deterministic overlay does not
  replace a supported non-`O` label, even though the money recognizer matches
  the complete token unambiguously.
- The CRF labels `di` and `DI` as `O`. The deterministic overlay then treats
  either spelling as the Roman numeral `DI`, whose numeric value is 501.

The automated evaluation still reports perfect corpus results because its
time, money, Roman-numeral, and foreign-word examples do not include these
specific shapes or negative contexts.

## 3. Design decision

Use narrow deterministic corrections after CRF detection. Do not retrain or
replace the CRF checkpoint.

The pipeline remains:

```text
Vietnamese source text
  -> protected-token tokenizer
  -> CRF detection
  -> deterministic correction
  -> typed expansion
  -> Latin-script speech-unit planning
  -> Supertonic with lang=vi
```

No new model, runtime subsystem, extension permission, network request, or
speech-unit field is introduced.

## 4. Component behavior

### 4.1 Hour-only time

The `NTIM` expander must accept an hour followed by `h` when the hour is in the
inclusive range 0 through 23.

- `10h` becomes `mười giờ`.
- Existing forms such as `12h40` continue to become `mười hai giờ bốn mươi phút`.
- Invalid forms such as `24h` are preserved.

The deterministic recognizer must also identify a valid hour-only form as
`NTIM` so the behavior survives CRF unavailability.

### 4.2 Structurally valid money

A complete token that the existing money parser can expand is high-confidence
evidence. For this change, deterministic `MONEY` may replace an incorrect CRF
label, including `LSEQ`.

- `1.000 USD` becomes `một nghìn đô la`.
- `1.000,50 USD` becomes `một nghìn phẩy năm không đô la`.
- A currency-shaped token with malformed grouping, such as `1.00 USD`, must
  not be reinterpreted as another NSW type. It is preserved when the strict
  money parser rejects it.

This precedence change applies only to `MONEY`. It does not grant every
deterministic type authority to overwrite CRF labels.

### 4.3 Contextual Roman numerals

A token must not be expanded merely because its characters belong to
`IVXLCDM`, regardless of capitalization.

Roman-numeral expansion uses the following policy:

1. If the lowercased token is a known Vietnamese syllable and no explicit
   Roman-numeral context exists, preserve it. This protects both `di` and `DI`
   in Vietnamese prose and all-uppercase headings.
2. Otherwise, retain a valid `B-ROMA` label produced by the CRF.
3. When CRF detection is unavailable or returns `O`, deterministic fallback
   may label the token `ROMA` only with explicit context.
4. When the evidence remains ambiguous, preserve the original token.

Explicit context includes:

- a preceding ordinal/section cue such as `mục`, `chương`, `phần`, or `quý`;
- the phrase `thế kỷ` immediately before the token; or
- a standalone outline marker such as `IV.` or `XII)`.

Required examples:

| Input | Target normalized form |
| --- | --- |
| `thiết bị di động` | unchanged |
| `THIẾT BỊ DI ĐỘNG` | unchanged |
| `Mục XIV` | `Mục mười bốn` |
| `Chương IV` | `Chương bốn` |
| `thế kỷ XXI` | `thế kỷ hai mươi mốt` |
| `IV. Phạm vi` | `bốn. Phạm vi` |
| `Mục DI` | `Mục năm trăm linh một` |

## 5. Failure behavior and invariants

Normalization remains fail-open:

- A recognizer or expander returning `null` restores the complete source span.
- CRF or deterministic-correction failure must not stop playback.
- Punctuation and surrounding whitespace are preserved.
- Normalizing an already normalized result must not change it again.
- Date, measurement, abbreviation, URL, identifier, and phone preservation
  behavior must remain unchanged.

## 6. Test design

### 6.1 Unit tests

Add focused coverage for:

- hour-only expansion and invalid-hour preservation;
- deterministic recognition of `10h`;
- structurally valid and malformed USD forms;
- a fake CRF `B-LSEQ` label corrected to `MONEY`;
- `di` and `DI` preserved when the CRF returns `O`;
- contextual Roman numerals still expanded; and
- idempotency of all corrected outputs.

### 6.2 Production-model corpus

Add a natural evaluation document containing:

```text
DI CHUYỂN lúc 10h, chi phí 1.000 USD. Mục XIV quy định phạm vi áp dụng.
```

The production-asset evaluator must confirm the expected `NTIM`, `MONEY`, and
`ROMA` spans, the complete normalized golden text, and the absence of a false
positive on `DI`.

Add `thiết bị di động` and `DI CHUYỂN` to the preservation fixture. Corpus F1,
deterministic expansion rate, preservation rate, and normalization-golden
checks must continue to pass.

### 6.3 Runtime and listening checks

The existing Vietnamese E2E test validates local extraction, cancellability,
and the runtime asset boundary but cannot observe the text passed into the TTS
engine. Do not add an E2E assertion that merely repeats extraction behavior.

After building the extension, manually listen to:

- `10h`;
- `1.000 USD`;
- `thiết bị di động`; and
- `DI CHUYỂN — Mục XIV`.

The first two must convey the target meanings, neither `di` occurrence may be
spoken as 501, and `XIV` must still be spoken as fourteen.

## 7. Verification

Run:

```text
pnpm test:unit
pnpm evaluate:vi
pnpm build
pnpm validate:manifest
pnpm test:e2e:vi
pnpm test:e2e
git diff --check
```

The change is complete when every automated command passes and the four manual
listening cases meet the criteria above.

## 8. Out of scope

- Vietnamese-English code-switch detection or per-unit language selection.
- Phonetic dictionaries for foreign words.
- CRF retraining, checkpoint replacement, or abbreviation-scorer changes.
- Popup controls, user-configurable normalization rules, or custom
  pronunciation dictionaries.
