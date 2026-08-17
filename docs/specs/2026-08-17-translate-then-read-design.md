# Translate-then-Read Design

**Date:** 2026-08-17

**Status:** Proposed design; awaiting review

**Scope:** Reading a translated version of a Content Source aloud, using Chrome's built-in Translator API. The translation step is built for every source, but the first release wires it only to current-page reading — web articles, Google Docs, Word Online. See "Rollout" below. Chrome only; the Firefox build keeps its current behaviour.

## Summary

The user opens a page in a language they do not read comfortably, presses **Translate & read**, and the extension speaks a translated version in the Document Reader, with the usual word-level highlighting.

Translation happens in the background worker, before the Playback Session is created. The translated string becomes the session's `content`, and its target language becomes the session's `lang`. Everything downstream — `normalizeVietnameseText()`, the word map, the Document Reader, audio export, the playlist queue — runs unchanged, because it only ever sees a `PlaybackContent`.

## Constraint: No Gemini Nano

This feature must not depend on Gemini Nano, the ~4 GB shared model that backs the Prompt, Summarizer, Writer, Rewriter, and Proofreader APIs. Only the Translator and Language Detector APIs may be used, both of which run on their own small models — the Translator's are downloaded per language pair, a few tens of megabytes each.

The probe confirms the two are independent rather than merely documented as such: in a web page context where `LanguageModel` and `Summarizer` were not exposed at all, `Translator` still reported `available` and translated 718 characters in 79 ms. The per-pair `downloadprogress` events observed for `en→vi` and `vi→en` are separate downloads, unlike Gemini Nano's single shared model.

Any future change that introduces `LanguageModel` or `Summarizer` into this path violates this constraint. Their exclusion is also forced independently: both reject Vietnamese at `create()`.

## Probe Evidence

Measured on 2026-08-17, Chrome 151.0.7922.138 on macOS, against a real profile with translation models present. A throwaway MV3 extension was loaded through the CDP `Extensions.loadUnpacked` endpoint, and the same probe ran in an extension page, the service worker, and an offscreen document.

### API surface

| API | Web page | Extension page | Service worker | Offscreen document |
| --- | --- | --- | --- | --- |
| `LanguageDetector` | present | present | present | present |
| `Translator` | present | present | present | present |
| `Summarizer` | **absent** | present | present | present |
| `LanguageModel` | **absent** | present | present | present |
| `Writer` / `Rewriter` / `Proofreader` | absent | absent | absent | absent |

Translation works in all three extension contexts, including the MV3 service worker. This is what makes the chosen architecture possible.

### Language pair availability

| Pair | Status |
| --- | --- |
| `en → vi` | `available` |
| `vi → en` | `available` |
| `ja → vi`, `fr → vi`, `zh → vi`, `ko → vi` | `downloadable` |

Vietnamese is fully supported by the Translator API in both directions. This is in direct contrast to the Prompt and Summarizer APIs, which reject Vietnamese at `create()` with *"The requested language options are not supported"* — those accept only `[de, en, es, fr, ja]`.

### Latency

| Operation | Extension page | Service worker | Offscreen |
| --- | --- | --- | --- |
| `create()` en→vi | 171 ms | 66 ms | 63 ms |
| translate 718 chars, cold | 79 ms | 49 ms | 51 ms |
| translate 718 chars, warm | 37 ms | 35 ms | 39 ms |
| `create()` vi→en | 103 ms | 61 ms | 63 ms |
| translate 439 chars, cold | 81 ms | 44 ms | 48 ms |
| translate 439 chars, warm | 33 ms | 31 ms | 32 ms |

Roughly 19 characters per millisecond once warm. A 10,000-character article translates in about half a second, which is why the design translates a whole document up front rather than streaming it paragraph by paragraph during playback.

`LanguageDetector.detect()` returned in under 1 ms, scoring a mixed Vietnamese sample (containing `15/2024/NĐ-CP`, `GDP`, and digits) at `vi: 0.999` and an English sample at `en: 1.000`.

### Number formatting

