# Feature Proposal: Custom Pronunciation Dictionary

**Created Date**: 2026-08-08
**Status**: Proposed (not yet designed or scheduled)
**Author**: Claude (agent proposal, for team review)

---

## 1. Problem

readit.dev's TTS quality depends on a hand-tuned normalization pipeline
(`src/offscreen/vietnamese/*`, `src/offscreen/latin/*`) plus a built-in
abbreviation dictionary (`src/offscreen/vietnamese/abbreviations.ts`). The
`CHANGELOG.md` shows a recurring pattern of pronunciation fixes that each
required a code change and a release:

- "sentence tail truncation and short unit consolidation for Vietnamese TTS"
- "filter category metadata noise and preserve DOM order for Znews articles"
- "sync language speed defaults and resolve audio cutoff in list consolidation"
- earlier: "Improve UX and Vietnamese NSW processing", "Normalize Vietnamese
  semantic text"

Some mispronunciations are systemic bugs worth fixing centrally, but a large
long-tail category never will be: brand/product names ("readit.dev", "GPT-4",
site-specific product names), acronyms outside the shipped dictionary, foreign
loanwords, and personal preference for how an ambiguous term should sound.
Today a user who hits one of these has no way to fix it — they either live
with it or file an issue and wait for a release.

## 2. Proposal

Add a **Custom Pronunciation Dictionary**: a small, local, per-user list of
`match → spoken replacement` rules that readit.dev applies before Supertonic
synthesis, without changing the visible source text or the word-by-word
highlight the reader already tracks.

Example: a user adds `readit.dev → rid-it dot dev`, or `HTML → aitch-tee-em-el`,
and every future playback (Article, pasted text, PDF, Google Docs) speaks it
that way, while the on-page highlight still tracks the literal word
`readit.dev` / `HTML`.

## 3. Why this fits the existing architecture

The codebase already separates *what gets highlighted* from *what gets
synthesized* at the unit level:

```typescript
// src/offscreen/speech_unit.ts
export interface SpeechUnit {
	/** Canonical planned text used for source order, highlights, mappings, and export metadata. */
	text: string;
	/** Internal TTS-only rendering used when absorbed boundaries need cadence preservation. */
	synthesisText?: string;
	...
}
```

```typescript
// src/offscreen/audio.ts:23
const wav = await synthesize(unit.synthesisText ?? unit.text, lang, 8, speed, internalSilence);
```

`synthesisText` already exists precisely to let audio diverge from the
canonical, highlighted `text` (currently used only for short-segment
consolidation cadence, see `short_segment_consolidation.ts`). A pronunciation
dictionary is a natural second use of the same seam: populate
`synthesisText` from user rules, leave `text` — and therefore `wordMap`,
`word_timing.ts`, and the Readable Surface highlight — untouched.

This also keeps the feature isolated from the CRF-based Vietnamese
normalizer, which is sensitive and has many hand-tuned regressions already
covered by tests; the dictionary is a coarse, independent, user-authored
layer applied at unit-planning time, not a change to the normalizer itself.

## 4. Scope (v1)

- **Settings UI**: a new collapsible "Pronunciation" section, following the
  existing `SettingsCard.tsx` pattern (inline rows, theme-aware styling,
  `t(...)` localization for `en`/`vi`). Rules are listed with add / edit /
  delete; no dedicated page needed for a first version.
- **Rule shape**: `{ id, match, replacement, wholeWord, lang? }`.
  - `match` / `replacement` are plain text — no regex in v1, to keep it
    approachable for non-technical users.
  - `wholeWord` (default true) avoids replacing inside unrelated words.
  - `lang` is optional; omitted = applies to all languages, set = applies
    only when the unit's detected language matches (EN/VI/ZH), since the
    same string can need a different spoken form per language.
- **Storage**: `chrome.storage.local`, new key
  `STORAGE_KEYS.PRONUNCIATION_DICTIONARY` (`readit_pronunciation_dictionary`),
  following the existing key-naming convention in `src/shared/constants.ts`.
  Cap at a fixed rule count (e.g. 200) to bound storage size and per-unit
  matching cost.
- **Application point**: a new pure module, e.g.
  `src/offscreen/pronunciation_dictionary.ts`, exporting something like
  `applyPronunciationDictionary(text: string, rules: readonly PronunciationRule[], lang: string): string | undefined`
  (returns `undefined` when no rule matches, matching the existing
  `unit.synthesisText ?? unit.text` fallback convention). Called during unit
  planning (`latin/speech_units.ts` and the Vietnamese unit-planning
  equivalent) at the same point `synthesisText` is already assigned, and
  again where `short_segment_consolidation.ts` merges `synthesisText` across
  merged units so a multi-word rule cannot be split across a consolidation
  boundary.
- **Coverage**: because it operates on already-extracted plain text rather
  than the DOM, it works uniformly across every existing Content Source
  (website Article, Manual Reader pasted text, PDF, Google Docs export).

## 5. Out of scope for v1

- Regex/pattern rules or phonetic/IPA input — plain "say X as Y" text covers
  the common case and matches how users already think about it.
- Per-site auto-suggested corrections or any ML-driven "learn from my
  correction" loop.
- Cross-device sync of the dictionary — the PRD already lists
  "synchronization" under Free MVP's explicitly-future scope; this stays
  `chrome.storage.local`-only like the rest of the Free feature set.

## 6. User value

- Converts a recurring engineering fix-and-release cycle into a self-service
  fix for the long tail of names/acronyms/loanwords a shipped dictionary can
  never fully cover.
- Immediate feedback loop: the reader's existing replay control lets a user
  validate a new rule by re-reading the same paragraph, no reload needed.
- Zero privacy impact: rules and matching stay fully on-device, consistent
  with the Free MVP requirement to send no article or pasted content to a
  remote service.

## 7. Risks / open questions

- **Overlapping rules** (e.g. `US` and `USA`) need a deterministic
  resolution order — longest-match-first is the simplest correct rule.
- **Highlight alignment** must not regress: since only `synthesisText` is
  populated and `text` never changes, this should be verifiable with the
  existing `attachPlainWordMap` / `word_timing.ts` test coverage without new
  highlight-specific test infrastructure.
- **Consolidation interaction**: `short_segment_consolidation.ts` already
  merges `synthesisText` across short units; dictionary application must run
  before that merge (or be re-applied consistently after it) so a rule
  spanning a unit boundary still matches.
- **Rule authoring UX**: worth deciding whether case sensitivity is
  configurable per rule or fixed to case-insensitive for v1 — the latter is
  simpler and likely sufficient.

## 8. Suggested rollout

1. Design spec at `docs/specs/<date>-pronunciation-dictionary-design.md`
   covering exact storage schema, matching/precedence algorithm, and the
   Settings UX, following the conventions in
   `docs/specs/2026-07-26-settings-card-redesign-spec.md`.
2. `pronunciation_dictionary.ts` as pure functions with unit tests (Node
   `test` + `assert/strict`, mirroring `tests/unit/playlist_queue.test.ts`).
3. Wire into unit planning (Latin + Vietnamese paths) and consolidation.
4. Settings UI in `SettingsCard.tsx` plus localization entries in
   `src/shared/locales/{en,vi}.json`.
5. E2E coverage: add a rule, play, and assert the DOM highlight still tracks
   the original word while the synthesized audio path receives the
   replacement text.
