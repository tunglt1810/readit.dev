# Side Panel Manual Highlight and Preemptible Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented and verified, including cumulative-prefix timing and the real-runtime mixed-Markdown correction.

**Goal:** Highlight the spoken word in locked Side Panel manual text, while allowing a web reading to checkpoint and later resume the manual audio at the interrupted position.

**Architecture:** Keep the native textarea only for stopped manual text; replace it in place with a read-only reader during manual playback. Add owner-scoped shared manual-playback contracts, a memory-only offscreen checkpoint, and background preemption rules so web playback remains the sole audible session while the Side Panel can explicitly resume or discard manual playback. Route internal offscreen timing through one background-owned public event, preserve per-token word-map entries when a normalization span is rejected, predict cumulative utterance durations at every mapped word prefix, convert increasing totals to word weights, and scale those weights to the decoded audio clock with deterministic fallback.

**Tech Stack:** React 19, strict TypeScript, Chrome MV3 Side Panel/service worker/offscreen document APIs, Web Audio `AudioBufferSourceNode`, Supertonic ONNX duration predictor, semantic `<mark>` rendering, Node test runner, Playwright.

## Global Constraints

- Keep `minimum_chrome_version` exactly `127`; use Side Panel page `pagehide`, not `chrome.sidePanel.onClosed`.
- Retain a single audible audio source. Web and manual audio must never play concurrently.
- Pasted draft, reader text, prepared speech units, decoded audio buffers, and checkpoint state must never enter `chrome.storage.local`, `chrome.storage.session`, web storage, a URL, telemetry, a backend, or a webpage content script.
- A manual session snapshot may include only a random `panelInstanceId` owner field in addition to its existing non-content metadata.
- Closing or reloading the owning Side Panel stops active audio, discards its manual checkpoint, clears manual highlighting, and leaves the next Side Panel document with an empty draft. Switching tabs does not trigger cleanup.
- Manual reader highlighting is always on. `readit_word_highlight_enabled` remains limited to webpage content scripts.
- Duplicate or stale manual word indices retain the current mark; only a genuinely newer unmatched event clears it.
- Offscreen emits `OFFSCREEN_MANUAL_WORD_TIMING`; only background emits public `MANUAL_WORD_HIGHLIGHT_UPDATE`.
- Model-predicted prefix totals remain memory-only, use the already-loaded local model, and fall back for the whole unit when totals are invalid or non-increasing without changing audio.
- A detected multi-token normalization span may be one highlight target only when its spoken output differs from the source. Rejected spans retain one target per non-punctuation source token.
- Every new visible Side Panel string must be present in both `THEME_TRANSLATIONS.vi` and `THEME_TRANSLATIONS.en` in `src/shared/constants.ts`, consumed through `t()`, and asserted in `tests/unit/theme_i18n.test.ts`.
- Preserve the popup, Article, selection, theme, manifest permissions, and webpage highlight behavior except where a tab start now intentionally preempts a valid manual session.
- Keep temporary browser profiles and screenshots beneath repository `.tmp/`; do not create OS temporary artifacts.

## File structure

| Path | Responsibility |
| --- | --- |
| `src/shared/manual_playback.ts` | Typed manual start/control, internal timing, public highlight runtime messages, and validation helpers. |
| `src/shared/types.ts` | Adds the manual session owner ID without admitting content into snapshots. |
| `src/background/manual_text.ts` | Validates a manual start payload, including its owner ID, before it replaces playback. |
| `src/background/playback_state.ts` | Creates and strictly validates manual session snapshots with owner metadata only. |
| `src/background/background.ts` | Coordinates manual checkpoint, web preemption, resume/discard/owner cleanup, and manual highlight relays. |
| `src/background/offscreen_transport.ts` | Narrows checkpoint/resume offscreen commands and responses. |
| `src/offscreen/manual_checkpoint.ts` | Holds the memory-only checkpoint shape and pure offset/owner invariants. |
| `src/offscreen/offscreen.ts` | Captures/restores a manual `AudioBuffer`, predicts cumulative prefix durations, and emits monotonic internal timing events. |
| `src/offscreen/vietnamese/normalizer.ts` | Keeps accepted expansions grouped while splitting rejected multi-token spans back into word-level source mappings. |
| `src/offscreen/supertonic_helper.ts` | Exposes duration-only batch prediction and repeats the voice style across the text batch. |
| `src/offscreen/word_timing.ts` | Builds contextual spoken prefixes, converts valid cumulative totals to word weights, and scales model or fallback weights to decoded audio duration. |
| `src/sidepanel/manual_word_highlight.ts` | Maps manual word events to matched, stale, or unmatched monotonic reader outcomes. |
| `src/sidepanel/App.tsx` | Renders editable and locked-reader modes, lifecycle cleanup, manual controls, and localized errors. |
| `src/sidepanel/sidepanel.css` | Styles reader, active highlight, paused-for-web state, and controls across all themes. |
| `src/shared/constants.ts` | Adds English and Vietnamese UI strings. |
| `tests/unit/*.test.ts` | Tests contracts, snapshot privacy, checkpoint offsets, manual reader matching, and localization. |
| `tests/e2e/side-panel.spec.ts` | Verifies Side Panel reader states, lifecycle cleanup messages, localization, storage privacy, and the mixed-Markdown normalizer-to-renderer regression. |
| `tests/e2e/reading-state.spec.ts` | Verifies real coordinator preemption, resume, discard, and cleanup state transitions. |
| `docs/specs/2026-07-19-side-panel-manual-text-design.md`, `docs/PRD.md`, `docs/privacy-policy.md`, `docs/RELEASING.md` | Align prior shipped guidance with locked reader, no persisted checkpoint, and close/reload stop behavior. |