The Translator emits numbers in the target language's convention, which happens to be exactly what the existing normalizer expects:

- `en → vi`: `$1,250,000` becomes `1.250.000 đô la`; `0.5%` becomes `0,5%`
- `vi → en`: `1.250 tỷ đồng` becomes `1,250 billion VND`

Dates and identifiers such as `3/4/2026` and `15/2024/NĐ-CP` pass through unchanged, so the Vietnamese CRF labels them as it does today. No conversion layer is needed between translation and normalization.

### Translation quality

Vietnamese to English reads well. English to Vietnamese is usable but makes real semantic errors. From the probe sample:

- "underspent by a wide margin" became "đã bị thiếu biên độ rộng" (meaningless)
- "built in a buffer of six weeks" became "đã xây dựng trong khoảng thời gian sáu tuần" (loses "buffer")
- "It recommended" became "Nó khuyến nghị" (no pronoun resolution)

This matters more for listening than for reading: a listener has no original text beside them to correct against, and a mistranslated sentence simply passes by. The disclaimer below is a requirement of the feature, not decoration.

## Language Support

Translation source is open — whatever pairs Chrome offers. Translation **target** is closed to three languages, because the Supertonic engine can only speak those: `MANUAL_LANGUAGES` in `src/background/manual_text.ts` is `['auto', 'en', 'vi', 'zh']`. Translating into Japanese would produce text no voice can read.

The ten entries in `VOICE_STYLES` are timbres, not languages, and are shared across all three.

## Architecture

Translation is a background concern, applied to the `Article` before a Playback Session exists.

```
Content Source                                       Playback Session
─────────────                                        ────────────────
extract Article { content, lang, title, url }
        │
        ├─ LanguageDetector.detect(content) ──► source language
        │
        ├─ source === target ? ──yes──► start normally, answer translated: false
        │
        └─ Translator.create({source, target})
           translate paragraph by paragraph
           join with "\n\n"
                    │
                    ▼
           Article { content: translated, lang: target }
           readableSurface: 'document-reader'
                    │
                    ▼
           existing pipeline, unchanged
```

Two properties make this work:

`PlaybackContent` is `{ content: string; lang: string }`. A translation is just a different value for both fields. Nothing downstream needs to know a translation happened.

The Document Reader already renders arbitrary text. `DocumentReaderSnapshot` carries `content` plus a `words` array, and `mapDocumentReaderWords()` matches the words into the content by text search. Because the reader renders the translated text and the word map is computed from that same translated text, highlighting stays aligned. This is the crucial difference from any approach that rewrites text and then projects highlights onto the original page DOM.

### Why not the offscreen document

Translating in the offscreen document, next to normalization, would avoid the service worker's lifetime risk. But the translated string would then have to travel back to the background so the Document Reader can render it, creating two paths that must produce byte-identical text or `mapDocumentReaderWords()` silently misaligns. The probe shows the service worker is in fact the fastest context of the three, so the risk it avoids is not worth the invariant it adds.

### Why not the Document Reader page

Translating where the text is displayed cannot misalign. But it moves content ownership into a surface, breaking the rule that only the background worker mutates session state.

### Paragraph-by-paragraph translation

The document is split on paragraph boundaries, each paragraph translated separately, and the results joined with `\n\n`. This is required, not an optimisation:

- `normalizeVietnameseText()` iterates `document.paragraphs` and rejoins with `\n\n`. Paragraph structure must survive translation.
- Translating one large blob risks the model collapsing or reflowing blank lines.
- It bounds the size of any single `translate()` call, whose maximum input length is not documented.

## Reading Position and Multi-Page Sources

Nothing is cached. At roughly half a second per article, storing translations would add a storage key and an invalidation problem without changing what the user feels.

### Rollout

The translation step lives inside `startPlayback()`, the single function every reading path converges on: current page, manual text, reader content for local EPUB/PDF/DOCX, and both selection paths. It is driven by a `translate` flag on the playback input, so a source opts in by setting that flag.

