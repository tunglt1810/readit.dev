# MP3 Audio Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the complete active reading session from the beginning as a local 96 kbps mono MP3, streamed directly to a user-selected file while foreground playback remains authoritative.

**Spec:** [2026-07-29-mp3-audio-export-design.md](/Users/bez/Workspace/repos/bez/readit.dev/docs/specs/2026-07-29-mp3-audio-export-design.md)

**Architecture:** Popup and Side Panel share one export control and hand a user-selected `FileSystemFileHandle` to the offscreen document through a one-record IndexedDB store. Background owns the one-job control plane and session metadata. Offscreen owns the immutable `SpeechUnit[]` snapshot, serializes foreground and export inference through a foreground-first arbiter, lazy-loads the locally bundled Mediabunny encoder, and writes through `StreamTarget` without collecting the MP3 in memory.

**Tech Stack:** TypeScript 6, React 19, Chrome MV3 (minimum Chrome 127), IndexedDB, File System Access API, Mediabunny 1.51.0, `@mediabunny/mp3-encoder` 1.51.0, Node test runner, Playwright.

## Global Constraints

- Do not add `downloads`, history, identity, notification, or new host permissions.
- Do not fetch JavaScript, workers, or WASM at runtime. Dynamic imports must resolve to files in the extension archive.
- Do not persist reading text, `SpeechUnit[]`, PCM, encoded audio, paths, or file handles in `chrome.storage`.
- IndexedDB may contain only the temporary handle record keyed by `jobId`.
- Keep one TTS engine, one export job, one export buffer, and the existing one-unit playback prefetch depth.
- Foreground synthesis always wins the next arbiter slot. A running inference is never preempted.
- Export waits while playback is loading, paused, changing session/settings, or lacks the approved runway.
- Picker cancellation creates no terminal error. Cancellation or failure must abort, not commit, the partial file.
- Do not resume after offscreen loss, extension reload/update, or browser restart.
- Add the control to Popup and Side Panel only; do not add it to Reader.
- Keep `minimum_chrome_version` at 127.
- Put all scratch files, archives, profiles, and generated evidence under repository `/.tmp/`.
- Preserve unrelated worktree changes. Every changed line must trace to the approved spec.
- Use TDD: observe each focused test fail before adding the production behavior.
- Prefix repository shell commands with `rtk`.

---

## File Map and Responsibilities

| Area | Files | Responsibility |
| --- | --- | --- |
| Dependencies/compliance | `package.json`, `pnpm-lock.yaml`, `public/THIRD_PARTY_NOTICES.txt`, `public/licenses/mediabunny-MPL-2.0.txt`, `public/licenses/lame-COPYING.txt` | Pin exact packages; ship auditable license texts and source links; require legal review before public release |
| Shared protocol | `src/shared/audio_export.ts`, `src/shared/types.ts`, `src/shared/constants.ts` | Export state, estimate, commands, guards, filenames, storage key |
| Handle handoff | `src/shared/audio_export_handle_store.ts`, `src/env.d.ts` | Put/take/delete the one temporary `FileSystemFileHandle` |
| Shared UI | `src/shared/audio_export_client.ts`, `src/shared/components/AudioExportButton.tsx`, `src/shared/components/PlaybackIcon.tsx`, `src/shared/theme.css`, locale JSON | Picker flow, warning/cancel dialog, synchronized accessible control |
| Playback snapshot | `src/background/playback_state.ts`, `src/background/offscreen_transport.ts` | Strict numeric estimate hydration and validated offscreen responses |
| Background control plane | `src/background/audio_export_state.ts`, `src/background/audio_export.ts`, `src/background/background.ts` | One-job state machine, persistence, routing, idle lifetime, interruption |
| Foreground scheduling | `src/offscreen/synthesis_arbiter.ts`, `src/offscreen/synthesis_coordinator.ts` | Foreground-first serialized inference and resolved-next-buffer visibility |
| Offscreen data plane | `src/offscreen/audio_export_estimate.ts`, `src/offscreen/audio_export_encoder.ts`, `src/offscreen/audio_export_engine.ts`, `src/offscreen/offscreen.ts` | Immutable snapshot, runway, one-unit synthesis, streaming encode, cleanup |
| Surface integration | `src/popup/App.tsx`, `src/sidepanel/App.tsx`, `src/popup/popup.css`, `src/sidepanel/sidepanel.css` | Place one export control beside the active playback transport |
| Release/privacy | `scripts/validate-extension-archive.mjs`, `.github/workflows/release-extension.yml`, `docs/privacy-policy.md`, `docs/RELEASING.md` | Local-code/license archive gate and accurate local-processing disclosure |
| Tests | focused files under `tests/unit/` and `tests/e2e/` listed per task | State, scheduling, storage, streaming, UI, source coverage, real MP3 |

The new modules are intentionally narrow. Do not create a generic job framework, generic storage wrapper, or general priority scheduler.

---

### Task 0: Pin Dependencies and Pass the License Gate

**Files:** Modify `package.json`, `pnpm-lock.yaml`, `public/THIRD_PARTY_NOTICES.txt`; create `public/licenses/mediabunny-MPL-2.0.txt`, `public/licenses/lame-COPYING.txt`

**Interfaces consumed:** npm packages `mediabunny@1.51.0`, `@mediabunny/mp3-encoder@1.51.0`; audited LAME 3.100 license evidence.

**Interfaces produced:** Exact locked dependency graph, exact license texts, and third-party notices/source links. No runtime code yet. Legal review remains required before public release.

- [ ] **Step 1: Install exact runtime and test dependencies**

```bash
rtk pnpm add -E mediabunny@1.51.0 @mediabunny/mp3-encoder@1.51.0
rtk pnpm add -D -E fake-indexeddb@6.2.5
rtk pnpm why mediabunny
rtk pnpm why @mediabunny/mp3-encoder
```

Expected: both runtime packages resolve exactly to `1.51.0`; the encoder has no unexpected runtime dependency and peer-resolves to the same Mediabunny version.

- [ ] **Step 2: Audit the shipped package before implementation**

Inspect all of:

```bash
rtk sed -n '1,220p' node_modules/mediabunny/LICENSE
rtk sed -n '1,220p' node_modules/@mediabunny/mp3-encoder/LICENSE
rtk sed -n '1,240p' node_modules/@mediabunny/mp3-encoder/README.md
rtk rg -n "LAME|3\\.100|license|COPYING|wasm|Worker|Blob|URL" node_modules/@mediabunny/mp3-encoder/src node_modules/@mediabunny/mp3-encoder/dist
```

Confirm from package source that the bundled encoder is LAME 3.100, worker/WASM are embedded in the package bundle, and no CDN/runtime URL exists. If the package source contradicts any of those points, stop this task and revise the approved design before writing feature code.

- [ ] **Step 3: Verify the exact audited LAME license text**

```bash
rtk sed -n '1,240p' .tmp/lame-license-audit/lame-3.100/COPYING
```

Cross-check the exact upstream designation in the audited LAME source headers
and `COPYING`; do not infer an SPDX variant. Copy the package MPL text and LAME
`COPYING` verbatim:

```bash
rtk mkdir -p public/licenses
rtk cp node_modules/mediabunny/LICENSE public/licenses/mediabunny-MPL-2.0.txt
rtk cp .tmp/lame-license-audit/lame-3.100/COPYING public/licenses/lame-COPYING.txt
```

- [ ] **Step 4: Complete third-party notices**

Add entries containing:

- `mediabunny 1.51.0` and `@mediabunny/mp3-encoder 1.51.0`;
- copyright from the pinned package files;
- MPL-2.0 designation, project URL, package source URL, and bundled license path;
- LAME 3.100, the exact upstream GNU Library General Public License Version 2 wording, acknowledgement, stable project/source URLs, and bundled `COPYING` path;
- a statement that readit.dev does not modify Mediabunny or LAME source;
- a statement that worker and WASM code is packaged locally.

These notices and source links are engineering evidence, not legal advice or a
guarantee of LGPL compliance. Legal review is required before public release.

- [ ] **Step 5: Verify the dependency/license-only change**

```bash
rtk test -s public/licenses/mediabunny-MPL-2.0.txt
rtk test -s public/licenses/lame-COPYING.txt
rtk rg -n "1\\.51\\.0|LAME 3\\.100|MPL|LGPL|COPYING" public/THIRD_PARTY_NOTICES.txt
rtk git diff --check
```

- [ ] **Step 6: Commit the gate**

```bash
rtk git add package.json pnpm-lock.yaml public/THIRD_PARTY_NOTICES.txt public/licenses
rtk git commit -m "Add MP3 encoder dependencies and licenses"
```

---

### Task 1: Define Export Contracts, Validation, and Filenames

**Files:** Create `src/shared/audio_export.ts`, `tests/unit/audio_export.test.ts`; modify `src/shared/types.ts`, `src/shared/constants.ts`, `src/background/playback_state.ts`, `tests/unit/playback_state.test.ts`

**Interfaces consumed:** Existing `PlaybackSessionSnapshot`, session validators, `STORAGE_KEYS`.

**Interfaces produced:**

```ts
export const AUDIO_EXPORT_BITRATE_BPS = 96_000;
export const LONG_AUDIO_EXPORT_SECONDS = 60 * 60;

export type AudioExportJobState =
	| 'preparing'
	| 'exporting'
	| 'waiting-for-playback'
	| 'cancelling'
	| 'completed'
	| 'failed'
	| 'interrupted';

export type AudioExportErrorCode =
	| 'permission-denied'
	| 'write-failed'
	| 'encoding-failed'
	| 'snapshot-unavailable'
	| 'interrupted';

export interface AudioExportEstimate {
	durationSeconds: number;
	estimatedBytes: number;
}

export interface AudioExportJobSnapshot {
	jobId: string;
	playbackSessionId: string;
	title: string;
	outputFilename: string;
	state: AudioExportJobState;
	estimate: AudioExportEstimate;
	processedDurationSeconds: number;
	progressPercentage: number;
	bytesWritten: number;
	etaSeconds?: number;
	startedAt: number;
	updatedAt: number;
	errorCode?: AudioExportErrorCode;
}

export interface AudioExportStateResponse {
	job: AudioExportJobSnapshot | null;
}
```

Add `audioExportEstimate?: AudioExportEstimate` to `PlaybackSessionBase` and `AUDIO_EXPORT_JOB` to `STORAGE_KEYS`.

- [ ] **Step 1: Write failing contract and filename tests**

Cover exact job keys, finite non-negative numbers, monotonic percentage bounds, allowed state/error values, unsafe filename characters, trailing dots/spaces, empty titles, article/selection/manual naming, `.mp3` deduplication, 60-minute threshold, and 96 kbps byte estimation.

```ts
test('estimates a 60 minute 96 kbps MP3 without a hard cap', () => {
	assert.deepEqual(createAudioExportEstimate(3600), {
		durationSeconds: 3600,
		estimatedBytes: 43_200_000 + MP3_CONTAINER_OVERHEAD_BYTES,
	});
	assert.equal(requiresLongAudioExportConfirmation(createAudioExportEstimate(3600)), true);
	assert.equal(requiresLongAudioExportConfirmation(createAudioExportEstimate(3599.99)), false);
});

test('creates source-specific safe filenames', () => {
	assert.equal(suggestAudioExportFilename(articleSession, new Date(0)), 'An article.mp3');
	assert.equal(suggestAudioExportFilename(selectionSession, new Date(0)), 'An article-selection.mp3');
	assert.match(suggestAudioExportFilename(manualSession, new Date(0)), /^readit-pasted-text-.*\\.mp3$/u);
	assert.equal(sanitizeMp3Filename('  bad:/name.  '), 'bad-name.mp3');
});
```