---

### Task 1: Define owner-safe manual playback contracts and localized copy

**Files:**
- Create: `src/shared/manual_playback.ts`
- Modify: `src/shared/types.ts:11-76`
- Modify: `src/background/manual_text.ts:1-66`
- Modify: `src/background/playback_state.ts:1-128`
- Modify: `src/shared/constants.ts:41-156`
- Modify: `tests/unit/manual_text.test.ts`
- Modify: `tests/unit/playback_state.test.ts`
- Modify: `tests/unit/theme_i18n.test.ts`
- Create: `tests/unit/manual_playback.test.ts`

**Interfaces:**
- Produces `ManualPlaybackStartPayload`, `ManualPlaybackControlMessage`, `ManualWordHighlightMessage`, and `isPanelInstanceId()` for later Side Panel/background work.
- Changes manual `source` to `{ kind: 'manual'; panelInstanceId: string }` and keeps `PlaybackSessionSnapshot` free of text, content, title, and URL fields.
- Produces translation keys `manualReaderLabel`, `manualPausedForWeb`, `resumeEditorReading`, `stopEditorReading`, `manualCheckpointUnavailable`, and `manualCheckpointFailed`.

- [x] **Step 1: Write failing contract and snapshot tests**

```ts
// tests/unit/manual_playback.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { isPanelInstanceId, isManualPlaybackControlMessage } from '../../src/shared/manual_playback.ts';

test('accepts only UUID-shaped Side Panel owner IDs', () => {
	assert.equal(isPanelInstanceId('ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd'), true);
	assert.equal(isPanelInstanceId('not-an-owner'), false);
});

test('rejects a manual control message without an owner ID', () => {
	assert.equal(isManualPlaybackControlMessage({ action: 'RESUME_MANUAL_CHECKPOINT' }), false);
	assert.equal(
		isManualPlaybackControlMessage({
			action: 'RESUME_MANUAL_CHECKPOINT',
			panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd',
		}),
		true,
	);
});
```

```ts
// tests/unit/playback_state.test.ts: manual fixture expectations
source: { kind: 'manual', panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' },
```

Add assertions that a manual snapshot rejects an empty owner ID, extra source keys, and raw-content top-level fields.

- [x] **Step 2: Run the new tests to verify they fail**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_playback.test.ts tests/unit/playback_state.test.ts tests/unit/manual_text.test.ts
```

Expected: FAIL because `manual_playback.ts` and the manual owner type do not exist.

- [x] **Step 3: Implement minimal shared contracts, owner validation, and translations**

```ts
// src/shared/manual_playback.ts
import type { ManualTextLanguage } from './types.ts';

const PANEL_INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ManualPlaybackStartPayload = {
	text: string;
	language: ManualTextLanguage;
	panelInstanceId: string;
};

export type ManualPlaybackControlMessage =
	| { action: 'RESUME_MANUAL_CHECKPOINT'; panelInstanceId: string }
	| { action: 'DISCARD_MANUAL_CHECKPOINT'; panelInstanceId: string }
	| { action: 'STOP_SIDE_PANEL_AUDIO'; panelInstanceId: string };

type ManualWordEventFields = {
	sessionId: string;
	word: string;
	wordIndex: number;
};

export type ManualWordTimingMessage = ManualWordEventFields & {
	action: 'OFFSCREEN_MANUAL_WORD_TIMING';
};

export type ManualWordHighlightMessage = ManualWordEventFields & {
	action: 'MANUAL_WORD_HIGHLIGHT_UPDATE';
};

export function isPanelInstanceId(value: unknown): value is string {
	return typeof value === 'string' && PANEL_INSTANCE_ID.test(value);
}

export function isManualPlaybackControlMessage(value: unknown): value is ManualPlaybackControlMessage {
	if (!value || typeof value !== 'object') return false;
	const message = value as { action?: unknown; panelInstanceId?: unknown };
	return (
		(message.action === 'RESUME_MANUAL_CHECKPOINT' ||
			message.action === 'DISCARD_MANUAL_CHECKPOINT' ||
			message.action === 'STOP_SIDE_PANEL_AUDIO') &&
		isPanelInstanceId(message.panelInstanceId)
	);
}
```

Update `ManualPlaybackSessionSnapshot`, `CreatePlaybackSessionInput`, and `isPlaybackSessionSnapshot()` to require exactly `{ kind: 'manual', panelInstanceId }`. Add a `prepareManualStart()` wrapper around existing text/language preparation that returns `{ content, panelInstanceId }` only when both are valid.

Add these entries to both `THEME_TRANSLATIONS` maps:

```ts
// vi
manualReaderLabel: 'Văn bản đang đọc',
manualPausedForWeb: 'Đọc trong editor đã tạm dừng để đọc web.',
resumeEditorReading: 'Tiếp tục đọc trong editor',
stopEditorReading: 'Dừng đọc trong editor',
manualCheckpointUnavailable: 'Phiên đọc trong editor không còn khả dụng. Hãy bắt đầu lại.',
manualCheckpointFailed: 'Không thể tạm dừng đọc trong editor. Chưa bắt đầu đọc web.',

