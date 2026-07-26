# Pre-build Audio Buffer — Eliminate Playback Gaps

## Goal

Eliminate the silent gap between `SpeechUnit` items during TTS playback by scheduling the next unit on the Web Audio clock instead of waiting for a main-thread callback, and by reducing how much the main thread is occupied while playback runs.

**Explicitly not by buffering more units ahead.** A previous revision of this spec attempted that and made playback measurably worse; see Root Cause below.

## Root Cause

Two independent causes. The earlier revision addressed neither.

### A. Unit transition waits on a main-thread callback

`src/offscreen/offscreen.ts:385` starts unit N+1 from `source.onended` of unit N:

```typescript
source.onended = () => {
	currentUnitIndex = unitIndex + 1;
	void playNextUnit(lang, style, session);
};
```

`onended` fires on the main thread *after* the buffer has already finished. The next `source.start(0)` therefore happens strictly later than the end of the previous unit — **the gap is structural and exists even when the next buffer has been ready for seconds.** Its size is however long the main thread takes to reach the callback.

### B. Inference runs on that same main thread

`src/offscreen/supertonic_helper.ts:8-9` sets `numThreads = 1` and `proxy = false`, so WASM inference executes on the offscreen document's main thread (the WebGPU path also marshals tensors there). Scheduled audio keeps playing on the audio thread, but every callback that *advances* playback is stuck behind inference:

- `source.onended` → `playNextUnit()`
- `setInterval(..., 50)` for word highlighting (`src/offscreen/offscreen.ts:305`)

**B multiplies A.** The more inference is in flight, the later `onended` runs, the larger the gap.

### Why the previous revision regressed

It widened the prefetch window (up to 5 units) and added a serial synthesis queue, on the assumption that gaps came from "the next unit is not ready yet". Consequences:

- More concurrent inference → main thread saturated → `onended` delayed further → **gaps grew**.
- The adaptive target `movingAvg(synthTimeMs) × 2` never converges when synthesis is slower than realtime: buffered seconds can never reach the target, so the prefetch loop ran continuously at the cap.
- Prefetching before the first unit finished playing raised time-to-first-audio.
- The serial queue re-implemented ordering that ORT already provides at `numThreads=1` (calls serialize in invocation order, and prefetch already walks ascending indices), while adding a wait for each job's *non-ORT* tail work.

Buffer depth absorbs **variance**. It cannot fix a callback that is late, and it cannot fix a synthesis deficit.

---

## Optimization 1: Pre-schedule the next unit on the AudioContext clock

**This is the core change. It removes cause A entirely.**

### Problem

See Root Cause A: `source.start(0)` in a callback can never be sample-accurate against the end of the previous buffer.

### Solution

Track the absolute time at which scheduled audio ends, and start the next unit at exactly that instant.

```typescript
// scheduledUntilSec: audioCtx.currentTime coordinate where queued audio runs out
function scheduleUnit(buffer: AudioBuffer, startAtSec: number): number {
	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.connect(audioCtx.destination);
	source.start(startAtSec);
	return startAtSec + buffer.duration;
}
```

As soon as unit N+1's buffer resolves, schedule it at `scheduledUntilSec` rather than waiting for N to end. Web Audio joins the two buffers on the audio thread; **the gap is zero regardless of main-thread load.**

### Scope constraint

Keep **at most one unit scheduled ahead** (N and N+1 live simultaneously). This is enough to make the gap zero and keeps state manageable. Do not generalize to a deep scheduled chain.

### State changes this forces

The current code assumes exactly one live source. Splitting "scheduled" from "audible" requires:

- `scheduledUntilSec` — end of queued audio on the `audioCtx` clock
- Separate `scheduledIndex` (how far ahead we have queued) from `playingIndex` (what the listener hears now), derived from `audioCtx.currentTime`
- `stopCurrentSource()` must stop **both** the playing and the scheduled source. `AudioBufferSourceNode.stop()` is valid on a source that has been `start()`-ed with a future time and cancels it.
- `onended` keeps running, but only to advance bookkeeping and trigger the next prefetch — **never to start audio**. Late arrival must not cause an audible gap.
- Word highlighting picks its window from the unit whose scheduled span contains `audioCtx.currentTime`, not from a single `unitStartTime`.
- `checkpointManual()` (`src/offscreen/offscreen.ts:536`) reads `currentBuffer` / `currentBufferStartedAt`; both must resolve to the *audible* unit, not the scheduled one.
- `PAUSE` uses `audioCtx.suspend()`, which freezes `currentTime`, so relative scheduling survives suspend/resume unchanged. Verify this explicitly.
- `CHANGE_SPEED` and `STOP` must cancel the scheduled source before clearing the coordinator.

### Affected Files

- `src/offscreen/offscreen.ts` — scheduling, source lifecycle, highlight windowing, checkpoint

---

## Optimization 2: Move ORT inference off the main thread

**This removes cause B.** Independent of Optimization 1; do it second so each is measurable.

### Problem

`ort.env.wasm.proxy = false` keeps inference on the main thread, delaying every playback callback and the 50 ms highlight interval.

### Solution

Set `ort.env.wasm.proxy = true` so ORT runs the session in a worker.