- [ ] **Step 2: Run tests and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export.test.ts tests/unit/playback_state.test.ts
```

Expected: missing module/types and estimate validator failures.

- [ ] **Step 3: Implement the minimal pure contract module**

Implement and export:

```ts
export function createAudioExportEstimate(durationSeconds: number): AudioExportEstimate;
export function requiresLongAudioExportConfirmation(estimate: AudioExportEstimate): boolean;
export function sanitizeMp3Filename(value: string): string;
export function suggestAudioExportFilename(session: PlaybackSessionSnapshot, now: Date): string;
export function isAudioExportEstimate(value: unknown): value is AudioExportEstimate;
export function isAudioExportJobSnapshot(value: unknown): value is AudioExportJobSnapshot;
export function isAudioExportActive(job: AudioExportJobSnapshot | null): boolean;
```

Use a single explicit constant `MP3_CONTAINER_OVERHEAD_BYTES`; do not introduce configurable bitrate or format fields.

- [ ] **Step 4: Extend strict playback hydration**

Update `MANUAL_PLAYBACK_SESSION_KEYS` and `isPlaybackSessionSnapshot()` so only a valid numeric estimate is accepted. Add `applyAudioExportEstimate(session, sessionId, estimate, now)`; it must ignore stale session IDs and preserve all source metadata.

- [ ] **Step 5: Run focused tests**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export.test.ts tests/unit/playback_state.test.ts
rtk pnpm build
```

Expected: focused tests and strict TypeScript pass.

- [ ] **Step 6: Commit**

```bash
rtk git add src/shared/audio_export.ts src/shared/types.ts src/shared/constants.ts src/background/playback_state.ts tests/unit/audio_export.test.ts tests/unit/playback_state.test.ts
rtk git commit -m "Add audio export contracts"
```

---

### Task 2: Implement the One-Time IndexedDB Handle Handoff

**Files:** Create `src/shared/audio_export_handle_store.ts`, `tests/unit/audio_export_handle_store.test.ts`; modify `src/env.d.ts`

**Interfaces consumed:** Browser `indexedDB`, `FileSystemFileHandle`.

**Interfaces produced:**

```ts
export function putAudioExportHandle(
	jobId: string,
	handle: FileSystemFileHandle,
	factory?: IDBFactory,
): Promise<void>;

export function takeAudioExportHandle(
	jobId: string,
	factory?: IDBFactory,
): Promise<FileSystemFileHandle | null>;

export function deleteAudioExportHandle(jobId: string, factory?: IDBFactory): Promise<void>;
export function clearAudioExportHandles(factory?: IDBFactory): Promise<void>;
```

The database is `readit-audio-export`, version `1`, with one object store `handles`; records contain exactly `{ jobId, handle }`.

- [ ] **Step 1: Write failing tests with `fake-indexeddb`**

```ts
test('consumes a handle exactly once', async () => {
	const factory = new IDBFactory();
	const handle = { name: 'article.mp3' } as FileSystemFileHandle;
	await putAudioExportHandle('job-1', handle, factory);
	assert.deepEqual(await takeAudioExportHandle('job-1', factory), handle);
	assert.equal(await takeAudioExportHandle('job-1', factory), null);
});

test('clears abandoned handles without storing job content', async () => {
	const factory = new IDBFactory();
	await putAudioExportHandle('job-1', { name: 'one.mp3' } as FileSystemFileHandle, factory);
	await clearAudioExportHandles(factory);
	assert.equal(await takeAudioExportHandle('job-1', factory), null);
});
```

Also test replacement of the same `jobId`, delete of a missing key, transaction rejection, and strict record shape.