// en
manualReaderLabel: 'Text being read',
manualPausedForWeb: 'Editor reading is paused while web reading plays.',
resumeEditorReading: 'Resume editor reading',
stopEditorReading: 'Stop editor reading',
manualCheckpointUnavailable: 'Editor reading is no longer available. Start it again.',
manualCheckpointFailed: 'Unable to pause editor reading. Web reading was not started.',
```

- [x] **Step 4: Run focused unit tests to verify they pass**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_playback.test.ts tests/unit/manual_text.test.ts tests/unit/playback_state.test.ts tests/unit/theme_i18n.test.ts
```

Expected: PASS; all manual snapshots contain only metadata, and both language maps expose every new key.

- [x] **Step 5: Commit the contract boundary**

```bash
git add src/shared/manual_playback.ts src/shared/types.ts src/background/manual_text.ts src/background/playback_state.ts src/shared/constants.ts tests/unit/manual_playback.test.ts tests/unit/manual_text.test.ts tests/unit/playback_state.test.ts tests/unit/theme_i18n.test.ts
git commit -m "feat: add manual playback ownership contracts"
```

### Task 2: Build a safe reader-word range helper

**Files:**
- Create: `src/sidepanel/manual_word_highlight.ts`
- Create: `tests/unit/manual_word_highlight.test.ts`

**Interfaces:**
- Consumes `ManualWordHighlightMessage` from Task 1.
- Produces `ManualWordRange`, `ManualHighlightCursor`, `ManualHighlightAdvanceResult`, and `advanceManualHighlight()` for `App.tsx`.
- Does not use browser APIs so repeated-word and stale-event behavior remains unit-testable.

- [x] **Step 1: Write failing reader matching tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceManualHighlight, createManualHighlightCursor } from '../../src/sidepanel/manual_word_highlight.ts';

test('maps repeated words monotonically instead of returning the first duplicate', () => {
	const cursor = createManualHighlightCursor('The cat saw the cat.');
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'cat', wordIndex: 1 }), { kind: 'matched', range: { start: 4, end: 7 } });
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'cat', wordIndex: 3 }), { kind: 'matched', range: { start: 16, end: 19 } });
});

test('distinguishes a stale duplicate from an unmatched newer word', () => {
	const cursor = createManualHighlightCursor('One two');
	advanceManualHighlight(cursor, { word: 'One', wordIndex: 0 });
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'One', wordIndex: 0 }), { kind: 'stale' });
	assert.deepEqual(advanceManualHighlight(cursor, { word: 'Three', wordIndex: 2 }), { kind: 'unmatched' });
});
```

- [x] **Step 2: Run the helper tests to verify they fail**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_word_highlight.test.ts
```

Expected: FAIL with module-not-found for `manual_word_highlight.ts`.

- [x] **Step 3: Implement normalized, bounded matching**

```ts
export type ManualWordRange = { start: number; end: number };

export type ManualHighlightAdvanceResult =
	| { kind: 'matched'; range: ManualWordRange }
	| { kind: 'stale' }
	| { kind: 'unmatched' };

export type ManualHighlightCursor = {
	text: string;
	nextOffset: number;
	lastWordIndex: number;
};

export function createManualHighlightCursor(text: string): ManualHighlightCursor {
	return { text, nextOffset: 0, lastWordIndex: -1 };
}

export function advanceManualHighlight(
	cursor: ManualHighlightCursor,
	event: { word: string; wordIndex: number },
): ManualHighlightAdvanceResult {
	if (event.wordIndex <= cursor.lastWordIndex) return { kind: 'stale' };
	const start = cursor.text.indexOf(event.word, cursor.nextOffset);
	cursor.lastWordIndex = event.wordIndex;
	if (start < 0) return { kind: 'unmatched' };
	const end = start + event.word.length;
	cursor.nextOffset = end;
	return { kind: 'matched', range: { start, end } };
}
```

Before completing the implementation, replace the illustrative `indexOf` comparison with the existing NFC/NFD variants and Unicode word-boundary rules from `src/content/word_highlight.ts`. Preserve multi-token original word-map entries such as `20/05` or `1.000 USD`; if no exact bounded occurrence remains for a newer event, return `unmatched` and do not search before `nextOffset`. Duplicate indices return `stale` without mutating the cursor.