The first release wires the flag from one place only: the **Translate & read** button, which starts a current-page session. That covers web articles, Google Docs, and Word Online — every source that reaches the extension as a tab, and the use case the feature exists for.

Local EPUB, PDF, and DOCX, plus selection and manual text, keep their present behaviour for now. Adding each of them later means passing the flag and adding one control, not moving the translation step.

### Reading positions, when local books are added

Stored reading positions (`EPUB_PROGRESS`) index into whichever text was being read. A position recorded while reading a translation does not correspond to the original text, and vice versa, so resuming across a mode change lands the reader at an arbitrary point.

This does not arise in the first release, because no path that writes progress can produce a translation. When local books do gain the flag, the stored record must carry the target language, and `resolveResumePoint()` / `resolvePagedResumePoint()` in `src/reader/App.tsx` — which already guard on file identity and chapter count — must also reject a record whose mode differs from the current one, restarting the chapter instead.

## User Interface

### Starting

A third transport control sits between the read button and the export button in the popup and side panel — another way to start, so it belongs beside the start control rather than beside the follow-up one.

It is a 52 px circle like its neighbours, with the target language engraved into its face beneath the glyph, the way a hardware transport control carries its printed function. Every other control in that row has a fixed meaning; this one's meaning is a setting, so the face has to show the parameter. A rim badge was rejected for saying "count" and for colliding with the export button's progress ring, which is a different circle beside it meaning a different thing. The engraved code is muted at rest and lifts to the brand accent on hover and focus — the only motion added.

The Winamp and WMP12 decks are pastiches with their own button grammar, so there the control borrows the deck's material and drops the engraved code, which the tooltip carries instead. In the WMP deck it keeps the shared 52 px size rather than the stop button's 28 px: its neighbour is the 52 px export button, and it never appears alongside the stop button.

Its label names the outcome and the language — *Translate and read in Vietnamese* — rather than the mechanism. It is rendered whenever the browser can actually translate, which is the only thing the popup can know before extraction — deciding by source language would require the article's text, and the article is not extracted until the user asks for it. `globalThis.Translator` alone is not that test: Chromium builds without the models define the interface anyway, so `src/shared/translation_availability.ts` asks the Language Detector for its availability instead.

The language decision therefore happens after extraction, inside the background worker. `LanguageDetector` runs on the extracted content, and translation proceeds only when the detected source differs from the configured target with confidence at or above 0.5. Otherwise the article is read untranslated.

When that happens, the command answers `translated: false` and the caller shows a short notice. Saying nothing was the original design, and it was wrong: the user pressed a button labelled *Translate & read*, so silence reads as a broken feature rather than as a decision.

The user never gets a translation they did not ask for, and never gets a pointless one they did.

Because a translated session always uses `document-reader` as its Readable Surface, pressing the button on a website opens the Document Reader and reads there, rather than highlighting words in the original page. For sources that already render in the Document Reader — Google Docs, Word Online, PDF, EPUB, DOCX — nothing about the surface changes.

Starting a translated session opens that reader itself, rather than leaving it to the separate **Open Document Reader** command every other `document-reader` session relies on. The asymmetry is deliberate: a Google Doc or a PDF keeps its own page in front of the reader, so the reader is an extra there, while the translated text exists nowhere but the reader — the original page's DOM holds the untranslated words and cannot be highlighted. Left closed, a translated session would be audio with nothing highlighted anywhere. The reader may attach before the offscreen document has produced words; `initialize()` delivers the snapshot when it does.

### Target language

One setting offering `vi` / `en` / `zh`, defaulting to `vi`. No per-session picker.

It lives in the shared Configuration card (`SettingsCard`), beside voice and speed, so it appears in both the popup and the side panel and is hidden wherever translation cannot run. It is not on the Settings page: that page is reached only through a footer link labelled *Pronunciation dictionary*, where nobody looks for a reading preference.

The default is `vi` rather than the UI locale. A UI-locale default makes the feature a no-op in its most common case — an English reader on an English page resolves source to target, so nothing is translated and the button appears to do nothing. Vietnamese is also the language this reader normalizes most carefully.

