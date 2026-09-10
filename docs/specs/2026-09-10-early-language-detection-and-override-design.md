# Early language detection and manual override

Date: 2026-09-10

## The problem

Before playback starts, the panel takes its language from `document.documentElement.lang`:

```
contentLang = session?.lang ?? (pageInfo.available ? pageInfo.lang : null) ?? uiLang
```

(`src/sidepanel/App.tsx:597`, `src/popup/App.tsx:381`)

Vietnamese pages routinely declare `en` or declare nothing at all; Google Docs declares the Google
account's locale rather than the document's language. The panel therefore lists English voices. Only
once the reader presses play does the content script extract the real text and
`detectContentLanguage()` (`src/shared/language_detection.ts:20`) run against it — at which point the
language flips to `vi` and the voice list changes underneath them.

The chosen voice is lost too: voice preferences are keyed by base language
(`src/shared/edge_voice_preferences.ts:8`). A voice picked while the panel believed the page was `en`
is stored under `en`; when the session turns out to be `vi`, `resolveEdgeVoice()` falls through to
`defaultVoiceForLanguage('vi')`.

Two consequences the reader sees: **the language and voice cannot be chosen before reading**, and
**the extension changes the voice the moment reading starts**.

One further constraint: `detectContentLanguage()` today separates only `vi` from `declaredLang` — it
counts the ratio of Vietnamese diacritics. A Japanese page declaring `en` will never be recognised.

## The solution

Three independent parts which together address both consequences:

1. **Detect early** — run detection against a text sample as soon as the panel opens, rather than
   waiting for playback.
2. **A script-detection layer** — widen the detector from "Vietnamese or not" to cover the non-Latin
   writing systems.
3. **A manual override** — a language dropdown in the panel which outranks detection.

---

## Part 1 — Early detection in the content script

`GET_PAGE_INFO` (`src/content/content_script.ts:57`) runs detection itself rather than shipping text
back to the background:

```
declared = getDocumentLanguage()
sample   = document.body.innerText.slice(0, 4000)

sampleTrustworthy =
    parseGoogleDocsDocumentId(url) === null      // canvas-rendered: innerText is only chrome
 && parseWordOnlineDocument(url)   === null
 && letterCount(sample) >= 100                   // empty page, or an SPA that has not rendered

trustworthy  → { lang: detectContentLanguage(sample, declared), langSource: 'detected' }
otherwise    → { lang: declared, langSource: 'unknown' }
```