- [ ] **Step 2: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_handle_store.test.ts
```

- [ ] **Step 3: Implement transaction helpers**

Use one `readwrite` transaction for `take`: read, delete the same key, then resolve only after transaction completion. Close the database after every operation. Reject on request, transaction, blocked, or open errors.

Add only the missing File System Access declarations to `src/env.d.ts` if TypeScript's DOM library lacks them:

```ts
interface Window {
	showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
```

- [ ] **Step 4: Verify and commit**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_handle_store.test.ts
rtk pnpm build
rtk git add src/shared/audio_export_handle_store.ts src/env.d.ts tests/unit/audio_export_handle_store.test.ts
rtk git commit -m "Add audio export handle handoff"
```

---

### Task 3: Attach a Numeric Export Estimate to the Playback Snapshot

**Files:** Create `src/offscreen/audio_export_estimate.ts`, `tests/unit/audio_export_estimate.test.ts`; modify `src/offscreen/offscreen.ts`, `src/background/offscreen_transport.ts`, `src/background/background.ts`, `tests/unit/offscreen_transport.test.ts`, `tests/e2e/reading-state.spec.ts`

**Interfaces consumed:** Prepared `SpeechUnit[]`, resolved language, speed, validated offscreen command response.

**Interfaces produced:**

```ts
export function estimateSpeechUnits(
	units: readonly SpeechUnit[],
	language: string,
	speed: number,
): AudioExportEstimate;

export function estimateSpeechUnitDurations(
	units: readonly SpeechUnit[],
	language: string,
	speed: number,
): readonly number[];
```

`PLAY` and `CHANGE_SPEED` successful responses may include `audioExportEstimate`; background validates and publishes it only onto the matching active session.

- [ ] **Step 1: Write failing estimator tests**

Test whitespace languages at 160 spoken words/minute, Chinese at 240 Han characters/minute, speed scaling, addition of every `pauseAfterMs`, per-unit weights summing to the total duration, empty content, positive finite outputs, and estimates beyond 120 minutes without a cap.

```ts
test('adds planned pauses after speed-scaled speech', () => {
	const estimate = estimateSpeechUnits(
		[{ text: 'one two three four', pauseAfterMs: 500, wordMap: [] }],
		'en',
		2,
	);
	assert.equal(estimate.durationSeconds, 1.25);
});
```

- [ ] **Step 2: Write failing transport and hydration tests**

Reject malformed estimates (`NaN`, negative, extra fields). Verify a late `PLAY` response cannot attach an estimate to a replacement session. Verify `CHANGE_SPEED` replaces the estimate for the current snapshot.

- [ ] **Step 3: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_estimate.test.ts tests/unit/offscreen_transport.test.ts tests/unit/playback_state.test.ts
```

- [ ] **Step 4: Implement estimate reporting**

After `preparePlaybackUnits()` succeeds, calculate the estimate and include it in the `PLAY` response. On `CHANGE_SPEED`, recalculate from the current prepared units before responding. In `observeOffscreenPlay()`, enqueue a guarded `applyAudioExportEstimate()` update.

Do not send or persist unit text as part of the estimate response.

- [ ] **Step 5: Verify and commit**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_estimate.test.ts tests/unit/offscreen_transport.test.ts tests/unit/playback_state.test.ts
rtk pnpm build
rtk git add src/offscreen/audio_export_estimate.ts src/offscreen/offscreen.ts src/background/offscreen_transport.ts src/background/background.ts tests/unit/audio_export_estimate.test.ts tests/unit/offscreen_transport.test.ts tests/e2e/reading-state.spec.ts
rtk git commit -m "Attach export estimates to playback sessions"
```

---

### Task 4: Serialize Inference with a Foreground-First Arbiter and Runway Gate

**Files:** Create `src/offscreen/synthesis_arbiter.ts`, `src/offscreen/audio_export_runway.ts`, `tests/unit/synthesis_arbiter.test.ts`, `tests/unit/audio_export_runway.test.ts`; modify `src/offscreen/synthesis_coordinator.ts`, `src/offscreen/offscreen.ts`, `tests/unit/synthesis_coordinator.test.ts`

**Interfaces consumed:** Existing synthesis delegate and playback status/buffer timing.

**Interfaces produced:**

```ts
export class SynthesisArbiter<Input, Output> {
	constructor(run: (input: Input) => Promise<Output>);
	foreground(input: Input): Promise<Output>;
	background(input: Input): Promise<Output>;
}

export interface PlaybackRunway {
	active: boolean;
	status: PlaybackStatus;
	currentRemainingSeconds: number;
	nextBufferSeconds: number | null;
	recentSynthesisMilliseconds: readonly number[];
}

export function canStartBackgroundSynthesis(runway: PlaybackRunway): boolean;
```

Add `peekResolved(key): Output | undefined` to `IndexedSynthesisCoordinator`; do not expose or await unresolved prefetch promises.

- [ ] **Step 1: Write failing priority tests**

Test one inference at a time, FIFO within each lane, foreground insertion ahead of queued background work, non-preemption of a running background unit, rejection isolation, and background progress after foreground drains.

```ts
test('selects queued foreground work before the next background unit', async () => {
	const first = deferred<string>();
	const order: string[] = [];
	const arbiter = new SynthesisArbiter<string, string>(async (value) => {
		order.push(value);
		if (value === 'background-1') await first.promise;
		return value;
	});
	const running = arbiter.background('background-1');
	const background = arbiter.background('background-2');
	const foreground = arbiter.foreground('foreground-1');
	first.resolve('done');
	assert.deepEqual(await Promise.all([running, foreground, background]), ['background-1', 'foreground-1', 'background-2']);
	assert.deepEqual(order, ['background-1', 'foreground-1', 'background-2']);
});
```

- [ ] **Step 2: Write failing runway/readiness tests**

Cover:

- no active playback permits export;
- loading/paused/error/stopped active session blocks it;
- unresolved next foreground buffer blocks it;
- runway must exceed `max(latest five synthesis durations) + 250 ms`;
- a new session or speed version invalidates old readiness;
- `peekResolved()` returns only the retained completed value.

- [ ] **Step 3: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/synthesis_arbiter.test.ts tests/unit/audio_export_runway.test.ts tests/unit/synthesis_coordinator.test.ts
```

- [ ] **Step 4: Implement arbiter and resolved-value tracking**

Route both current-unit `get()` and next-unit `prefetch()` delegates through `arbiter.foreground()`. Export will use `arbiter.background()` in Task 6. Keep the existing synthesis key and one-unit prefetch policy unchanged.

Record only the latest five completed synthesis wall times. `currentRemainingSeconds` comes from `currentBuffer.duration - elapsed`; `nextBufferSeconds` comes from `synthesisCoordinator.peekResolved(nextKey)?.duration`.

- [ ] **Step 5: Verify playback regressions and commit**

```bash
rtk node --experimental-strip-types --test tests/unit/synthesis_arbiter.test.ts tests/unit/audio_export_runway.test.ts tests/unit/synthesis_coordinator.test.ts tests/unit/playback_metrics.test.ts
rtk pnpm build
rtk git add src/offscreen/synthesis_arbiter.ts src/offscreen/audio_export_runway.ts src/offscreen/synthesis_coordinator.ts src/offscreen/offscreen.ts tests/unit/synthesis_arbiter.test.ts tests/unit/audio_export_runway.test.ts tests/unit/synthesis_coordinator.test.ts
rtk git commit -m "Prioritize playback synthesis over export"
```

---

### Task 5: Build the Lazy MP3 Stream Adapter

**Files:** Create `src/offscreen/audio_export_encoder.ts`, `tests/unit/audio_export_encoder.test.ts`; modify `rsbuild.config.ts` only if the production build does not emit a local async chunk

**Interfaces consumed:** `FileSystemWritableFileStream`, Mediabunny's `Output`, `Mp3OutputFormat`, `StreamTarget`, `AudioBufferSource`, and `registerMp3Encoder`.

**Interfaces produced:**

```ts
export interface AudioExportEncoder {
	add(buffer: AudioBuffer): Promise<void>;
	finalize(): Promise<void>;
	cancel(reason?: unknown): Promise<void>;
	bytesWritten(): number;
}

export async function createAudioExportEncoder(
	handle: FileSystemFileHandle,
): Promise<AudioExportEncoder>;
```

- [ ] **Step 1: Write failing adapter tests with injected module and writable fakes**

Test exact `codec: 'mp3'`, `bitrate: 96_000`, `bitrateMode: 'constant'`, `transform.numberOfChannels: 1`, default Xing header, ordered `await source.add(buffer)`, byte high-water tracking, and no `BufferTarget`.

Use a commit-controlled proxy writable. Its `write()` forwards `{ type: 'write', position, data }` to the native file stream. On successful finalization, close commits. After `cancelRequested` is set, either proxy `close()` or `abort()` must call native `abort()` exactly once.

```ts
test('aborts rather than commits after cancellation', async () => {
	const file = fakeFileStream();
	const encoder = await createAudioExportEncoder(fakeHandle(file), fakeModules);
	await encoder.cancel(new DOMException('Cancelled', 'AbortError'));
	assert.equal(file.abortCalls, 1);
	assert.equal(file.closeCalls, 0);
});
```

Also cancel during `add()` backpressure and during finalization. Failure paths must release encoder/worker resources.

- [ ] **Step 2: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_encoder.test.ts
```

- [ ] **Step 3: Implement the adapter with a real dynamic import boundary**

The only loading function is:

```ts
async function loadMp3Modules() {
	const [mediabunny, extension] = await Promise.all([
		import('mediabunny'),
		import('@mediabunny/mp3-encoder'),
	]);
	if (!(await mediabunny.canEncodeAudio('mp3'))) {
		extension.registerMp3Encoder();
	}
	return mediabunny;
}
```

Create the native writable with `{ keepExistingData: false }`, pass the commit-controlled proxy to `StreamTarget`, add one `AudioBufferSource`, call `output.start()`, and await each `source.add()`. Call `source.close()` before `output.finalize()`.

- [ ] **Step 4: Prove the build is local and lazy**

```bash
rtk pnpm build
rtk rg -n "mediabunny|mp3-encoder|lame" dist/static dist/src/offscreen
rtk rg -n "https?://|cdn|unpkg|jsdelivr" dist/static dist/src/offscreen
```

Expected: encoder code is absent from the initial offscreen entry and present in one or more local hashed async assets; no executable remote URL is present. `splitChunks: false` may remain unchanged if Rspack still emits the dynamic-import chunk. Modify `rsbuild.config.ts` only if this assertion fails, and add a comment explaining the manifest-entry constraint.

- [ ] **Step 5: Verify and commit**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_encoder.test.ts
rtk pnpm build
rtk git add src/offscreen/audio_export_encoder.ts tests/unit/audio_export_encoder.test.ts rsbuild.config.ts
rtk git commit -m "Stream MP3 output through Mediabunny"
```

If `rsbuild.config.ts` is unchanged, omit it from `git add`.

---

### Task 6: Implement the Offscreen Immutable Export Engine

**Files:** Create `src/offscreen/audio_export_engine.ts`, `tests/unit/audio_export_engine.test.ts`; modify `src/offscreen/offscreen.ts`

**Interfaces consumed:** Current prepared `SpeechUnit[]`, language/style/speed, `SynthesisArbiter.background()`, runway callback, one-time handle store, encoder adapter.

**Interfaces produced:**

```ts
export interface PreparedAudioExport {
	jobId: string;
	playbackSessionId: string;
	units: readonly SpeechUnit[];
	language: string;
	voiceStyleId: string;
	style: Style;
	speed: number;
	estimate: AudioExportEstimate;
}

export interface AudioExportEngine {
	prepare(input: PreparedAudioExport): void;
	start(jobId: string): Promise<void>;
	cancel(jobId: string): Promise<void>;
	discard(jobId: string): Promise<void>;
	hasWork(): boolean;
}
```

Offscreen commands are `PREPARE_AUDIO_EXPORT`, `START_AUDIO_EXPORT`, `CANCEL_AUDIO_EXPORT`, and `DISCARD_AUDIO_EXPORT`. Progress messages contain metadata only.

- [ ] **Step 1: Write failing immutable-snapshot and lifecycle tests**

Test:

- `prepare()` clones the `SpeechUnit[]` and unit objects;
- playback position, speed changes, `stopAudio()`, and replacement sessions do not mutate the export;
- only one prepared/active job;
- stale preparation discard;
- handle is taken once and immediately removed;
- one unit is synthesized/added/released per loop;
- waiting state while runway is closed;
- foreground arrival prevents the next export unit;
- monotonic weighted progress and moving ETA;
- cancel before synthesis, during inference, during encoder backpressure, and during finalize;
- every failure/cancel removes handle and in-memory snapshot;
- success finalizes before reporting completion.

```ts
test('continues the old immutable snapshot after playback replacement', async () => {
	const sourceUnits = [unit('old one'), unit('old two')];
	engine.prepare(prepared('job-1', 'session-old', sourceUnits));
	sourceUnits[0].text = 'mutated';
	setForegroundSession('session-new');
	openRunway();
	await engine.start('job-1');
	assert.deepEqual(synthesizedTexts, ['old one', 'old two']);
});
```

- [ ] **Step 2: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_engine.test.ts
```

- [ ] **Step 3: Implement the engine**

Use a cancellation token checked before runway wait, before/after inference, before/after `encoder.add()`, and before finalization. Wait for runway with an event/promise notified by playback state changes; do not poll in a tight loop.

Separate raw synthesis from playback metrics:

```ts
type SynthesisOwner = 'playback' | 'export';
async function synthesizeUnit(
	unit: SpeechUnit,
	lang: string,
	style: Style,
	speed: number,
	owner: SynthesisOwner,
): Promise<AudioBuffer>;
```

Only `owner === 'playback'` updates playback gap/inference metrics. Both owners use the same `ttsEngine`.

Report `waiting-for-playback` only on a state transition. Throttle progress messages to meaningful percentage/byte changes so `StreamTarget.onwrite` does not flood runtime messaging.

- [ ] **Step 4: Integrate offscreen commands without coupling background data**

`PREPARE_AUDIO_EXPORT` validates the current extension session ID, clones the current full unit plan, current resolved style, language, style ID, speed, and estimate. It must not use `currentUnitIndex`.

`STOP` and a new `PLAY` clear playback buffers but not the export engine. Offscreen teardown naturally loses the in-memory snapshot; background handles that as `interrupted`.

- [ ] **Step 5: Verify and commit**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_engine.test.ts tests/unit/synthesis_arbiter.test.ts tests/unit/audio_export_runway.test.ts tests/unit/offscreen_audio.test.ts
rtk pnpm build
rtk git add src/offscreen/audio_export_engine.ts src/offscreen/offscreen.ts tests/unit/audio_export_engine.test.ts
rtk git commit -m "Add offscreen audio export engine"
```

---

### Task 7: Add the Background One-Job Coordinator

**Files:** Create `src/background/audio_export_state.ts`, `src/background/audio_export.ts`, `tests/unit/audio_export_state.test.ts`, `tests/unit/audio_export_coordinator.test.ts`; modify `src/background/background.ts`, `src/background/offscreen_transport.ts`, `tests/unit/offscreen_transport.test.ts`

**Interfaces consumed:** Active playback snapshot, offscreen export commands/progress, `chrome.storage.session`, handle cleanup.

**Interfaces produced:** Runtime actions `GET_AUDIO_EXPORT_STATE`, `PREPARE_AUDIO_EXPORT`, `START_AUDIO_EXPORT`, `CANCEL_AUDIO_EXPORT`, `DISCARD_AUDIO_EXPORT`; broadcast `AUDIO_EXPORT_STATE_UPDATE`.

- [ ] **Step 1: Write failing pure state-transition tests**

Encode only these transitions:

```text
idle -> preparing
preparing -> exporting | failed | idle
exporting <-> waiting-for-playback
exporting | waiting-for-playback -> cancelling | completed | failed
cancelling -> idle | failed
nonterminal -> interrupted (hydration only)
completed | failed | interrupted -> preparing | idle
```

Reject stale job IDs, state regression, decreasing progress, progress outside `0..100`, and a second active preparation.

- [ ] **Step 2: Write failing coordinator tests**

Test active-session validation, one job across surfaces, exact storage metadata, no content/handle/path/audio keys, prepare timeout after ten minutes, picker discard returning to idle, offscreen progress broadcast, moving ETA updates, terminal cleanup, and hydration of any nonterminal stored job as `interrupted`.

```ts
test('never resumes a persisted nonterminal job', async () => {
	storage.seed(activeJob({ state: 'exporting' }));
	await coordinator.hydrate();
	assert.equal(coordinator.snapshot()?.state, 'interrupted');
	assert.deepEqual(offscreenCommands, []);
	assert.deepEqual(handleDeletes, ['job-1']);
});
```

- [ ] **Step 3: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_state.test.ts tests/unit/audio_export_coordinator.test.ts tests/unit/offscreen_transport.test.ts
```

- [ ] **Step 4: Implement coordinator and background routing**

`PREPARE_AUDIO_EXPORT` accepts `{ jobId, playbackSessionId, title, outputFilename }`. It validates the active session and estimate, publishes `preparing`, ensures offscreen, and sends the prepared command. `START_AUDIO_EXPORT` is valid only for the prepared job. `DISCARD_AUDIO_EXPORT` removes the prepared snapshot and handle without a terminal error. `CANCEL_AUDIO_EXPORT` publishes `cancelling` before forwarding cancellation.

Persist only `AudioExportJobSnapshot`. Broadcast after every persisted change. Stable error codes are localized in UI, not stored as free-form messages.

- [ ] **Step 5: Make offscreen lifetime export-aware**

Create the offscreen document with:

```ts
reasons: [
	chrome.offscreen.Reason.AUDIO_PLAYBACK,
	chrome.offscreen.Reason.WORKERS,
	chrome.offscreen.Reason.BLOBS,
],
```

Update the justification to mention local TTS playback and local MP3 worker/WASM encoding. `closeOffscreenWhenIdle()` may close only when there is no active playback, suspended manual checkpoint, prepared export, or active export.

- [ ] **Step 6: Verify and commit**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_state.test.ts tests/unit/audio_export_coordinator.test.ts tests/unit/offscreen_transport.test.ts
rtk pnpm build
rtk git add src/background/audio_export_state.ts src/background/audio_export.ts src/background/background.ts src/background/offscreen_transport.ts tests/unit/audio_export_state.test.ts tests/unit/audio_export_coordinator.test.ts tests/unit/offscreen_transport.test.ts
rtk git commit -m "Coordinate one background audio export"
```

---

### Task 8: Add the Shared Popup and Side Panel Export Control

**Files:** Create `src/shared/audio_export_client.ts`, `src/shared/components/AudioExportButton.tsx`, `tests/unit/audio_export_client.test.ts`; modify `src/shared/components/PlaybackIcon.tsx`, `src/shared/theme.css`, `src/shared/locales/en.json`, `src/shared/locales/vi.json`, `src/popup/App.tsx`, `src/sidepanel/App.tsx`, `src/popup/popup.css`, `src/sidepanel/sidepanel.css`, `tests/e2e/fixtures.ts`, `tests/e2e/tts-controls.spec.ts`, `tests/e2e/side-panel.spec.ts`

**Interfaces consumed:** Playback session/estimate, background export state, picker, handle store.

**Interfaces produced:** One accessible Download/progress control on each requested surface.

- [ ] **Step 1: Write failing client tests**

Mirror `playback_client.ts`: missing/malformed callback responses fail, `lastError` rejects, and only strict `AUDIO_EXPORT_STATE_UPDATE` messages reach subscribers.

- [ ] **Step 2: Write failing UI tests**

In both Popup and Side Panel assert:

- disabled Download icon without an exportable active session/estimate;
- `Export MP3` accessible name and tooltip when ready;
- Enter/Space activation;
- `showSaveFilePicker` options exactly:

```ts
{
	id: 'readit-mp3-export',
	startIn: 'music',
	suggestedName,
	types: [{ description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } }],
}
```

- same hydrated exporting/waiting/cancelling/completed/failed/interrupted state;
- long-content alert dialog at `>= 3600` seconds with Cancel/Continue;
- cancel confirmation when the progress control is activated;
- status live region;
- no control in Reader.

- [ ] **Step 3: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_client.test.ts
rtk pnpm build
rtk pnpm test:e2e tests/e2e/tts-controls.spec.ts tests/e2e/side-panel.spec.ts
```