The existing `proxy = false` is attributed to a CSP constraint, but the preconditions for a worker now hold: the wasm binaries are copied locally (`rsbuild.config.ts:101`) and `ort.env.wasm.wasmPaths` already resolves through `chrome.runtime.getURL` (`src/offscreen/supertonic_helper.ts:5`). **Verify this before designing around it** — if the worker fails to spawn under the extension's CSP, fall back and record why, since the rest of the plan does not depend on it.

Note the WebGPU path is tried first (`src/offscreen/offscreen.ts:111`); confirm which provider is actually in use before attributing main-thread time to WASM.

### Affected Files

- `src/offscreen/supertonic_helper.ts` — ORT env configuration

---

## Optimization 3: Flat Float32 denoising loop

### Problem

The diffusion loop (`src/offscreen/supertonic_helper.ts:328-359`) boxes and re-copies the latent on every step:

1. `Array.from(vocoderOutputs.denoised_latent.data)` boxes a `Float32Array` into `number[]`
2. rebuilds a nested `number[][][]` via a triple `push` loop
3. `xt.flat(2)` copies it back flat for the next tensor

At `totalStep = 8` that is 8 full box/copy round trips. This is main-thread time, so it feeds cause B directly.

### Solution

Keep `xt` as a flat `Float32Array` for the whole loop. `sampleNoisyLatent()` returns flat samples plus an explicit shape; each step copies `denoised_latent` back into the same pre-allocated buffer. Both `.flat(2)` calls and the nested array disappear.

**Risk:** an incorrect `[b][d][t]` → flat stride mapping permutes the latent and the vocoder emits noise. Requires a golden test against the current implementation's output, not just a shape test.

### Affected Files

- `src/offscreen/supertonic_helper.ts` — `_infer()`, `sampleNoisyLatent()`

---

## Optimization 4 (conditional): Direct PCM → AudioBuffer

**Only if measurement shows the WAV roundtrip is material after Optimizations 1–3.**

### Problem

`synthesizeUnit()` (`src/offscreen/offscreen.ts:206`) runs `Float32 PCM → Int16 → WAV header → decodeAudioData() → AudioBuffer`.

### Why this is not a free win

`decodeAudioData()` is asynchronous and decodes **off** the main thread, returning a buffer already resampled to `audioCtx.sampleRate`. `createBuffer()` + `copyToChannel()` are **synchronous on the main thread** and keep the model's sample rate.

`audioCtx` is constructed with no options (`src/offscreen/offscreen.ts:181`), so it runs at the system rate (typically 48 kHz) while `engine.sampleRate` comes from `cfgs.ae.sample_rate`. If they differ, every `AudioBufferSourceNode` resamples during playback on the audio thread using linear interpolation — worse quality and a real-time cost.

### Solution

Adopt this **only together with sample-rate matching**: construct `new AudioContext({ sampleRate: engine.sampleRate })` so no resampling occurs. That means the context can only be created after the engine loads, which changes initialization order — `audioCtx` is currently created in three places before the engine is guaranteed ready. Needs a fallback if the platform rejects the requested rate.

Also: `createBuffer` throws outside `[3000, 768000]`; validate `engine.sampleRate`.

### Affected Files

- `src/offscreen/supertonic_helper.ts` — `_infer()` returns `Float32Array` directly
- `src/offscreen/offscreen.ts` — `createAudioBufferFromPCM()`, AudioContext construction order

---

## Non-Goals

- **Adaptive prefetch depth.** Prefetch stays at one unit ahead. With Optimization 1 the gap is zero whenever N+1 is ready before N ends; deeper buffering trades main-thread time for a margin that pre-scheduling already provides. Raise it only if measurement shows units arriving late, and then as a fixed step, never a formula.
- **Serial synthesis queue.** ORT already serializes at `numThreads = 1`, and prefetch already walks ascending indices.
- **Synthesis cache keyed by text.** Near-zero hit rate within an article, no eviction, and sharing one `AudioBuffer` across units with different `wordMap`s corrupts `predictedWordDurationsByBuffer`.
- **Hybrid speed changes.** `CHANGE_SPEED` still discards buffered units. Acceptable while depth stays at one.

---

## Verification Plan

### Baseline first

Instrumentation lands **before** any behavioural change, and a baseline is recorded on current `main`:

1. **Gap:** at each transition, `audioCtx.currentTime` when unit N's source ends minus when unit N+1's source starts. Count transitions above 50 ms.
2. **Main-thread block:** wall time of each `synthesizeUnit()` call, and the observed drift of the 50 ms highlight interval.
3. **Time to first audio:** `PLAY` message received → first `source.start`.
4. **Execution provider actually selected** (`webgpu` vs `wasm`).

### Acceptance

| Metric | Target |
|---|---|
| Transitions with gap > 50 ms | 0 |
| Time to first audio | no worse than baseline |
| Highlight interval drift | no worse than baseline |

Each optimization is measured on its own before the next lands. Any change that fails to improve its target metric is reverted rather than compensated for.

### Regression checks

- `pnpm test:unit`
- `pnpm build`
- `pnpm test:e2e`
