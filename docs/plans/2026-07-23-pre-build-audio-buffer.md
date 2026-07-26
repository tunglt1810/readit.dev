# Pre-build Audio Buffer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the silent gap between `SpeechUnit` items during TTS playback.

**Spec:** [2026-07-23-pre-build-audio-buffer-design.md](file:///Users/bez/Workspace/repos/bez/readit.dev/docs/specs/2026-07-23-pre-build-audio-buffer-design.md)

## Outcome: the premise was wrong (2026-07-26)

**This plan solved a problem that did not exist.** Phase 0 instrumentation measured the real
playback, and every task below was either disproved or made unnecessary. The plan is kept as a
record of how the wrong target was chosen, not as work to execute.

What the measurement actually showed:

| Metric | Measured | What it disproved |
| --- | --- | --- |
| `gapMaxMs` | 5.1 ms | There was no gap between units. Task 1 (pre-schedule) had nothing to fix. |
| `callbackLatenessMaxMs` | 5.1 ms | `onended` was not running late. |
| `executionProvider` | `webgpu` | Task 2 (`proxy=true`) was moot — inference was not on the WASM main-thread path. |
| `synthToAudioRatio` | 0.12 – 0.28 | Synthesis had 4–8× headroom. Deeper buffering could not help. |
| `unitSequence` | `[0,1,2,3,4,5,6]`, zero `droppedStarts` | The playback scheduler never skipped or repeated a unit. |
| Segmentation probe | p50 158 chars, max 196, 0 mid-sentence cuts | Units were not oversized or truncated. |
| `predictMaxMs` vs `inferMaxMs` | **8 179 ms** vs **985 ms** | The actual defect. |

**Root cause: 89% of synthesis time was spent computing word-highlight positions.**

`predictSpokenWordDurations` asked the duration model for the length of every cumulative prefix of
a unit — one ONNX pass per word — to derive per-word timings by differencing. `UnicodeProcessor.call`
pads a batch to its longest row, so N prefixes of a unit L characters long became an `N × L` tensor
against the `L` the audio itself needed. At ~34 words per unit that is ~34× the work of synthesis,
for highlight positions rather than sound.

Two further defects in the same mechanism, now moot: `preprocessText` appends a period to every
prefix, so each was predicted as a complete sentence including sentence-final lengthening, making
the differenced weights systematically wrong toward the end of a unit (`highlightDriftMaxMs` 253 ms).

**Fix applied:** deleted the prediction chain. `computeWordTimings` now always uses
`estimateSpeakingWeight`, the syllable-count estimator that was already the fallback whenever
prediction failed — so this is a deletion, not new code. Expected synthesis cost drops from
6.7–9.1 s to ~0.9 s per unit. Word highlighting is less precise, accepted as the trade.

**Second root cause, found after the fix above: the duration predictor is not calibrated for
Vietnamese.** Measured directly by rendering through the real engine: 0.428 s per Vietnamese
syllable against 0.429 s per English word, where real Vietnamese speech runs about 0.19 s per
syllable. The `<vi>` tag does reach the model but moves the prediction only ~10% (`vi` 18.33 s,
`en` 16.60 s, `na` 17.40 s on identical text) — nowhere near the 2.3× needed.

`sampleNoisyLatent` sizes the latent from that prediction, so the vector estimator receives ~2.3×
the frames the text can fill. Being non-autoregressive it cannot speak slower to compensate; it
emits leading silence, races the text, then re-decodes a span it has already produced. Confirmed by
ear: the same phrase came back twice **with a different tone the first time** — a re-decode under
different latent noise, not duplicated data. "Missing words" and "repeated words" were never two
bugs; both are the over-long latent.

**Fix applied:** `durationScaleForLanguage` in `src/offscreen/supertonic_helper.ts`, held separate
from the user's speed setting so the speed control means the same thing in every language. Vietnamese
is set to 1.6, chosen by listening to one unit rendered across a range of scales.

**Follow-on: sentence pauses were being compressed with the speech.** The duration scale above
shrinks everything inside the model's predicted duration, including the pauses it produces at
punctuation. Only a pause at a unit boundary escapes it, because `appendSilenceSamples` adds that
one after synthesis. Measured on a real article: 5 of 9 sentence endings fell inside a unit, so
most sentence pauses were being shortened by the same lever that fixed the audio.

`planTextSegments` previously emitted the whole remaining text as one unit whenever it fit under
`hardMax`, regardless of how many sentences it contained. It now also ends a unit at a sentence when
both sides clear `interiorSplitMinLength` (60 characters for Latin). On the same article: 10 units
instead of 6, p50 100 characters instead of 229, and sentence endings inside a unit dropped from
5 to 1 — the survivor is a 41-character sentence, too short to stand alone.

Open, needs a listening check: pauses at unit boundaries now measure 1.4–1.6 s against ~0.4 s for
the one still inside a unit. Most of that is the model's own trailing silence, not the appended
`pauseAfterMs` (180–260 ms). If it sounds too long, the fix is to trim the trailing silence in
`synthesizeSpeechUnitSamples` and let `LATIN_PAUSE_MS` set the pause outright — but those constants
would then have to be retuned by ear, so it is not worth doing on speculation.

**Task 4 was aimed at the wrong allocation.** Dropping the WAV round-trip in favour of building the
AudioBuffer directly was measured back-to-back against the old path, same process, same units: peak
JS heap 177.7 MB against 179.4 MB. No difference, even though the old path allocated roughly 45 MB
more garbage across the run. The peak is reached inside `engine.call`, before the audio chain runs
at all.

Where it actually was: peak heap scales with the denoising step count — 15.8 MB at 2 steps, 36.6 MB
at 4, 51.4 MB at 8, about 6 MB per step. `_infer` was unpacking the denoiser's flat output into
nested JS arrays and flattening them again on the next iteration, allocating the whole latent about
four times per step (`xt.flat(2)`, its `Float32Array` copy, `Array.from(denoised)`, the nested
rebuild) — roughly `28 × bsz × latentDim × latentLen` bytes each step, for a round-trip that
reproduces the array it started from.

Both are now fixed: `sampleNoisyLatent` builds the latent flat and row-major, the loop feeds the
denoiser's own output straight back in, `_infer` returns the vocoder's `Float32Array` rather than a
`number[]` copy, and `createSpeechAudioBuffer` writes it into an AudioBuffer sized to include the
pause as its zero tail. `writeWavFile` and `appendSilenceSamples` are gone. Removing the 16-bit WAV
also keeps the signal in float32 end to end.

Verifying the latent change: a wrong stride would still produce the right number of samples, so
sample count proves nothing. Compared instead against a render from before the change — RMS 0.0515
vs 0.0505, zero crossings 2 428/s vs 2 516/s, silence 54% vs 56%, pauses 1.52/s vs 1.45/s. White
noise would cross zero about 22 000 times a second and hold no pauses.

Honest reading of the numbers: peak sampling is noisy (two runs at 8 steps gave 31.2 MB and
52.5 MB), so trust the deterministic accounting of what was deleted — about 8 MB per ten-second unit
from the denoising loop and about 9 MB from the audio chain — over any single peak figure.

Method note: this was settled by building the offscreen entry against a throwaway probe and driving
it with the real models under Playwright, then writing WAVs out to listen to. Synthesizing the units
forward and then in reverse produced byte-identical sample counts, which killed the accumulated-state
hypothesis before any code was changed. Two earlier hypotheses in this document died the same way.

Left in place deliberately: `TextToSpeech.predictDurations` (`src/offscreen/supertonic_helper.ts`)
now has no caller in `src/`. It is kept because it is part of the ported engine's API surface and
its test still covers the style-batching and speed-division maths that `_infer` shares.

---

## Read this before starting

A previous attempt implemented a serial synthesis queue plus an adaptive 2–5 unit prefetch window and **made playback worse** (larger gaps, slower first audio). That approach is abandoned — see the spec's Root Cause section. Do not reintroduce it.

The rules that follow from that failure:

1. **Measure before changing.** Task 0 lands instrumentation and records a baseline on unmodified `main`. No behavioural change until that baseline exists.
2. **One optimization at a time.** Each task is measured on its own before the next begins. Landing several together makes a regression unattributable — that is exactly what happened last time.
3. **Revert, don't compensate.** A task that fails to improve its target metric gets reverted, not patched with another mechanism.
4. **Do not increase prefetch depth.** It stays at one unit ahead. If measurement later shows units arriving late, raise it by a fixed step and re-measure — never with an adaptive formula.

If a workspace already contains the previous attempt, reset to `main` before Task 0.

## Global Constraints

- Chrome Extension Manifest V3 — offscreen document context
- ONNX Runtime Web — currently `numThreads=1`, `proxy=false`; the WebGPU provider is tried before WASM
- Biome formatting: tabs, 4-space tab width, LF, 140 char line width
- `pnpm build` must pass (strict TypeScript)
- `pnpm test:unit` and `pnpm test:e2e` must pass
- No change to the public message API between offscreen ↔ background ↔ popup

---

## File Map

| File | Task 0 | Task 1 | Task 2 | Task 3 | Task 4 |
|---|---|---|---|---|---|
| `src/offscreen/playback_metrics.ts` | Create ✅ | — | — | — | — |
| `src/offscreen/offscreen.ts` | Modify ✅ | Modify (scheduling) | — | — | Modify (conditional) |
| `src/offscreen/supertonic_helper.ts` | — | — | Modify (`proxy`) | Modify (denoise loop) | Modify (conditional) |
| `tests/unit/playback_metrics.test.ts` | Create ✅ | — | — | — | — |
| `tests/unit/playback_scheduling.test.ts` | — | Create | — | — | — |
| `tests/unit/denoising_latent.test.ts` | — | — | — | Create | — |

> `tests/unit/synthesis_coordinator.test.ts` and `tests/unit/word_timing.test.ts` already exist — modify, never overwrite.
> `src/offscreen/synthesis_coordinator.ts` is **not** touched by this plan.

---

### Task 0: Instrumentation and Baseline

**Goal:** Be able to tell whether any later task helps. No behavioural change.

**Files:** Create `src/offscreen/playback_metrics.ts`, `tests/unit/playback_metrics.test.ts`; modify `src/offscreen/offscreen.ts`

- [x] **Step 1: Add gap measurement**

`PlaybackMetricsRecorder.recordUnitEnded()` captures `audioCtx.currentTime` in the natural-transition branch of `onended`; `recordUnitStart()` captures it immediately after `source.start()` and stores the delta. `discardPendingTransition()` is called on pause and on manual checkpoint so a stop is never counted as a gap.

Collection is unconditional rather than flag-gated: it is a few number pushes, and gating it would mean the measured build is not the shipped one.

- [x] **Step 2: Add main-thread and startup measurement**

- `synthesizeUnit()` wall time → `recordSynthDuration()`
- 50 ms highlight interval drift → `recordHighlightTick()`
- `PLAY` received → first `source.start()` → `markPlayRequested()` + `recordUnitStart()`
- Execution provider recorded where `MODEL_LOADED` is dispatched

`stopAudio()` calls `flushPlaybackMetrics()`, which writes the summary to `chrome.storage.local` under `readit_playback_metrics` and logs one JSON line. Storage is used because E2E drives the extension through the service worker and cannot reach the offscreen document.

→ verified: `pnpm build` succeeds, `pnpm test:unit` 233/233, `npx biome check` clean

- [ ] **Step 3: Record the baseline**

**Must be run on a real Chrome profile, not headless E2E** — headless has no WebGPU, so it would fall back to WASM and produce numbers that do not represent the reported symptom.

1. `pnpm build`
2. `chrome://extensions` → **Reload** the extension (a rebuild alone does not refresh an already-loaded unpacked extension)
3. Play a sample article of at least three units
4. Read the summary either way:

```bash
# chrome://extensions → the extension's service worker → Console
chrome.storage.local.get('readit_playback_metrics', console.log)
```

```bash
# chrome://extensions → "Inspect views: offscreen.html" → Console (live, while playing)
__readitPlaybackMetrics()
```

The storage key is written after each unit starts, so it is populated from the second unit onward — it does not require the article to finish.

Record: `executionProvider`, `gapsOverThreshold`, `gapMedianMs`, `gapMaxMs`, `callbackLatenessMaxMs`, `timeToFirstAudioMs`, `synthMedianMs`, `synthMaxMs`, `predictMedianMs`, `inferMedianMs`, `audioMedianSec`, `synthToAudioRatio`, `highlightDriftMaxMs`.

→ verify: baseline numbers written down here and referenced by every later task

#### Round 1 (superseded — kept because it changed the plan)

```json
{"executionProvider":"webgpu","timeToFirstAudioMs":1488.9,"transitions":5,
 "gapsOverThreshold":0,"gapMedianMs":0,"gapMaxMs":0,
 "synthCount":6,"synthMedianMs":6963.9,"synthMaxMs":8939,"highlightDriftMaxMs":266.6}
```

Reported as: heavy lag, dropped words, uneven pace.

**The gap figure was invalid.** Round 1 measured `audioCtx.currentTime` inside the `onended`
callback. `currentTime` does not advance within a single JS task, so a late callback and the
following `start()` read the same value and the difference was always exactly zero — the metric
could not see silence at all. It now compares against the time the audio was *due* to end,
computed at `start()`.

Three findings survive and already changed the plan:

1. **`executionProvider` is `webgpu`.** `ort.env.wasm.proxy` only affects the WASM path, so
   **Task 2 is dropped** — it cannot move WebGPU work off the main thread.
2. **`synthMedianMs` climbs 615 → 1804 → 2993 → 5126 → 7259, peaking at 8939 ms.** If a unit
   carries less audio than that, synthesis is slower than realtime and **no amount of buffering
   or pre-scheduling can hide it** — Task 1 would be treating a symptom. `synthToAudioRatio`
   was added to settle this: above 1.0 means the deficit is real.
3. **`highlightDriftMaxMs` is 266 ms** — the 50 ms interval stretched to ~316 ms, which is what
   "dropped words" looks like: the highlight skips whole runs of words per tick.

Suspect for the climb: `predictSpokenWordDurations` (`src/offscreen/word_timing.ts:55`) builds one
prefix per word and submits all of them as a single batch, so cost grows with the square of the
unit's word count. `predictMedianMs` and `inferMedianMs` were added to confirm or clear it.

#### Round 2 — the gap hypothesis is dead

With the corrected metric, across four transitions: `gapMaxMs` **5.1**, `callbackLatenessMaxMs`
**5.1**, `gapsOverThreshold` **0**, `synthToAudioRatio` **0.116 → 0.256**.

- **Audio is continuous and `onended` is on time.** There is no gap for Task 1 to remove, and no
  synthesis deficit for buffering to cover. **The entire prefetch/scheduling direction is a dead
  end** — that includes Task 1, which was the centrepiece of the previous revision.
- **The O(N²) suspicion is confirmed.** Unit length grew 3.8× (5.14 → 19.52 s); over the same
  span `infer` grew 2.5× (sub-linear, normal) while `predict` grew 13.7× — against 3.8² = 14.4.
  At the longest unit `predictMax` is **7 824 ms** against `inferMax` **999 ms**: seven eighths of
  synthesis cost is computing word positions for highlighting, not producing audio.
- `highlightDriftMaxMs` **251 ms** — the predict batch holds the main thread, so the 50 ms
  highlight interval stretches to ~300 ms.

#### Round 3 — the actual symptom is correctness, not performance

Reported on listening: audio cuts out for several seconds, **some text is never read**, **some
text is read twice**.

Missing and repeated text is not a timing defect. Timing metrics cannot see it, which is why two
rounds of tuning measured "healthy" while playback was audibly wrong. Instrumentation added:

- `unitSequence` — every `unitIndex` that actually reached `source.start()`
- `skippedUnits` / `repeatedUnits` — derived by `analyzeUnitSequence`
- `droppedStarts` — the combined guard at the top of `playAudioBuffer` was split into four named
  branches (`no-audio-context`, `source-already-playing`, `stale-session`, `stale-unit-index`);
  each silently discarded a whole unit
- `synthErrors` — a synthesis failure aborts the unit and was previously only surfaced to the UI

Prime suspect: `playAudioBuffer` returns early while `currentUnitIndex` has already advanced, so
the unit is never played and playback resumes at the following one.

---

### Task 1: Pre-schedule the next unit on the AudioContext clock — ON HOLD

**Round 2 measured `gapMaxMs` at 5.1 ms with zero transitions over threshold.** There is no gap to
remove, so this task addresses nothing that was reported. Do not start it. Revisit only if a later
baseline shows real silence between units.

<details>
<summary>Original task, kept in case a gap appears later</summary>

Removes the gap that exists even when the buffer is ready.

**Files:**
- Modify: `src/offscreen/offscreen.ts`
- Create: `tests/unit/playback_scheduling.test.ts`

**Interfaces:**
- Pure helper, exported for tests:
  - `nextStartTime(scheduledUntilSec: number, nowSec: number): number` — returns `Math.max(scheduledUntilSec, nowSec)`, so a late arrival starts immediately instead of in the past
- Module state: `scheduledUntilSec`, `scheduledIndex`, and the audible unit derived from `audioCtx.currentTime`

- [ ] **Step 1: Add the scheduling helper and its tests**

Create `tests/unit/playback_scheduling.test.ts` covering: normal chaining (next starts exactly at previous end), late arrival (`scheduledUntilSec` already in the past → start now, no negative time), and first unit (`scheduledUntilSec` unset).

Run: `node --experimental-strip-types --test tests/unit/playback_scheduling.test.ts`
→ verify: all cases pass

- [ ] **Step 2: Schedule N+1 as soon as its buffer resolves**

In `playNextUnit()` / the prefetch resolution path, call `source.start(nextStartTime(...))` for unit N+1 instead of waiting for N's `onended`. Keep at most one unit scheduled ahead. Update `scheduledUntilSec` on each schedule.

- [ ] **Step 3: Demote `onended` to bookkeeping only**

`onended` must no longer start audio. It advances the audible index, triggers the next prefetch, and calls `stopAudio()` at the end of the article. A delayed `onended` must not produce an audible gap.

- [ ] **Step 4: Make source teardown cover the scheduled source**

`stopCurrentSource()` must stop both the playing and the scheduled source. Verify `STOP`, `PAUSE`, and `CHANGE_SPEED` all cancel the scheduled source before `synthesisCoordinator.clear()`.

- [ ] **Step 5: Repoint word highlighting at the audible unit**

`startWordHighlightTracking()` currently binds one `unitStartTime`. Select the window from the unit whose scheduled span contains `audioCtx.currentTime`.

Run: `pnpm test:unit`
→ verify: `word_timing.test.ts` and `manual_word_highlight.test.ts` pass

- [ ] **Step 6: Fix checkpoint to report the audible unit**

`checkpointManual()` reads `currentBuffer` and `currentBufferStartedAt`. With two live sources these must resolve to the audible unit, not the scheduled one.

Run: `pnpm test:unit`
→ verify: `manual_checkpoint.test.ts` and `manual_playback.test.ts` pass

- [ ] **Step 7: Verify pause/resume across a scheduled boundary**

Pause mid-unit while N+1 is already scheduled, resume, confirm audio continues seamlessly (`audioCtx.suspend()` freezes `currentTime`, so relative scheduling should survive — confirm, don't assume).

- [ ] **Step 8: Measure**

Run: `pnpm build && pnpm test:unit && pnpm test:e2e`
Then replay the sample article and compare against the Task 0 baseline.

→ verify: transitions with gap > 50 ms is **0**; time to first audio no worse than baseline. If not, revert this task and re-diagnose.

</details>

---

### Task 2: Move ORT inference off the main thread — DROPPED

**Round 1 baseline reports `executionProvider: "webgpu"`.** `ort.env.wasm.proxy` governs the WASM
path only, so flipping it would not move any of the observed work off the main thread. Skip this
task unless a later baseline shows the WASM fallback in use.

<details>
<summary>Original task, kept for the WASM-fallback case</summary>

Reduces the main-thread contention that delays every playback callback.

**Files:** Modify `src/offscreen/supertonic_helper.ts`

- [ ] **Step 1: Confirm which provider is actually active**

From the Task 0 log, check whether `webgpu` or `wasm` was selected. If WebGPU is in use, `proxy` affects only the WASM fallback path — note this and size the expected gain accordingly.

- [ ] **Step 2: Try `ort.env.wasm.proxy = true`**

Change line 9. The wasm binaries are already local (`rsbuild.config.ts:101`) and `wasmPaths` resolves via `chrome.runtime.getURL`, so a worker should spawn under the extension CSP.

→ verify: models load and a full article plays without console CSP errors

- [ ] **Step 3: If the worker fails to spawn, revert and record why**

Restore `proxy = false` with a comment stating the exact CSP error. Nothing else in this plan depends on this task.

- [ ] **Step 4: Measure**

Run: `pnpm build && pnpm test:unit && pnpm test:e2e`, then replay the sample article.

→ verify: highlight interval drift and `synthesizeUnit()` main-thread time both improved vs. Task 1's numbers

</details>

---

### Task 3: Flat Float32 denoising loop

Independent of Tasks 1–2. Reduces main-thread work per unit.

**Files:**
- Modify: `src/offscreen/supertonic_helper.ts`
- Create: `tests/unit/denoising_latent.test.ts`

- [ ] **Step 1: Capture a golden output**

Before changing anything, record `_infer()`'s output for a fixed input with the current implementation. A shape-only test will not catch a permuted latent.

- [ ] **Step 2: Return flat samples from `sampleNoisyLatent()`**

Return `{ xt: Float32Array, shape: [number, number, number], latentMask }`. Extract the index arithmetic into a pure helper testable without ONNX.

- [ ] **Step 3: Test the flat index mapping**

Create `tests/unit/denoising_latent.test.ts`: for several shapes, the flat index for `(b, d, t)` matches the previous nested layout; the pre-allocated buffer is reused across simulated steps.

Run: `node --experimental-strip-types --test tests/unit/denoising_latent.test.ts`
→ verify: all cases pass

- [ ] **Step 4: Rewrite the loop**

Keep `xt` flat throughout: build the tensor from the buffer, copy each step's `denoised_latent` back into the same allocation, delete both `.flat(2)` calls and the triple `push` loop.

Run: `pnpm test:unit && pnpm build`
→ verify: tests pass, BUILD SUCCESS

- [ ] **Step 5: Compare against the golden output**

→ verify: output matches the Step 1 recording within float tolerance. **A mismatch means the stride mapping is wrong — audio will be noise.** Do not proceed on a mismatch.

---

### Task 4 (conditional): Direct PCM → AudioBuffer

**Skip unless Task 0 measurement shows the WAV roundtrip is material after Tasks 1–3.** It trades an off-thread `decodeAudioData()` for an on-main-thread copy, so it is not automatically a win.

**Files:** Modify `src/offscreen/supertonic_helper.ts`, `src/offscreen/offscreen.ts`

- [ ] **Step 1: Decide with data**

Compare measured `writeWavFile()` + `decodeAudioData()` time against the gap budget. If it is not on the critical path, stop here and close the task.

- [ ] **Step 2: Match the AudioContext sample rate**

Construct `new AudioContext({ sampleRate: engine.sampleRate })` so playback does not resample. This requires creating the context after the engine loads — it is currently created in three places beforehand. Add a fallback if the platform rejects the rate.

- [ ] **Step 3: Return `Float32Array` from `_infer()`**

Return `vocoderOutputs.wav_tts.data as Float32Array` instead of `Array.from(...)` (`src/offscreen/supertonic_helper.ts:371`). `synthesizeSpeechUnitSamples` in `audio.ts` already accepts `Float32Array`.

- [ ] **Step 4: Build the AudioBuffer directly**

Add `createAudioBufferFromPCM(audioCtx, samples, sampleRate)`; validate `sampleRate` against `[3000, 768000]`. Remove `writeWavFile()`, which has no other caller.

- [ ] **Step 5: Measure**

Run: `pnpm build && pnpm test:unit && pnpm test:e2e`, then replay the sample article.

→ verify: time to first audio improved and gap count still 0. Listen for resampling artifacts. Revert if either regresses.

---

### Task 5: Final Verification

- [ ] **Step 1:** `pnpm build` → BUILD SUCCESS
- [ ] **Step 2:** `pnpm test:unit` → all pass
- [ ] **Step 3:** `pnpm test:e2e` → all pass
- [ ] **Step 4:** Replay the sample article; confirm zero transitions above 50 ms and no regression in time to first audio or highlight drift versus the Task 0 baseline