- [ ] **Step 4: Implement the picker handshake in the shared component**

The confirmed click handler must invoke preparation and the picker before awaiting either:

```ts
const preparePromise = prepareAudioExport({
	jobId,
	playbackSessionId: session.sessionId,
	title,
	outputFilename: suggestedName,
});
const pickerPromise = window.showSaveFilePicker(pickerOptions(suggestedName));

try {
	const [prepared, handle] = await Promise.all([preparePromise, pickerPromise]);
	if (!prepared.success) throw new Error(prepared.error);
	await putAudioExportHandle(jobId, handle);
	const started = await startAudioExport(jobId);
	if (!started.success) throw new Error(started.error);
} catch (error) {
	await deleteAudioExportHandle(jobId);
	await discardAudioExport(jobId);
	if ((error as DOMException).name !== 'AbortError') setLocalError('exportStartFailed');
}
```

For the long warning, run this handler from the dialog's Continue button so Save As still begins from a fresh user gesture. Picker cancellation leaves no failed job or alert.

- [ ] **Step 5: Render exact visual/accessibility states**

Add only the icons required by this control: Download, Check, Warning; draw the progress ring with CSS/SVG in `AudioExportButton`. Use `title` plus `aria-label`, preserve visible focus, and announce state changes through `role="status"`/`aria-live="polite"`.