`langSource` is `'unknown'` even when the page does declare a language: on Google Docs that
declaration is known to be wrong (it is the Google account's locale), so it does not count as
evidence. The panel still uses `lang` as an opening guess, but `langSource` says plainly that the
guess is weak.

`PageInfoResponse` (`src/shared/types.ts`) gains `langSource: 'detected' | 'unknown'`.

Detection runs in place in the content script, so no 4KB of text crosses the message channel on every
panel refresh, and the pre-playback path uses **exactly the same function** as the playback path —
the two cannot drift apart.

### Accepted limitation

`body.innerText` includes navigation, sidebars and comments. That noise is harmless for deciding a
language (the test is a ratio of characters, not of content), but it does mean early detection and
playback detection **can disagree** on a bilingual page — an English article on a site with a
Vietnamese interface, say.

The response is not to force the two to agree. If the reader does not touch the dropdown, playback
still uses detection against the real article, which is more accurate. If they do touch it, Part 3
keeps that choice from being overridden.

Google Docs, Word Online and PDF land on `langSource: 'unknown'`. Full extraction on panel open is
not worth it — too slow for every page the reader merely glances at, and it carries network requests.

---

## Part 2 — The script-detection layer

A step is inserted into `detectContentLanguage()` between the Vietnamese layer and the fallback:

```
1. Vietnamese diacritic ratio >= 0.03      → 'vi'      (unchanged)
2. compare the text's dominant script with the declared language's script
     agree     → keep declared                          (declared is more specific)
     disagree  → the default language of the observed script
3. declared === 'vi' ? 'na' : declared                  (unchanged)
```

### Finding the dominant script

Count `\p{Script=...}` for Han, Hiragana, Katakana, Hangul, Cyrillic, Arabic, Thai, Devanagari, Greek,
Hebrew and Latin. The script with the highest count, if it carries at least **30%** of the letters, is
the dominant one.

Within CJK:
- Kana at **5%** or more of the letters ⇒ `ja` (Chinese essentially never carries kana)
- Hangul ⇒ `ko`
- Han alone ⇒ `zh`

### The "only override on disagreement" rule

Scripts do not map one-to-one onto languages: Cyrillic may be ru/uk/bg/sr, Arabic may be ar/fa/ur,
Devanagari may be hi/mr/ne. Overriding unconditionally would force a correctly declared Persian page
into `ar` — breaking a case that currently works.

| Page | declared | Observed script | Result |
|---|---|---|---|
| Japanese newspaper declaring `en` | en | Kana | `ja` — fixed |
| Persian page declaring `fa` | fa | Arabic | `fa` — kept |
| Ukrainian page declaring `uk` | uk | Cyrillic | `uk` — kept |
| Russian page declaring nothing | na | Cyrillic | `ru` — sensible default |
| English article quoting one Han phrase | en | Latin dominant | `en` — not disturbed |

This needs a static `language → script` table for the roughly forty languages the engines speak,
written by hand in `language_detection.ts`. That is the entire added cost: no dependency, and no
change to the Vietnamese threshold.

Latin-script languages (en/fr/de/es…) still cannot be told apart by detection. They rely on
`declaredLang` — usually correct — and on the override when it is not.

---

## Part 3 — The manual override

### The control

A language `<select>` beside the voice select, in both the side panel and the popup.

- First entry: `Auto (Vietnamese)` — the label states what automatic detection resolved to, so a wrong
  reading is visible without opening the list.
- The remaining entries come from the selected engine.

A new module, `src/shared/language_options.ts`:

```ts
languageOptionsFor(provider: TtsProviderId): { code: string; name: string }[]
```

- `edge` → the base languages drawn from `public/assets/edge_voices.json`
- `supertonic` → `AVAILABLE_LANGS` (`src/offscreen/supertonic_helper.ts`) without `na`
- Display names from `Intl.DisplayNames(uiLang, { type: 'language' })` — no hand-written table to go
  stale, and correct in whichever interface language is active. Sorted with `localeCompare`.

The list follows what the engine can actually speak: offering a language with no voice behind it names
a choice the listener will never hear.

### Lifetime

`languageOverride: string | null` in panel state, `null` meaning automatic. It resets to `null` when
the active tab or the URL changes. Nothing is written to storage.

Scoping it to the page is deliberate: a globally sticky choice would read an English page in a
Vietnamese voice once the reader forgot to change it back, and a per-domain memory adds a storage
layer and a new concept in the interface for a need that early detection makes rare.

### Resolving the displayed language

Replacing `src/sidepanel/App.tsx:597` and `src/popup/App.tsx:381`:

```
contentLang = languageOverride ?? session?.lang ?? pageInfo.lang ?? uiLang
```

The override sits **ahead of** `session.lang`. That is what fixes the voice being reassigned: once a
choice has been made by hand, a starting session cannot pull the panel to another language.

### While playing

The dropdown is **disabled** whenever a session is running for that content, showing `session.lang`
read-only. `lang` decides segmentation and normalization at the moment the session is created;
changing it mid-article would require rebuilding all of it and would lose the reading position with no
warning. Stopping makes the control available again.

### Reaching playback

`START_CURRENT_PAGE` and `START_CURRENT_PAGE_TRANSLATED` gain an optional `payload.languageOverride`
— the context menu, the queue and the reader send none, so their behaviour is unchanged.

In `startPlayback()` (`src/background/background.ts:876`) it is applied once, at the **top of the
function**, before `translateForPlayback()`:

```ts
if (input.languageOverride) {
	input = { ...input, content: { ...input.content, lang: input.languageOverride } };
}
```

At the top because everything downstream reads `content.lang` from one place: `readEdgeVoice()`,
`resolveStoredPlaybackSpeed()`, `preparePlaybackUnits()`, and the Vietnamese normalizer.

The translation branch still overwrites it with `targetLanguage` afterwards, which is correct: the
override names the source language, and a translated article is spoken in the target language.
`translateArticleText()` detects its own source through `Translator.detectLanguage()` and never reads
this field.

---

## Part 4 — Merging the manual-text dropdown

The paste-text tab in the side panel already has a `auto | en | vi | zh` select
(`src/sidepanel/App.tsx:805`, `src/shared/types.ts:20`). After Part 3 the same panel would carry two
language dropdowns with different lists — four entries on one tab, forty on the other.

Merge them: both use `language_options.ts`.

- `ManualTextLanguage` widens from a closed union to `'auto' | string`
- `manual_text.ts` validates against the engine's list instead of `MANUAL_LANGUAGES`

This also lifts a real limitation of that tab: pasting Japanese into it currently offers no way to
select `ja`.

---

## Out of scope

- Remembering the override per domain or globally.
- Full extraction on panel open; Google Docs, Word Online and PDF rely on the override until playback.
- Adding an external language-detection library (franc, tinyld). They would cover the Latin group but
  add bundle size and would likely require re-tuning the carefully calibrated Vietnamese threshold —
  buying coverage for the less important group at the cost of risk to the main use case.
- Touching `VIETNAMESE_LETTER_RATIO` or the existing Vietnamese layer.

---

## Verification

| What | How it is verified |
|---|---|
| The script layer does not break the Vietnamese layer | `bun test tests/unit/language_detection.test.ts` — every existing Vietnamese case still green |
| The "only override on disagreement" rule | New tests for the five rows in the Part 2 table |
| The per-engine language list | Unit test for `language_options.ts`: edge returns locales that exist in the catalogue; supertonic returns `AVAILABLE_LANGS` without `na` |
| An untrustworthy sample | Unit test: a Google Docs or Word Online URL, or text under 100 letters → `langSource: 'unknown'`, `lang` = declared |
| The override beats detection | Unit test for `startPlayback`: `languageOverride: 'ja'` on an article detected as `vi` → `session.lang === 'ja'` |
| The dropdown locks during playback | Component test: with a session present, the select is disabled and its value is `session.lang` |
| Manual text accepts a language outside the original four | Unit test for `manual_text.ts`: `language: 'ja'` is accepted rather than falling back to `auto` |
| The original bug is gone | Playwright: open the panel on a Vietnamese page declaring `lang="en"` → Vietnamese voices are listed **before** play is pressed; press play, and the voice does not change |

That last end-to-end check is the real success criterion: if it is green, the language and voice can be
chosen before reading, and the extension no longer takes that choice back.

## Files touched

New:
- `src/shared/language_options.ts`
- `tests/unit/language_options.test.ts`

Modified:
- `src/shared/language_detection.ts` — the script layer and the language→script table
- `src/content/content_script.ts` — the text sample and detection inside `GET_PAGE_INFO`
- `src/shared/types.ts` — `PageInfoResponse.langSource`, widened `ManualTextLanguage`
- `src/sidepanel/App.tsx` — the dropdown, the override state, the merged manual-text select
- `src/popup/App.tsx` — the dropdown and the override state
- `src/background/background.ts` — applying `languageOverride` in `startPlayback()`
- `src/background/manual_text.ts` — validating against the engine's list
- `tests/unit/language_detection.test.ts`, `tests/unit/manual_text.test.ts`,
  `tests/unit/page_info.test.ts`, `tests/unit/sidepanel_page_info_refresh.test.ts`, e2e