### Disclaimer

The Document Reader shows a banner above translated content for the duration of the session:

```
⚠  Bản dịch tự động

Dịch trên máy bằng Chrome Translator (en → vi).
Dịch máy có thể sai nghĩa.

            [ Xem bản gốc ]
```

It names the actual tool — Chrome Translator, on device — and the language pair. It states no accuracy figure, because the Translator API returns none: `translate()` resolves to a bare string with no confidence metadata. A number would have to be invented, or borrowed from language detection, where it would be read as a claim about translation quality that it is not.

**Xem bản gốc** reveals the original text in a panel below the translation. Playback continues on the translation; the panel is for checking a sentence that sounded wrong.

## Changes to Existing Code

| File | Change |
| --- | --- |
| `src/shared/types.ts` | Add a translation descriptor (`sourceLanguage`, `targetLanguage`) to the session snapshot; add the target-language setting type |
| `src/shared/constants.ts` | Add `TRANSLATION_TARGET` to `STORAGE_KEYS` |
| `src/shared/document_reader.ts` | `DocumentReaderSnapshot` gains `originalContent` and the translation descriptor; `isDocumentReaderSnapshot()` currently asserts `Object.keys(snapshot).length === 5` and must be updated in step, or valid snapshots are rejected without an error |
| `src/background/` | New translation module; wire it into the paths that build an `Article`; force `readableSurface: 'document-reader'` for translated sessions |
| `src/reader/App.tsx` | Disclaimer banner and the original-text panel |
| `src/shared/components/SettingsCard.tsx` | Target language setting, shared by the popup and the side panel |
| `src/shared/components/TranslateReadButton.tsx` | The transport control, shared by the popup and the side panel |
| `src/shared/i18n.ts` | Strings for the button, banner, and setting |

`src/offscreen/` is not touched. `detectContentLanguage()` in `src/shared/language_detection.ts` is not touched either — it answers "is this Vietnamese", which is what the TTS pipeline needs, and its comment explains why it deliberately ignores `<html lang>`. The Language Detector API is used only to choose a translation pair, which is a different question.

## Error Handling

| Condition | Behaviour |
| --- | --- |
| Browser cannot translate (Firefox, older Chrome, no models) | Button and target setting never rendered |
| Pair `downloadable` | `create()` triggers the one-off model download and the session's existing `loading` status covers the wait. No percentage is surfaced: a progress channel from the worker to the popup is not worth its complexity for something that happens once per pair, and the project forbids console output, so a `downloadprogress` monitor would have no consumer at all |
| Pair `unavailable`, or `create()` / `translate()` rejects | Report the failure; no session is started. Reading the original remains available |
| Detector confidence below 0.5 | Source is unknown; read the original untranslated and answer `translated: false` |
| Source equals target | Read the original untranslated and answer `translated: false` |

## Testing

Unit tests cover the parts that are pure logic: paragraph splitting and rejoining preserves boundaries and round-trips an untranslated document unchanged; pair selection from detector output, including the confidence threshold and the source-equals-target case; snapshot validation accepting the new fields and still rejecting malformed input.

End-to-end tests have a real limitation worth stating plainly. Playwright drives bundled Chromium, which has no built-in AI at all — `Translator` is simply undefined there. E2E therefore injects a fake `Translator` and asserts the flow: button visibility, the disclaimer rendering with the right pair, highlighting following the translated text, and the original-text panel. **The E2E suite cannot verify that real translation works.** That is confirmed by hand against Chrome, as the probe was.

Per project convention, the extension must be rebuilt before running Playwright, since the suite loads `dist/chrome`.

## Non-Goals

Summarization and LLM-assisted normalization are out of scope: both APIs reject Vietnamese at `create()`, so they cannot serve this project's primary language today.

Translating the page in place, leaving the original DOM as the Readable Surface, is out of scope — it is the one shape that breaks word highlighting.

Firefox support is out of scope; the button is absent there.

Caching translations is out of scope, per the reasoning above.