Add localized strings for every state, warning text, duration/size labels, Continue, Cancel, cancel confirmation, picker/start/write/encoding/interruption errors, and completion.

- [ ] **Step 6: Integrate without transport refactors**

Popup: place the component in both default and themed playback-control branches.

Side Panel: place it in the active current-page branch and active manual-session branch. Ensure only one instance is rendered for the active session.

Do not add it to `src/reader/App.tsx`.

- [ ] **Step 7: Verify and commit**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_client.test.ts
rtk pnpm build
rtk pnpm test:e2e tests/e2e/tts-controls.spec.ts tests/e2e/side-panel.spec.ts
rtk git add src/shared/audio_export_client.ts src/shared/components/AudioExportButton.tsx src/shared/components/PlaybackIcon.tsx src/shared/theme.css src/shared/locales/en.json src/shared/locales/vi.json src/popup/App.tsx src/sidepanel/App.tsx src/popup/popup.css src/sidepanel/sidepanel.css tests/unit/audio_export_client.test.ts tests/e2e/fixtures.ts tests/e2e/tts-controls.spec.ts tests/e2e/side-panel.spec.ts
rtk git commit -m "Add MP3 export controls"
```

---

### Task 9: Prove Real MP3 Streaming, All Sources, and Playback Priority

**Files:** Create `tests/e2e/audio-export-runtime.spec.ts`, `tests/e2e/audio-export-ui.spec.ts`, `tests/e2e/mp3.ts`; modify `tests/e2e/fixtures.ts`, `tests/e2e/reading-state.spec.ts`, `tests/e2e/word-highlight-runtime.spec.ts` only where shared helpers are needed

**Interfaces consumed:** Complete UI/background/offscreen flow and real built extension.

**Interfaces produced:** Runtime evidence that the feature works under the extension CSP without a native-dialog automation dependency.

- [ ] **Step 1: Add an OPFS-backed picker adapter for E2E only**

Before opening the extension surface, inject:

```ts
window.showSaveFilePicker = async () => {
	const root = await navigator.storage.getDirectory();
	return await root.getFileHandle('readit-export-test.mp3', { create: true });
};
```

This returns a real structured-cloneable `FileSystemFileHandle`, exercises IndexedDB and the real offscreen writer, and avoids automating Chrome's native Save As dialog. Production code remains unchanged.

- [ ] **Step 2: Add a minimal MP3 frame inspector**

`tests/e2e/mp3.ts` scans ID3/Xing and MPEG frame headers and returns:

```ts
export interface Mp3Inspection {
	frameCount: number;
	bitrateKbps: number;
	channelCount: 1 | 2;
	durationSeconds: number;
}
```

Reject invalid sync words and inconsistent headers. The runtime test must assert nonzero frames, 96 kbps, mono, and duration within tolerance of deterministic short PCM/TTS output.

- [ ] **Step 3: Test the real offscreen encoder**

Build, start a short reading session using the existing seeded model fixture, export through the OPFS picker, wait for `completed`, read the file back from OPFS, and inspect it. Also assert recorded requests contain no encoder CDN/remote JS/WASM URL.

Cancel a second export during backpressure and assert the OPFS file is absent or zero-length/uncommitted. Force an encoder/write failure and assert `failed`, no committed partial file, and a retryable UI state.

- [ ] **Step 4: Test all source snapshots and cross-surface ownership**

Cover article, selection, pasted/manual, Google Docs document-reader, and PDF document-reader session variants. Assert every variant enables export and produces its source-specific name.

Start from Popup, hydrate progress in Side Panel, cancel there, and assert one shared job. Close both surfaces during a real short export and reopen one to observe completion.

- [ ] **Step 5: Test replacement and priority**

Start export A, then start playback session B. Assert export A's output contains only A's planned units and completes. Reuse playback metrics to assert:

- no dropped spoken unit;
- unit sequence remains ordered;
- no export-induced gap above the repository's existing playback threshold;
- export reports `waiting-for-playback` when runway is insufficient and resumes after playback becomes idle/safe.

- [ ] **Step 6: Test interruption and long content**

Seed a nonterminal job, restart the service worker/offscreen context, and assert `interrupted` with no resume command. Use a synthetic estimate over 120 minutes to verify warning/continuation and no hard cap without synthesizing 120 minutes of audio.

- [ ] **Step 7: Run focused runtime verification and commit**

```bash
rtk pnpm build
rtk pnpm test:e2e tests/e2e/audio-export-ui.spec.ts tests/e2e/audio-export-runtime.spec.ts tests/e2e/reading-state.spec.ts
rtk git add tests/e2e/audio-export-runtime.spec.ts tests/e2e/audio-export-ui.spec.ts tests/e2e/mp3.ts tests/e2e/fixtures.ts tests/e2e/reading-state.spec.ts tests/e2e/word-highlight-runtime.spec.ts
rtk git commit -m "Verify MP3 export runtime behavior"
```

Omit unchanged files from `git add`.

---

### Task 10: Make Privacy, Archive Validation, and Release Checks Blocking

**Files:** Modify `scripts/validate-extension-archive.mjs`, `.github/workflows/release-extension.yml`, `docs/privacy-policy.md`, `docs/RELEASING.md`; create `tests/unit/audio_export_release.test.ts`

**Interfaces consumed:** Production `dist/`, release ZIP, pinned package metadata/license files.

**Interfaces produced:** A release gate that fails on missing licenses/notices, missing local encoder assets, remote executable references, missing legal-review documentation, or permission drift.

- [ ] **Step 1: Write failing release-policy tests**

Test pure helpers or a synthetic archive fixture for:

- missing `licenses/mediabunny-MPL-2.0.txt`;
- missing `licenses/lame-COPYING.txt`;
- notice version different from `package.json`;
- missing stable Mediabunny 1.51.0 or LAME 3.100 source links in the notice;
- release documentation missing the legal-review prerequisite;
- no locally bundled MP3 encoder asset;
- `http://`, `https://`, `//cdn`, `unpkg`, or `jsdelivr` in encoder/runtime chunks;
- a new `downloads`, history, identity, or notification permission;
- minimum Chrome version changed from 127.