- [x] **Step 4: Run the helper tests to verify they pass**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_word_highlight.test.ts
```

Expected: PASS for duplicate words, NFD/NFC variants, multi-token source entries, stale-index retention, and newer no-match clearing.

- [x] **Step 5: Commit the isolated matcher**

```bash
git add src/sidepanel/manual_word_highlight.ts tests/unit/manual_word_highlight.test.ts
git commit -m "feat: match manual spoken words in order"
```

### Task 3: Model memory-only manual audio checkpoints

**Files:**
- Create: `src/offscreen/manual_checkpoint.ts`
- Create: `tests/unit/manual_checkpoint.test.ts`
- Modify: `src/offscreen/word_timing.ts`
- Modify: `tests/unit/word_timing.test.ts`

**Interfaces:**
- Consumes manual session owner metadata from Task 1 and `SpeechUnit`/`WordTimingWindow` data already used by offscreen playback.
- Produces `ManualCheckpoint`, `captureManualCheckpoint()`, `isCheckpointOwner()`, and `resumeOffsetSeconds()` for Task 4.
- Extends word timing windows with a stable `wordIndex` so resume and duplicate words cannot be confused.

- [x] **Step 1: Write failing checkpoint and word-index tests**

```ts
test('captures only a matching manual session at the current buffer offset', () => {
	const checkpoint = captureManualCheckpoint({
		sessionId: 'manual-1',
		panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd',
		unitIndex: 2,
		bufferDurationSec: 4,
		elapsedSec: 1.25,
		wordIndex: 11,
	});
	assert.equal(checkpoint.sourceOffsetSec, 1.25);
	assert.equal(isCheckpointOwner(checkpoint, 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd'), true);
});

test('clamps a capture offset to the current decoded buffer duration', () => {
	assert.equal(resumeOffsetSeconds({ bufferDurationSec: 2, elapsedSec: 5 }), 2);
});
```

Extend `tests/unit/word_timing.test.ts` to expect `{ text, wordIndex, startSec, endSec }` and verify a resumed elapsed offset selects the same `wordIndex`.

- [x] **Step 2: Run the checkpoint tests to verify they fail**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_checkpoint.test.ts tests/unit/word_timing.test.ts
```

Expected: FAIL because checkpoint functions and `wordIndex` are absent.

- [x] **Step 3: Implement the checkpoint model without any storage dependency**

```ts
export type ManualCheckpoint = {
	sessionId: string;
	panelInstanceId: string;
	unitIndex: number;
	sourceOffsetSec: number;
	wordIndex: number;
	bufferDurationSec: number;
};

export function resumeOffsetSeconds(input: { bufferDurationSec: number; elapsedSec: number }): number {
	return Math.min(Math.max(input.elapsedSec, 0), input.bufferDurationSec);
}

export function isCheckpointOwner(checkpoint: ManualCheckpoint | null, panelInstanceId: string): boolean {
	return checkpoint?.panelInstanceId === panelInstanceId;
}

export function captureManualCheckpoint(input: {
	sessionId: string;
	panelInstanceId: string;
	unitIndex: number;
	bufferDurationSec: number;
	elapsedSec: number;
	wordIndex: number;
}): ManualCheckpoint {
	return {
		sessionId: input.sessionId,
		panelInstanceId: input.panelInstanceId,
		unitIndex: input.unitIndex,
		sourceOffsetSec: resumeOffsetSeconds(input),
		wordIndex: input.wordIndex,
		bufferDurationSec: input.bufferDurationSec,
	};
}
```

Keep this module free of `chrome`, `AudioContext`, and storage calls. The runtime-only checkpoint object in Task 4 adds `AudioBuffer`, prepared units, language, voice style, speed, and synthesis leases around this tested metadata.

- [x] **Step 4: Run focused checkpoint tests to verify they pass**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_checkpoint.test.ts tests/unit/word_timing.test.ts
```

Expected: PASS; offsets never exceed the buffer, owners are strict, and word timing remains stable after resume.

- [x] **Step 5: Commit checkpoint primitives**

```bash
git add src/offscreen/manual_checkpoint.ts src/offscreen/word_timing.ts tests/unit/manual_checkpoint.test.ts tests/unit/word_timing.test.ts
git commit -m "feat: model manual playback checkpoints"
```

### Task 4: Add offscreen checkpoint, resume, and manual-word commands

**Files:**
- Modify: `src/offscreen/offscreen.ts:18-508`
- Modify: `src/offscreen/supertonic_helper.ts`
- Modify: `src/offscreen/word_timing.ts`
- Modify: `src/background/offscreen_transport.ts`
- Modify: `tests/unit/supertonic_duration.test.ts`
- Modify: `tests/unit/word_timing.test.ts`
- Modify: `tests/unit/offscreen_transport.test.ts`
- Modify: `tests/unit/synthesis_coordinator.test.ts`

**Interfaces:**
- Consumes `ManualCheckpoint` and word indices from Task 3.
- Produces offscreen commands `CHECKPOINT_MANUAL`, `RESUME_MANUAL_CHECKPOINT`, `DISCARD_MANUAL_CHECKPOINT`, and `GET_MANUAL_CHECKPOINT_METADATA`.
- Produces internal `OFFSCREEN_MANUAL_WORD_TIMING { sessionId, word, wordIndex }` only while a manual source is audible.
- Produces model-informed word windows from one cumulative-prefix duration-predictor batch, scaled to decoded spoken duration with heuristic fallback.

- [x] **Step 1: Write failing checkpoint and model-timing tests**

```ts
test('accepts a successful checkpoint response with non-content metadata', async () => {
	const response = await sendOffscreenCommand(
		{ action: 'CHECKPOINT_MANUAL', payload: { sessionId: 'manual-1', panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' } },
		async () => ({ success: true, checkpoint: { sessionId: 'manual-1', panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' } }),
	);
	assert.equal(response.success, true);
});

test('treats an unsuccessful checkpoint as a failed precondition', async () => {
	assert.deepEqual(await sendOffscreenCommand({ action: 'CHECKPOINT_MANUAL' }, async () => ({ success: false })), { success: false });
});
```

Add `tests/unit/word_timing.test.ts` cases that pass `[1, 2]` model weights
for a six-second two-word buffer and expect windows `[0, 2]` and `[2, 6]`.
Assert a wrong count, `NaN`, or zero falls back to the existing heuristic.

Add the exact Markdown/mixed-language regression at the predictor seam:

```ts
test('predicts cumulative contextual prefixes instead of isolated words', async () => {
	const text = '**Channel Activity Analysis (4.6.6):** Phân tích hoạt động kênh';
	const wordMap = [
		{ text: 'Channel', start: 2, end: 9 },
		{ text: 'Activity', start: 10, end: 18 },
		{ text: 'Analysis', start: 19, end: 27 },
	];
	const weights = await predictSpokenWordDurations(text, wordMap, async (prefixes) => {
		assert.deepEqual(prefixes, ['**Channel', '**Channel Activity', '**Channel Activity Analysis']);
		return [0.5, 1, 1.5];
	});
	assert.deepEqual(weights, [0.5, 0.5, 0.5]);
});
```

Assert an empty prefix, wrong count, non-finite value, non-positive first total,
or non-increasing later total returns `undefined` so the whole unit falls back.

Add `tests/unit/supertonic_duration.test.ts` with a fake duration session. Its
two-text batch must receive `style_dp` dimensions `[2, ...originalDims]`, repeat
the source data twice, return one duration per text, and divide each result by
speed exactly once.

- [x] **Step 2: Run focused transport tests to verify they fail**

Run:

```bash
node --experimental-strip-types --test tests/unit/offscreen_transport.test.ts tests/unit/synthesis_coordinator.test.ts tests/unit/word_timing.test.ts tests/unit/supertonic_duration.test.ts
```

Expected for the cumulative-prefix correction: FAIL because the Markdown
regression receives isolated words instead of contextual prefixes. Existing
checkpoint, transport, and duration-only API tests remain green.

- [x] **Step 3: Refactor offscreen active state around a resumable manual source**

Implement these invariants in `offscreen.ts`:

```ts
type RuntimeManualCheckpoint = ManualCheckpoint & {
	lang: string;
	style: Style;
	speed: number;
	speechUnits: SpeechUnit[];
	buffer: AudioBuffer;
};

let manualCheckpoint: RuntimeManualCheckpoint | null = null;
let currentBuffer: AudioBuffer | null = null;
let currentBufferStartedAt = 0;
let currentBufferOffsetSec = 0;
let currentWordIndex = 0;
```

Replace the current destructive `stopAudio()` call at a web start with a
branch that captures manual playback when the active extension session is
manual. It must stop/disconnect only the manual source, clear its timer, retain
the prepared units and decoded current buffer in `manualCheckpoint`, and leave
the offscreen document open. It must clear synthesis leases only when the
checkpoint is discarded.

Make `playAudioBuffer()` accept `offsetSec` and `firstWordIndex`, call
`source.start(0, offsetSec)`, and start the word timer from that offset. When a
manual checkpoint resumes, restore its units and buffer, recreate its source at
`sourceOffsetSec`, and emit manual word events with monotonic indices. Keep the
existing generic word events for Article/selection sessions unchanged.

Expose `TextToSpeech.predictDurations()` by reusing the duration-predictor input
preparation from `_infer()`. Repeat the single `style_dp` tensor across the word
batch, apply speed once, and do not run the encoder, diffusion loop, or vocoder.
For each word-map entry, predict the contextual prefix from
`unit.text.slice(0, end)`. The duration model returns a total utterance duration
for each prefix; convert strictly increasing totals into positive word weights
by subtracting the previous total. Associate valid weights with the decoded
buffer in a `WeakMap`, then pass them to
`computeWordTimings(wordMap, spokenDurationSec, predictedDurations)`. A thrown
prediction, empty prefix, wrong count, non-finite value, non-positive first
total, or non-increasing later total must make the whole unit use the previous
deterministic heuristic without stopping synthesis.

Add runtime handlers with exact success/failure replies:

```ts
case 'CHECKPOINT_MANUAL':
	return respondWithCheckpoint(payload, sendResponse);
case 'RESUME_MANUAL_CHECKPOINT':
	return respondWithManualResume(payload, sendResponse);
case 'DISCARD_MANUAL_CHECKPOINT':
	discardManualCheckpoint();
	sendResponse({ success: true });
	break;
case 'GET_MANUAL_CHECKPOINT_METADATA':
	sendResponse(manualCheckpoint ? { success: true, checkpoint: metadata(manualCheckpoint) } : { success: false });
	break;
```

Reject a checkpoint whose session ID or owner does not match the active manual
source. Never send speech units, buffer data, normalized text, or original text
in any command response.

- [x] **Step 4: Run focused unit tests to verify they pass**

Run:

```bash
node --experimental-strip-types --test tests/unit/manual_checkpoint.test.ts tests/unit/offscreen_transport.test.ts tests/unit/synthesis_coordinator.test.ts tests/unit/word_timing.test.ts tests/unit/supertonic_duration.test.ts
```

Expected: PASS; stale synthesis cannot revive discarded audio, checkpoint
commands expose metadata only, valid cumulative-prefix deltas control windows,
and invalid prediction data falls back without affecting playback.

- [x] **Step 5: Commit the offscreen checkpoint runtime**

```bash
git add src/offscreen/offscreen.ts src/offscreen/supertonic_helper.ts src/offscreen/word_timing.ts src/background/offscreen_transport.ts tests/unit/offscreen_transport.test.ts tests/unit/synthesis_coordinator.test.ts tests/unit/word_timing.test.ts tests/unit/supertonic_duration.test.ts
git commit -m "feat: checkpoint manual audio in offscreen"
```

### Task 5: Coordinate web preemption and owner-scoped cleanup in background

**Files:**
- Modify: `src/background/background.ts:28-700`
- Modify: `src/shared/playback_client.ts`
- Modify: `tests/e2e/reading-state.spec.ts`
- Modify: `tests/e2e/fixtures.ts`

**Interfaces:**
- Consumes shared messages from Task 1 and offscreen checkpoint responses from Task 4.
- Produces `MANUAL_CHECKPOINT_STATE_UPDATE` for the Side Panel and converts each validated internal timing event into one public manual highlight update.
- Leaves the existing tab `WORD_HIGHLIGHT_UPDATE`/`WORD_HIGHLIGHT_CLEAR` relay unchanged.

- [x] **Step 1: Add failing coordinator regressions**

Add real service-worker tests in `tests/e2e/reading-state.spec.ts` for these message sequences:

```ts
// manual active -> validated web start
await sendBackgroundMessage(controlPage, { action: 'START_MANUAL_TEXT', payload: manualPayload });
await sendBackgroundMessage(controlPage, { action: 'START_CURRENT_PAGE' });
// expect the manual checkpoint state message before the tab playback state

// active web + valid manual checkpoint -> resume
await sendBackgroundMessage(controlPage, { action: 'RESUME_MANUAL_CHECKPOINT', panelInstanceId: manualPayload.panelInstanceId });
// expect tab session cleared, manual session restored with its original sessionId
```

Use the extension's existing mocked article/offscreen test harness. Assert that
the checkpoint protocol response is consumed before a web `PLAY` command and
that a failed checkpoint leaves the manual session active.

- [x] **Step 2: Run the background regression to verify it fails**

Run:

```bash
CI=true pnpm exec playwright test tests/e2e/reading-state.spec.ts --grep "manual checkpoint|resume manual|owner cleanup" --retries=0
```

Expected: FAIL because `startPlayback()` always calls `stopActiveSession()`.

- [x] **Step 3: Implement preemption instead of destructive replacement**

Split the current replacement path into explicit operations:

```ts
async function preemptManualForWeb(): Promise<CommandResponse> {
	const manual = activeSession;
	if (manual?.contentScope !== 'manual') return { success: true };
	const panelInstanceId = manual.source.panelInstanceId;
	const response = await sendOffscreenCommand(
		{ action: 'CHECKPOINT_MANUAL', payload: { sessionId: manual.sessionId, panelInstanceId } },
		(message) => chrome.runtime.sendMessage(message),
	);
	if (!response.success) return { success: false, error: 'manualCheckpointFailed' };
	await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
	activeSession = null;
	await broadcastSession(null);
	await chrome.runtime.sendMessage({ action: 'MANUAL_CHECKPOINT_STATE_UPDATE', panelInstanceId, state: 'suspended' });
	return { success: true };
}
```

Correct the implementation so it captures `panelInstanceId` before assigning
`activeSession = null`. Make tab starts call `preemptManualForWeb()` only after
Article extraction has succeeded. If extraction is invalid or restricted,
return its existing error without interrupting manual audio.

Store no checkpoint content in background. When a resume arrives after a
service-worker restart, ask offscreen for metadata using
`GET_MANUAL_CHECKPOINT_METADATA`; only then restore the returned manual
snapshot as active and issue `RESUME_MANUAL_CHECKPOINT`. A normal web Stop must
not close offscreen while a checkpoint exists.

Add owner-verified handlers:

```ts
case 'RESUME_MANUAL_CHECKPOINT':
	return respondFromQueue(() => resumeManualCheckpoint(msg.panelInstanceId), sendResponse);
case 'DISCARD_MANUAL_CHECKPOINT':
	return respondFromQueue(() => discardManualCheckpoint(msg.panelInstanceId), sendResponse);
case 'STOP_SIDE_PANEL_AUDIO':
	return respondFromQueue(() => stopSidePanelAudio(msg.panelInstanceId), sendResponse);
case 'OFFSCREEN_MANUAL_WORD_TIMING':
	void enqueue(() => relayManualWordHighlight(msg));
	break;
```

The relay must validate the internal action, non-empty session/word fields,
non-negative integer index, and active manual session ID. A real-extension E2E
must assert that one internal timing event produces exactly one public
`MANUAL_WORD_HIGHLIGHT_UPDATE`.

`stopSidePanelAudio()` must stop the active web source too when that owner has a
suspended manual checkpoint, discard the checkpoint, clear the manual reader,
and close offscreen. A stale owner must return success without changing audio.

- [x] **Step 4: Run coordinator regressions to verify they pass**

Run:

```bash
CI=true pnpm exec playwright test tests/e2e/reading-state.spec.ts --grep "manual checkpoint|resume manual|owner cleanup" --retries=0
```

Expected: PASS; manual audio is checkpointed before web starts, explicit resume restores it, and stale cleanup is inert.

- [x] **Step 5: Commit background coordination**

```bash
git add src/background/background.ts src/shared/playback_client.ts tests/e2e/reading-state.spec.ts tests/e2e/fixtures.ts
git commit -m "feat: preempt manual playback for web reading"
```

### Task 6: Render the locked manual reader and lifecycle controls

**Files:**
- Modify: `src/sidepanel/App.tsx:1-280`
- Modify: `src/sidepanel/sidepanel.css:1-250`
- Modify: `tests/e2e/side-panel.spec.ts`

**Interfaces:**
- Consumes contracts from Task 1, range helper from Task 2, and checkpoint state events from Task 5.
- Produces owner-scoped `START_MANUAL_TEXT`, `RESUME_MANUAL_CHECKPOINT`, `DISCARD_MANUAL_CHECKPOINT`, and `STOP_SIDE_PANEL_AUDIO` messages.

- [x] **Step 1: Write failing Side Panel reader tests**

Add tests that drive the existing runtime mock:

```ts
test('replaces the textarea with a locked reader and highlights manual words even when webpage highlighting is off', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' }).fill('The cat saw the cat.');
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	await page.evaluate(() => {
		const event = { action: 'MANUAL_WORD_HIGHLIGHT_UPDATE', sessionId: 'manual-session', word: 'cat', wordIndex: 1 };
		(window as any).mockReceiveMessage(event);
		(window as any).mockReceiveMessage(event);
	});
	await expect(page.getByRole('textbox', { name: 'Văn bản đang đọc' })).toHaveAttribute('aria-readonly', 'true');
	await expect(page.locator('.manual-reader-active-word')).toHaveText('cat');
});

test('sends owner-scoped cleanup on pagehide and clears the draft on reload', async ({ page, openSidePanel }) => {
	// start manual, dispatch pagehide, assert STOP_SIDE_PANEL_AUDIO contains the start payload owner ID
});
```

Also replace the existing reload assertion that manual playback hydrates. It
must now assert that `STOP_SIDE_PANEL_AUDIO` was sent, the draft is empty after
reload, and no manual reader is rendered.

- [x] **Step 2: Run Side Panel tests to verify they fail**

Run:

```bash
CI=true pnpm exec playwright test tests/e2e/side-panel.spec.ts --grep "locked reader|pagehide|checkpoint|reload" --retries=0
```

Expected: FAIL because the UI still renders an editable textarea through manual playback and has no owner cleanup.

- [x] **Step 3: Implement reader rendering, auto-scroll, and controls**

Use document-local React state only:

```tsx
const [panelInstanceId] = useState(() => crypto.randomUUID());
const [manualReaderText, setManualReaderText] = useState<string | null>(null);
const [manualCheckpointSessionId, setManualCheckpointSessionId] = useState<string | null>(null);
const readerRef = useRef<HTMLDivElement>(null);

const manualReaderLocked = manualReaderText !== null;
```

After a successful manual start, save the accepted local text snapshot and send
`panelInstanceId` with the existing text/language payload. Render this instead
of the textarea while locked:

```tsx
<div ref={readerRef} className="manual-reader" role="textbox" aria-label={t('manualReaderLabel')} aria-readonly="true">
	{manualReaderText}
</div>
```

On every accepted `MANUAL_WORD_HIGHLIGHT_UPDATE`, use Task 2's result. Render a
`matched` range with the Side Panel-only `<mark>` element, ignore `stale` without
a React state write, and clear only `unmatched` newer events. Minimally adjust
`readerRef.current.scrollTop` when the mark is above or below the visible reader
rectangle. Never make this container an `aria-live` region.

Disable language, Clear, and Read while reader-locked. Keep ordinary Pause and
Stop player controls. On manual Stop/error/discard, remove the active mark,
set `manualReaderText` and checkpoint state to `null`, and retain the textarea
draft unless `pagehide`/reload is occurring.

When background broadcasts suspended checkpoint state, keep the reader locked,
show `t('manualPausedForWeb')`, and render localized Resume/Stop editor buttons.
Resume sends the owner-scoped control; Stop editor discards only the checkpoint.
Register a `pagehide` listener in an effect that sends
`STOP_SIDE_PANEL_AUDIO` without awaiting a response. It must not run merely
because React unmounts or the active browser tab changes.

Add `.manual-reader`, `.manual-reader-active-word`, `.manual-checkpoint-actions`,
and theme-specific border/background rules to `sidepanel.css`. Preserve 12px
rounded Default/WMP styling and 0px Winamp styling already applied to textarea.

- [x] **Step 4: Run focused UI regressions to verify they pass**

Run:

```bash
CI=true pnpm build
CI=true pnpm exec playwright test tests/e2e/side-panel.spec.ts --retries=0
```

Expected: PASS; the reader locks during manual playback, duplicate delivery
retains one stable mark, exact repeated words advance, auto-scroll is
observable, all new labels are localized, and reload sends cleanup rather than
hydrating manual audio.

- [x] **Step 5: Commit the Side Panel UI**

```bash
git add src/sidepanel/App.tsx src/sidepanel/sidepanel.css tests/e2e/side-panel.spec.ts
git commit -m "feat: highlight pasted text in side panel"
```

### Task 7: Verify privacy, complete regressions, and align documentation

**Files:**
- Modify: `tests/e2e/free-tier.spec.ts`
- Modify: `tests/e2e/reading-state.spec.ts`
- Modify: `docs/specs/2026-07-19-side-panel-manual-text-design.md`
- Modify: `docs/PRD.md`
- Modify: `docs/privacy-policy.md`
- Modify: `docs/RELEASING.md`

**Interfaces:**
- Consumes the complete behavior from Tasks 1-6.
- Produces the release documentation and regression evidence for the changed Side Panel lifecycle.

- [x] **Step 1: Add failing privacy and lifecycle regression cases**

Extend `tests/e2e/free-tier.spec.ts` with a manual-text sentinel through these
states: manual playing, checkpointed while web is active, web stopped while the
checkpoint remains, resumed manual, discarded manual, and `pagehide` cleanup.
For every state, assert that the sentinel is absent from `chrome.storage.local`,
`chrome.storage.session`, `window.localStorage`, and `window.sessionStorage`.

Add an owner-race test in `reading-state.spec.ts`:

```ts
await sendBackgroundMessage(controlPage, { action: 'STOP_SIDE_PANEL_AUDIO', panelInstanceId: 'bcb0bf1d-6e0f-4dd2-9b41-cc5bb2deac8f' });
expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(webSessionId);
```

The fixture must prove that a non-owner cannot stop web audio or destroy the
manual checkpoint.

- [x] **Step 2: Run the new regressions to verify they fail**

Run:

```bash
CI=true pnpm exec playwright test tests/e2e/free-tier.spec.ts tests/e2e/reading-state.spec.ts --grep "manual checkpoint|owner|pasted|reload" --retries=0
```

Expected: FAIL until cleanup, storage checks, and owner isolation are complete.

- [x] **Step 3: Update documentation with the shipped behavior**

Make the following exact documentation changes:

- Replace the older claim in `docs/specs/2026-07-19-side-panel-manual-text-design.md` that manual audio survives Side Panel reload/close with: close/reload stops owned audio and discards all document-local manual state.
- In `docs/PRD.md`, state that Side Panel pasted text receives local spoken-word highlighting and can be explicitly resumed after a web-reading preemption while the same Side Panel remains open.
- In `docs/privacy-policy.md`, preserve the no-persisted-text claim and clarify that a decoded checkpoint may exist only in live extension memory until it is resumed, discarded, or the Side Panel closes/reloads.
- In `docs/RELEASING.md`, add a manual QA item for English/Vietnamese labels, locked reader highlight, web preemption/resume, and close/reload audio cleanup.

- [x] **Step 4: Run the full verification sequence**

Run sequentially:

```bash
CI=true pnpm test:unit
CI=true pnpm build
pnpm validate:manifest
CI=true pnpm exec playwright test tests/e2e/side-panel.spec.ts tests/e2e/word-highlight.spec.ts tests/e2e/reading-state.spec.ts tests/e2e/free-tier.spec.ts --retries=0
CI=true pnpm test:e2e
rtk git diff --check
```

Expected: every command exits `0`; no storage assertion contains the pasted
sentinel; the manifest permission boundary is unchanged; full extension
behavior remains green.

- [x] **Step 5: Commit documentation and final regression coverage**

```bash
git add tests/e2e/free-tier.spec.ts tests/e2e/reading-state.spec.ts docs/specs/2026-07-19-side-panel-manual-text-design.md docs/PRD.md docs/privacy-policy.md docs/RELEASING.md
git commit -m "docs: document side panel manual playback lifecycle"
```

### Task 8: Correct rejected normalization spans and prove the real first highlight

**Files:**
- Modify: `src/offscreen/vietnamese/normalizer.ts`
- Modify: `tests/unit/vietnamese_normalizer.test.ts`
- Modify: `tests/e2e/side-panel.spec.ts`
- Modify: `docs/specs/2026-07-22-side-panel-manual-highlight-design.md`
- Modify: `docs/plans/2026-07-22-side-panel-manual-highlight.md`

**Root cause:** The production CRF classified `Channel Activity Analysis (` as
one abbreviation candidate. When abbreviation expansion rejected that span,
the normalizer restored the source text but still emitted one grouped word-map
entry. Offscreen therefore produced `word="Channel Activity Analysis ("` as
its first timing event; the bounded Side Panel matcher correctly rejected that
unmatchable target, so the first visible mark became the later `4.6`.

- [x] **Step 1: Reproduce with the real extension, cached Supertonic model, decoded audio clock, runtime messages, and DOM mutations**

The failing trace must show a grouped first event, no corresponding DOM mark,
and `4.6` as the first rendered mark. Mock-only playback tests are insufficient
for this gate.

- [x] **Step 2: Add a failing normalizer regression for the reported mixed Markdown text**

Simulate the observed multi-token `LABB` classification and require the first
word-map entries to be `Channel`, `Activity`, and `Analysis` rather than a
single grouped span.

- [x] **Step 3: Split only rejected spans back into non-punctuation source tokens**

Keep accepted expansions grouped to their original source span. When
`piece === source`, emit each source token with its individual original and
spoken offsets, excluding punctuation exactly as the ordinary token path does.

- [x] **Step 4: Add a normalizer-to-Side-Panel Playwright regression**

Use the exact reported text, run it through the production normalizer with the
captured CRF label shape, deliver its first runtime word event, and assert that
the locked reader highlights `Channel`.

- [x] **Step 5: Re-run the real-runtime harness and focused verification**

Require both the first public event and first DOM mark to be `Channel`, then
run the complete unit suite, production build, and focused Side Panel plus
webpage-highlight Playwright suites.

## Plan self-review

### Spec coverage

- Locked textarea/reader modes, automatic visibility scrolling, always-on manual highlighting, and English/Vietnamese labels are Task 6 and Task 1.
- Owner metadata without persisted raw text is Task 1; memory-only audio checkpoint is Tasks 3 and 4.
- Web preemption, exact manual resume, no auto-resume, manual discard, service-worker recovery metadata, and Side Panel close/reload cleanup are Task 5.
- Duplicate-word safety, stale-message retention, single-owner public delivery,
  cumulative-prefix timing, whole-unit fallback, and resumed timing indices are
  Tasks 2-5.
- Rejected normalization spans, the exact mixed-Markdown first-word failure,
  and a real-model playback gate are Task 8.
- Empty input, checkpoint failure, lost checkpoint, stale owner, reload, privacy sentinel, manifest, and full-suite coverage are Tasks 5 and 7.
- Existing design, PRD, privacy, and release guidance are updated in Task 7.

### Placeholder and type check

- Every implementation task names exact files, exposed interfaces, a failing test, a focused command, minimal implementation shape, a passing command, and a commit.
- `panelInstanceId`, `ManualCheckpoint`, `wordIndex`,
  `OFFSCREEN_MANUAL_WORD_TIMING`, `MANUAL_WORD_HIGHLIGHT_UPDATE`, checkpoint
  control actions, and localization keys use the same names throughout this plan.
- No step writes pasted text into storage or proposes a second active audio source.
