# Custom Pronunciation Dictionary — Design Spec

**Created**: 2026-08-11
**Status**: Approved (brainstorming complete)
**Proposal**: [2026-08-08-custom-pronunciation-dictionary.md](file:///Users/bez/Workspace/repos/bez/readit.dev/docs/proposals/2026-08-08-custom-pronunciation-dictionary.md)

---

## 1. Problem Summary

readit.dev's TTS quality depends on a hand-tuned normalization pipeline and a
built-in abbreviation dictionary. A long tail of brand names, acronyms,
loanwords, and personal preferences will never be covered by shipped code.
Users currently have no way to fix mispronunciations — they must file an issue
and wait for a release.

## 2. Solution

A **Custom Pronunciation Dictionary**: a local, per-user list of
`match → spoken replacement` rules applied before Supertonic synthesis via the
existing `synthesisText` seam on `SpeechUnit`, without changing the visible
source text or the word-by-word highlight.

**Architecture**: Post-planning `synthesisText` injection (Approach A).

```
Content extraction → Unit planning → 🆕 Dictionary → Consolidation → Synthesis
```

## 3. Data Model

```typescript
interface PronunciationRule {
  id: string;                     // crypto.randomUUID()
  match: string;                  // text to match, e.g. "HTML"
  replacement: string;            // spoken form, e.g. "aitch tee em el"
  wholeWord: boolean;             // default true — don't match inside other words
  caseSensitive: boolean;         // default true — "US" ≠ "us"
  lang?: 'en' | 'vi' | 'zh';     // optional — omit = applies to all languages
  enabled: boolean;               // allow temporary disable without deleting
  createdAt: number;              // Date.now() — for display sorting
}
```

### Storage

- Key: `STORAGE_KEYS.PRONUNCIATION_DICTIONARY` = `'readit_pronunciation_dictionary'`
- Backend: `chrome.storage.local` (via `webextension-polyfill` wrapper for
  cross-browser support)
- Value: `PronunciationRule[]`
- Cap: 200 rules (validate on add, show warning near limit)

### Cross-Browser Storage Wrapper

- New module: `src/shared/storage.ts` — thin wrapper using `webextension-polyfill`
  (already in dependencies but unused), exporting `browser.storage.local`.
- Pronunciation dictionary will use this wrapper exclusively.
- Existing `chrome.storage` callsites are **not migrated** in this scope —
  that's a separate task.

## 4. Matching Engine

### Module

`src/offscreen/pronunciation_dictionary.ts` — pure function, no side effects.

```typescript
function applyPronunciationDictionary(
  units: SpeechUnit[],
  rules: readonly PronunciationRule[],
  lang: string
): void  // mutates units in-place (assigns synthesisText)
```

### Algorithm

1. **Filter**: remove rules where `enabled === false` or `rule.lang` doesn't
   match the current playback `lang`.
2. **Sort**: remaining rules by `match.length` descending (longest-first).
   Stable sort preserves order for equal lengths.
3. **Iterate** each unit:
   - Source text = `unit.synthesisText ?? unit.text` (respect prior normalizer
     output).
   - For each sorted rule, check if `match` appears in source text:
     - `wholeWord === true`: check word boundaries (whitespace / string
       start/end — Unicode-aware, not `\b` which doesn't work for Vietnamese).
     - `caseSensitive === false`: compare via `.toLowerCase()`.
   - On first (longest) match: replace all occurrences → assign result to
     `unit.synthesisText`.
   - Multiple rules can match the same unit at different positions: apply
     sequentially longest-first, each rule operates on the result of the
     previous.
4. **Short-circuit**: if no rule matches a unit, leave it untouched.

### Granularity

**Single-unit matching only.** Rules match within the text of one `SpeechUnit`.
No cross-unit matching. Trade-off accepted: multi-word brand names split across
units won't match, but this covers the vast majority of use cases (abbreviations,
single-word names, loanwords).

### Precedence

**Longest-match-first.** When multiple rules match the same position, the rule
with the longer `match` string wins. Deterministic, no user ordering required.

### Priority over built-in normalization

Dictionary applies **after** built-in normalizers (Vietnamese abbreviation
expander, etc.) but **before** consolidation. If a unit already has
`synthesisText` from a normalizer, dictionary applies on top of it. User rules
always win — this is correct because the user explicitly wants a different
pronunciation.

## 5. Integration Points

### 5a. Latin path — `src/offscreen/latin/speech_units.ts`

```typescript
const units = planLatinSpeechUnits(text, ...);
applyPronunciationDictionary(units, rules, lang); // 🆕
const consolidated = consolidateShortSpeechUnits(units);
```

### 5b. Vietnamese path

Same pattern: call after Vietnamese unit planner, before consolidation.

### 5c. Rules loading

- Orchestrator loads rules from storage **once** at playback session start.
- Rules passed as parameter to pipeline — module never queries storage directly
  (pure, testable).
- Mid-playback rule changes: apply to next segment via lazy reload on
  `storage.onChanged` event.

## 6. Settings Page

### Entry point

- New HTML entry: `src/settings/index.html` + `src/settings/App.tsx` (React
  mount, separate from popup).
- Declared in `manifest.json` — no new permissions needed.
- Opened via `browser.tabs.create({ url: browser.runtime.getURL('settings/index.html') })`.
- Shares CSS variables and theme system with popup.

### Access points

1. **Popup**: link/button "Pronunciation Dictionary" → opens settings page tab.
2. **Context menu**: sub-item under existing `readit-menu` parent (see §7).

### Layout

```
┌─────────────────────────────────────────────┐
│  ← readit.dev    Pronunciation Dictionary   │
├─────────────────────────────────────────────┤
│  [+ Add Rule]     Language: [All ▾]  3/200  │
├─────────────────────────────────────────────┤
│  ── All Languages ──────────────────────────│
│  ☑  readit.dev → rid-it dot dev      [✎][🗑]│
│                                             │
│  ── English ────────────────────────────────│
│  ☑  HTML  →  aitch tee em el         [✎][🗑]│
│  ☑  GPT-4 →  gee pee tee four       [✎][🗑]│
│                                             │
│  ── Tiếng Việt ─────────────────────────────│
│  ☑  TP.HCM → thành phố hồ chí minh  [✎][🗑]│
└─────────────────────────────────────────────┘
```

### UI behavior

- **Language filter**: select box with `All` | `All Languages` | `English` |
  `Tiếng Việt` | `中文`. Filters visible groups.
- **Group headers**: rules grouped by `rule.lang`. Order: "All Languages"
  (lang = undefined) → EN → VI → ZH.
- **Within each group**: sorted by `createdAt` descending (newest first).
- **Checkbox** (left): `enabled` toggle — quick on/off without editing.
- **Lang badge**: shown if rule has specific `lang`, hidden for "All".
- **Counter**: `3/200` showing rule count / limit.
- **Empty state**: "No rules yet. Add a rule to customize how words are
  pronounced."

### Inline editing

Click row or ✎ button to enter edit mode:

```
┌─────────────────────────────────────────────┐
│  Match:       [HTML          ]              │
│  Speaks as:   [aitch tee em el]             │
│  ☑ Whole word  ☑ Case sensitive  Lang: [All]│
│  [Save] [Cancel]                            │
└─────────────────────────────────────────────┘
```

## 7. Quick-Add — Context Menu

Sub-item under existing `readit-menu` parent:

```
readit ►
  ├── Read selected text
  ├── ──────────────
  ├── Add to queue
  ├── Play queue
  ├── Replay queue
  ├── ──────────────                          ← new separator
  └── Add pronunciation rule for "%s"         ← 🆕 selection only
```

- `parentId: 'readit-menu'`, `contexts: ['selection']`.
- Click handler: `browser.tabs.create` opens settings page with query param
  `?match=<encodeURIComponent(selectedText)>`.
- Settings page reads `?match` on mount → pre-fills match field, opens inline
  editor, focuses replacement input.

## 8. Localization

New i18n keys in `src/shared/locales/en.json` and `vi.json`:

- `pronunciationDictionary` — page title
- `addRule` — add button
- `editRule` — edit button aria label
- `deleteRule` — delete button aria label
- `ruleMatch` — "Match" label
- `ruleSpeaksAs` — "Speaks as" label
- `ruleWholeWord` — "Whole word" toggle
- `ruleCaseSensitive` — "Case sensitive" toggle
- `ruleLanguage` — "Language" selector
- `ruleLanguageAll` — "All Languages" option
- `ruleLimitWarning` — warning when near/at 200 rule cap
- `emptyDictionary` — empty state message
- `contextMenuAddRule` — context menu item title

## 9. Out of Scope (v1)

- Regex/pattern rules or phonetic/IPA input.
- Per-site auto-suggested corrections or ML-driven learning.
- Cross-device sync (stays `storage.local`-only).
- Cross-unit matching (multi-word rules spanning unit boundaries).
- Search/filter within rule list (not needed with 200 cap).
- Migration of existing `chrome.storage` callsites to wrapper.

## 10. Testing Strategy

### Unit tests — `tests/unit/pronunciation_dictionary.test.ts`

Using Node.js native test runner (`node:test` + `node:assert/strict`):

- Matching: exact match, whole-word boundary, case-sensitive vs insensitive
- Overlap: longest-match-first when multiple rules match same position
- Lang filter: rule with `lang: 'en'` skipped for Vietnamese units
- Enabled filter: rule with `enabled: false` skipped
- Existing `synthesisText`: dictionary applies on `synthesisText` not `text`
- Empty rules array: units not mutated
- Multiple rules, different positions in same unit: sequential replace correct
- Edge cases: empty match, empty replacement, no matches found

### E2E tests — `tests/e2e/pronunciation_dictionary.spec.ts`

- Add rule via settings page → play article → verify `synthesisText` receives
  replacement text
- Enable/disable toggle works
- Context menu quick-add opens settings page with match pre-filled
- Rule cap validation (reject adding rule #201)
- Persistence: add rule → close settings → reopen → rule still present

### Not tested

- Audio output (Supertonic synthesis) — only verify correct text reaches
  `synthesize()`.
- Highlight alignment — `text` is never modified, existing highlight test
  coverage sufficient.

## 11. Files Changed / Created

| File | Action | Description |
|------|--------|-------------|
| `src/shared/types.ts` | MODIFY | Add `PronunciationRule` interface |
| `src/shared/constants.ts` | MODIFY | Add `PRONUNCIATION_DICTIONARY` to `STORAGE_KEYS` |
| `src/shared/storage.ts` | NEW | Cross-browser storage wrapper via `webextension-polyfill` |
| `src/shared/locales/en.json` | MODIFY | Add pronunciation dictionary i18n keys |
| `src/shared/locales/vi.json` | MODIFY | Add pronunciation dictionary i18n keys |
| `src/offscreen/pronunciation_dictionary.ts` | NEW | Matching engine (pure functions) |
| `src/offscreen/latin/speech_units.ts` | MODIFY | Wire dictionary after unit planning |
| Vietnamese unit planner | MODIFY | Wire dictionary after unit planning |
| `src/settings/index.html` | NEW | Settings page HTML entry point |
| `src/settings/App.tsx` | NEW | Settings page React app |
| `src/background/context_menu.ts` | MODIFY | Add pronunciation rule sub-item |
| `src/background/background.ts` | MODIFY | Handle context menu click + rule loading |
| `src/popup/App.tsx` | MODIFY | Add link to settings page |
| `manifest.json` | MODIFY | Declare settings page |
| `tests/unit/pronunciation_dictionary.test.ts` | NEW | Unit tests for matching engine |
| `tests/e2e/pronunciation_dictionary.spec.ts` | NEW | E2E tests |