- [ ] **Step 2: Run and observe failure**

```bash
rtk node --experimental-strip-types --test tests/unit/audio_export_release.test.ts
```

- [ ] **Step 3: Extend archive validation**

Require both verbatim license files and compare them byte-for-byte with `dist/`. Require the pinned versions, LAME acknowledgement, and stable project/source links in `THIRD_PARTY_NOTICES.txt`. Identify the hashed encoder chunk by a stable build marker exported from `audio_export_encoder.ts`, require it in the ZIP, and scan executable archive files for remote `import()`, `importScripts()`, `fetch()`, or `Worker()` targets. Plain project/license URLs are attribution data and must not be mistaken for executable loading.

Keep model/ONNX validations intact. If the build emits separate encoder worker/WASM files, add only their verified exact patterns to the runtime allowlist. If 1.51.0 keeps worker/WASM embedded in the local encoder chunk, require the audited embedded markers instead. Never broaden the allowlist to arbitrary `.wasm` or `.mjs`.

- [ ] **Step 4: Update CI and release documentation**

CI's third-party notice step must check:

```text
mediabunny 1.51.0
@mediabunny/mp3-encoder 1.51.0
LAME 3.100
licenses/mediabunny-MPL-2.0.txt
licenses/lame-COPYING.txt
```

