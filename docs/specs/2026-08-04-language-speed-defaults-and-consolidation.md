# Language-based Speed Defaults, Cross-Language Consolidation & Audio Truncation Fix

## Overview
This specification addresses three related core improvements in Readit TTS engine and session controls:
1. **Language-based Default Speed**: Automatically default speech playback speed based on the content's detected language (Vietnamese `vi` -> `1.5`, all other languages fallback -> `1.1`), ensuring speed controls stay synchronized across all extension surfaces (Popup, Reader, Sidepanel).
2. **Cross-Language Short Segment Consolidation**: Uniformly apply short-segment consolidation (< 20 non-whitespace characters) to all supported languages (`en`, `vi`, `ko`, `ja`, etc.) using `consolidateShortSpeechUnits`.
3. **Audio Cut-off / Truncation Fix**: Eliminate loss of the final syllable/word at line-ends in English and unpunctuated text by introducing acoustic tail padding and tail space/punctuation handling in synthesis pipelines.

---

## 1. Language-based Speed Defaults & Synchronization

### 1.1 Speed Resolution Logic
A helper function `getDefaultSpeedForLanguage(lang?: string): number` will resolve default playback speeds:
- Vietnamese (`/^vi(?:$|[-_])/iu`): **1.5**
- Fallback / All other languages (`en`, `ko`, `ja`, `es`, etc.): **1.1**

### 1.2 Session Initialization & Speed Sync
- When a playback session starts, if no active session override is present, `session.speed` initializes to `getDefaultSpeedForLanguage(session.lang)`.
- When user changes playback speed via any UI controller (Popup, Sidepanel, Reader), `CHANGE_SPEED` is dispatched to the background coordinator.
- The background coordinator updates `session.speed`, persists user preferences, and broadcasts the updated `session` snapshot to all UI listeners.
- When loading a new article in a different language, the active speed switches to that language's default speed.

---

## 2. Cross-Language Short Segment Consolidation

### 2.1 Consolidation Policy
- Any planned `SpeechUnit` with non-whitespace character count `< 20` (`MIN_RELIABLE_SYNTHESIS_CHARACTERS`) is flagged as a short unit.
- `consolidateShortSpeechUnits` merges adjacent short units (e.g., titles like `DATA STRATEGY` or item headers `1. Purpose`) up to the language engine limit (`synthesisTextLimitForLanguage`).
- Applied uniformly in `preparePlaybackUnits` for all language inputs (`vi`, `en`, `ko`, `ja`, etc.).
- When merging units without terminal punctuation, a period `.` and space are inserted to maintain natural sentence cadence.

---

## 3. Audio Tail Truncation Fix

### 3.1 Root Cause Analysis
- Supertonic ONNX neural vocoder duration predictor outputs raw PCM frames that stop immediately at the end of the text tokens.
- When lines or headings lack terminal punctuation, text endings cut off abruptly.
- Playback via Web Audio API `AudioBufferSourceNode` clips final phonemes (e.g., "growth", "reporting", "segments") due to zero acoustic decay margin.

### 3.2 Mitigation Steps
- **Acoustic Silence Tail Padding**: Append ~60ms - 80ms of silent Float32 PCM samples (zero-padding) to the raw output of `synthesizeSpeechUnitSamples` before passing to `createSpeechAudioBuffer`.
- **Text End Alignment**: Ensure `preprocessText` and `synthesisText` maintain trailing punctuation and space so the duration predictor allocates proper tail frames for final phonemes.

---

## 4. Verification Plan
- Unit test for `getDefaultSpeedForLanguage` (`vi` -> 1.5, `en` -> 1.1).
- Unit test for `preparePlaybackUnits` verifying short segment consolidation on English sample text.
- E2E / manual playback verification confirming no audio truncation on final words of English bullet lists.