Document the exact dependency/license-text/source-link audit, local dynamic
chunk inspection, native Save As manual check, no-new-permission inspection,
and the required legal review before public distribution in `docs/RELEASING.md`.

- [ ] **Step 5: Update privacy policy accurately**

Set the date to July 29, 2026 and disclose:

- explicit user-directed local MP3 export;
- complete-session text and per-unit PCM held only in live extension memory;
- temporary IndexedDB file handle used only to connect Save As to offscreen writing;
- MP3 bytes written only to the selected local file;
- no upload, backend, telemetry, export history, or content/audio persistence in extension storage;
- cancellation/failure aborts partial output and interruption does not resume.

Do not imply the extension collects the selected path or exported file.

- [ ] **Step 6: Run the complete release verification**

```bash
rtk pnpm lint
rtk pnpm test:unit
rtk pnpm build
rtk pnpm validate:manifest
rtk pnpm validate:vi-assets:release
rtk mkdir -p .tmp
```

From `dist/`, package the archive:

```bash
rtk zip -qr ../.tmp/readit-audio-export.zip . -x '*.DS_Store'
```

Then from the repository root:

```bash
rtk pnpm validate:release-zip .tmp/readit-audio-export.zip
rtk pnpm test:e2e
rtk rg -n "\"downloads\"|\"history\"|\"identity\"|\"notifications\"" dist/manifest.json
rtk rg -n "https?://|cdn|unpkg|jsdelivr" dist/static dist/src/offscreen
rtk git diff --check
rtk git status --short
```

Expected:

- all automated checks pass;
- forbidden permission search returns no matches;
- executable remote-code search returns no matches other than non-executable documentation/license strings explicitly excluded by the validator;
- ZIP contains local encoder code, embedded worker/WASM, notices, and exact license texts.

- [ ] **Step 7: Perform the native Chrome Save As check**

Load `dist/` unpacked in Chrome 127+ and verify:

1. Download button in Popup and Side Panel;
2. Save As opens from the click/Continue gesture with `.mp3`, Music start directory, and suggested name;
3. playback continues while export advances or waits;
4. the saved file plays, is mono, and reports 96 kbps;
5. cancellation/failure leaves no committed partial file;
6. browser/extension reload shows `interrupted` and never resumes.

Record Chrome version, platform, source type, duration, output size, and result in the implementation handoff or PR description. Do not add a temporary evidence file outside `/.tmp/`.

- [ ] **Step 8: Commit final release/docs changes**

```bash
rtk git add scripts/validate-extension-archive.mjs .github/workflows/release-extension.yml docs/privacy-policy.md docs/RELEASING.md tests/unit/audio_export_release.test.ts
rtk git commit -m "Gate MP3 export release compliance"
```

---

## Final Review Checklist

- [ ] Re-read every acceptance criterion in the approved spec and link it to a passing test or the native Save As check.
- [ ] Search for placeholders: `rtk rg -n "TODO|FIXME|TBD" src tests scripts docs/privacy-policy.md docs/RELEASING.md`.
- [ ] Confirm every shared message/response type has a matching runtime validator and test.
- [ ] Confirm no `SpeechUnit`, content, handle, path, PCM, MP3 bytes, or encoder object reaches `chrome.storage`.
- [ ] Confirm IndexedDB records contain only `{ jobId, handle }` and are removed on every terminal/stale path.
- [ ] Confirm `BufferTarget`, Blob assembly, and remote imports are absent from production export code.
- [ ] Confirm only one export buffer is retained and playback prefetch remains one unit.
- [ ] Confirm Popup and Side Panel hydrate one background-owned job; Reader is unchanged.
- [ ] Confirm `minimum_chrome_version` remains 127 and no new permission was added.
- [ ] Confirm exact package versions, copyright, project/source links, MPL text, LAME designation, LAME `COPYING`, and archive contents were audited; public release also requires legal review.
- [ ] Run `rtk graphify update .` after implementation and include generated graph changes only if repository policy tracks them.
- [ ] Run the complete Task 10 verification again after the final code review.
