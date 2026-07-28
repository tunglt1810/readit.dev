# Duty-Cycled Offscreen Pause Keepalive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an `AUDIO_PLAYBACK` offscreen document alive during a long pause with a 250 ms pulse every 20 seconds, while releasing every auxiliary audio resource between pulses and preserving exact resume.

**Architecture:** Replace the continuous auxiliary oscillator with a generation-guarded, one-shot timer cycle inside `pause_keepalive.ts`. Each cycle creates one short-lived `AudioContext`, plays a 20 Hz pulse above Chromium's audibility threshold, closes the context, clears all node references, and schedules the next cycle only after cleanup. Existing Pause, Resume, Stop, checkpoint, completion, and error integration remains owned by `offscreen.ts`.

**Tech Stack:** TypeScript, Web Audio API, Chrome Manifest V3 Offscreen API, Node test runner, Playwright, pnpm.

## Global Constraints

- Keep article, selection, manual text, synthesized samples, and decoded audio out of extension storage.
- Preserve the primary suspended `AudioContext`, source node, buffer, session ID, source identity, offset, and highlighting state for exact resume.
- Use fixed pulse parameters: 20 Hz, gain `0.001`, duration 250 ms, normal delay 20 seconds, retry delay 2 seconds.
- Use chained `setTimeout`, never `setInterval`, so cleanup and the next pulse cannot overlap.
- Between pulses, retain no auxiliary `AudioContext`, `OscillatorNode`, or `GainNode`.
- Keep the existing lost-offscreen fallback: fail the active session, show Read Again, and remove stale Stop controls.
- Do not change the manifest, public UI, background coordinator protocol, or storage schema.
- Keep changes surgical to the four runtime/test files and the approved design/plan documents.

---

## File map

- Modify `src/offscreen/pause_keepalive.ts`: own the pulse scheduler, short-lived Web Audio resources, retry behavior, generation guards, teardown, and debug snapshot.
- Modify `tests/unit/pause_keepalive.test.ts`: use deterministic fake timers and fake audio contexts to prove pulse timing, cleanup, retries, and start/stop races.
- Modify `src/offscreen/offscreen.ts`: inject browser timers into the helper and expose its resource state through the existing offscreen debug hook.
- Modify `tests/e2e/reading-state.spec.ts`: assert the offscreen document survives the 30-second cutoff while the auxiliary context is absent between pulses.
- Verify `docs/specs/2026-07-28-offscreen-paused-resume-design.md` against the implemented constants and lifecycle.

---

### Task 1: Implement the duty-cycled helper test-first

**Files:**

- Modify: `tests/unit/pause_keepalive.test.ts`
- Reference: `docs/specs/2026-07-28-offscreen-paused-resume-design.md`

**Interfaces:**

- Consumes:

```ts
createPauseKeepalive(
	createAudioContext: () => PauseKeepaliveAudioContext,
	scheduler: PauseKeepaliveScheduler,
): PauseKeepalive
```

- Produces the tested pulse scheduler, debug state, and helper lifecycle consumed by Task 2.

- [ ] **Step 1: Replace the continuous-oscillator fixture with a deterministic scheduler**

Add a fake scheduler that stores one-shot callbacks by numeric handle and advances virtual time without sleeping:

```ts
type ScheduledTask = {
	handle: number;
	atMs: number;
	callback: () => void;
};

function createScheduler() {
	let nowMs = 0;
	let nextHandle = 1;
	const tasks = new Map<number, ScheduledTask>();

	const scheduler: PauseKeepaliveScheduler = {
		setTimeout(callback, delayMs) {
			const handle = nextHandle++;
			tasks.set(handle, { handle, atMs: nowMs + delayMs, callback });
			return handle;
		},
		clearTimeout(handle) {
			tasks.delete(handle);
		},
	};

	async function advanceBy(delayMs: number): Promise<void> {
		const targetMs = nowMs + delayMs;
		while (true) {
			const next = [...tasks.values()]
				.filter((task) => task.atMs <= targetMs)
				.sort((left, right) => left.atMs - right.atMs || left.handle - right.handle)[0];
			if (!next) {
				break;
			}
			nowMs = next.atMs;
			tasks.delete(next.handle);
			next.callback();
			await Promise.resolve();
			await Promise.resolve();
		}
		nowMs = targetMs;
	}

	return {
		scheduler,
		advanceBy,
		pendingCount: () => tasks.size,
		nextDelayMs: () => Math.min(...[...tasks.values()].map((task) => task.atMs - nowMs)),
	};
}
```

Extend the fake oscillator with `onended`, scheduled stop time, and a `finish()` method that invokes `onended`. Extend the fake context with `currentTime: 0`. Keep counters for `start`, `stop`, `disconnect`, `resume`, and `close`.

The lazy audio factory must support these deterministic controls:

```ts
type AudioFactoryOptions = {
	failResumeAt?: number;
};

type FakeAudioContextControl = ReturnType<typeof createAudioContext> & {
	holdClose(): () => void;
};

function createAudioContextFactory(options: AudioFactoryOptions = {}): {
	create(): PauseKeepaliveAudioContext;
	contextsCreated(): number;
	latest(): FakeAudioContextControl;
};
```

`failResumeAt: 1` makes the first created context reject `resume()`. `holdClose()` replaces `close()` with a pending promise and returns the resolver used by the teardown-race test.

- [ ] **Step 2: Write a failing test for the idle period and one complete pulse**

Use the fixed constants rather than literal test delays:

```ts
test('waits before pulsing and releases every audio resource after one short pulse', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	assert.equal(audio.contextsCreated(), 0);

	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS - 1);
	assert.equal(audio.contextsCreated(), 0);

	await clock.advanceBy(1);
	assert.equal(audio.contextsCreated(), 1);
	const fake = audio.latest();
	assert.equal(fake.oscillator.startCalls, 1);
	assert.equal(fake.oscillator.stopAtSeconds, PAUSE_KEEPALIVE_PULSE_MS / 1000);
	assert.equal(fake.gain.gain.value, PAUSE_KEEPALIVE_GAIN);
	assert.equal(keepalive.getDebugState().pulseActive, true);

	fake.oscillator.finish();
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(fake.oscillator.disconnectCalls, 1);
	assert.equal(fake.gain.disconnectCalls, 1);
	assert.equal(fake.closeCalls(), 1);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	assert.equal(clock.nextDelayMs(), PAUSE_KEEPALIVE_INTERVAL_MS);
});
```

Implement `createAudioContextFactory()` as a lazy harness:

```ts
function createAudioContextFactory() {
	const created: ReturnType<typeof createAudioContext>[] = [];
	return {
		create: () => {
			const fake = createAudioContext();
			created.push(fake);
			return fake.context;
		},
		contextsCreated: () => created.length,
		latest: () => {
			const fake = created.at(-1);
			assert.ok(fake);
			return fake;
		},
	};
}
```

Do not instantiate a fake context until the factory is invoked; this makes `contextsCreated()` prove the memory boundary before the first pulse.

- [ ] **Step 3: Write failing tests for concurrency and failure cleanup**

Add these named cases with explicit assertions:

```ts
test('repeated start calls arm one timer and create one pulse', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await Promise.all([keepalive.start(), keepalive.start()]);
	assert.equal(clock.pendingCount(), 1);
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	assert.equal(audio.contextsCreated(), 1);
	await keepalive.stop();
});

test('stop during the idle delay cancels the timer without creating a context', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await keepalive.stop();
	assert.equal(clock.pendingCount(), 0);
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	assert.equal(audio.contextsCreated(), 0);
	assert.deepEqual(keepalive.getDebugState(), {
		running: false,
		timerScheduled: false,
		pulseActive: false,
	});
});

test('stop during a pulse stops and closes it without scheduling another pulse', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	const fake = audio.latest();
	await keepalive.stop();

	assert.equal(fake.oscillator.disconnectCalls, 1);
	assert.equal(fake.gain.disconnectCalls, 1);
	assert.equal(fake.closeCalls(), 1);
	assert.equal(clock.pendingCount(), 0);
	assert.deepEqual(keepalive.getDebugState(), {
		running: false,
		timerScheduled: false,
		pulseActive: false,
	});
});

test('repeated stop calls share one active-pulse teardown', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	const releaseClose = audio.latest().holdClose();
	const firstStop = keepalive.stop();
	const secondStop = keepalive.stop();

	releaseClose();
	await Promise.all([firstStop, secondStop]);
	assert.equal(audio.latest().closeCalls(), 1);
	assert.equal(clock.pendingCount(), 0);
});

test('start during teardown waits before arming a replacement generation', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory();
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	const releaseClose = audio.latest().holdClose();
	const stopping = keepalive.stop();
	const restarting = keepalive.start();

	await Promise.resolve();
	assert.equal(clock.pendingCount(), 0);
	releaseClose();
	await Promise.all([stopping, restarting]);
	assert.equal(clock.pendingCount(), 1);
	assert.equal(clock.nextDelayMs(), PAUSE_KEEPALIVE_INTERVAL_MS);
	await keepalive.stop();
});

test('failed pulse creation cleans partial resources and retries after two seconds', async () => {
	const clock = createScheduler();
	const audio = createAudioContextFactory({ failResumeAt: 1 });
	const keepalive = createPauseKeepalive(audio.create, clock.scheduler);

	await keepalive.start();
	await clock.advanceBy(PAUSE_KEEPALIVE_INTERVAL_MS);
	await Promise.resolve();
	await Promise.resolve();

	const failed = audio.latest();
	assert.equal(failed.closeCalls(), 1);
	assert.equal(clock.nextDelayMs(), PAUSE_KEEPALIVE_RETRY_MS);
	assert.deepEqual(keepalive.getDebugState(), {
		running: true,
		timerScheduled: true,
		pulseActive: false,
	});
	await keepalive.stop();
});
```

For each case, assert the complete debug state and exact call counts. Do not assert only that a promise resolves.

- [ ] **Step 4: Run the focused unit test and confirm the red state**

Run:

```bash
CI=true node --experimental-strip-types --test tests/unit/pause_keepalive.test.ts
```

Expected: FAIL because `PauseKeepaliveScheduler`, `PAUSE_KEEPALIVE_INTERVAL_MS`, `PAUSE_KEEPALIVE_PULSE_MS`, `PAUSE_KEEPALIVE_RETRY_MS`, and `getDebugState()` do not exist yet.

- [ ] **Step 5: Add pulse constants and dependency interfaces**

```ts
export const PAUSE_KEEPALIVE_FREQUENCY_HZ = 20;
export const PAUSE_KEEPALIVE_GAIN = 0.001;
export const PAUSE_KEEPALIVE_PULSE_MS = 250;
export const PAUSE_KEEPALIVE_INTERVAL_MS = 20_000;
export const PAUSE_KEEPALIVE_RETRY_MS = 2_000;

export interface PauseKeepaliveScheduler {
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
}

export type PauseKeepaliveDebugState = {
	running: boolean;
	timerScheduled: boolean;
	pulseActive: boolean;
};

export interface PauseKeepalive {
	start(): Promise<void>;
	stop(): Promise<void>;
	getDebugState(): PauseKeepaliveDebugState;
}
```

Add `currentTime: number` to `PauseKeepaliveAudioContext`. Keep `createOscillator()`, `createGain()`, `resume()`, and `close()` unchanged so production continues using native Web Audio nodes.

Represent an active pulse explicitly:

```ts
type ActivePulse = {
	context: PauseKeepaliveAudioContext;
	oscillator: OscillatorNode | null;
	gain: GainNode | null;
	cleanup: Promise<void> | null;
};
```

- [ ] **Step 6: Implement idempotent per-pulse cleanup**

Use one cleanup promise per pulse. Keep oscillator stop, oscillator disconnect, gain disconnect, and context close in separate `try` blocks so one failure cannot skip the remaining cleanup:

```ts
function cleanupPulse(pulse: ActivePulse): Promise<void> {
	if (pulse.cleanup) {
		return pulse.cleanup;
	}
	pulse.cleanup = (async () => {
		try {
			pulse.oscillator?.stop();
		} catch (_error) {}
		try {
			pulse.oscillator?.disconnect();
		} catch (_error) {}
		try {
			pulse.gain?.disconnect();
		} catch (_error) {}
		try {
			await pulse.context.close();
		} catch (_error) {}
		pulse.oscillator = null;
		pulse.gain = null;
	})();
	return pulse.cleanup;
}
```

Do not reuse a closed context for a later pulse.

- [ ] **Step 7: Implement the generation-guarded one-shot cycle**

Keep these state fields inside `createPauseKeepalive`:

```ts
let running = false;
let generation = 0;
let timerHandle: number | null = null;
let activePulse: ActivePulse | null = null;
let starting: Promise<void> | null = null;
let teardown: Promise<void> | null = null;
```

Scheduling must reject stale generations and duplicate timers:

```ts
function schedule(delayMs: number, expectedGeneration: number): void {
	if (!running || generation !== expectedGeneration || timerHandle !== null || activePulse !== null) {
		return;
	}
	timerHandle = scheduler.setTimeout(() => {
		timerHandle = null;
		void runPulse(expectedGeneration);
	}, delayMs);
}
```

`runPulse()` must:

1. Return immediately for a stale generation.
2. Create and register the `ActivePulse` before any awaited operation.
3. Configure sine frequency `20` and gain `0.001`.
4. Connect oscillator → gain → destination.
5. Await `context.resume()`.
6. Re-check generation before starting audio.
7. Start now and call `oscillator.stop(context.currentTime + 0.25)`.
8. Set `oscillator.onended` to finish cleanup and schedule the next normal delay.
9. On any error, clean partial resources and schedule the 2-second retry.

Use one completion function for natural end, stop-triggered end, and failure:

```ts
async function finishPulse(pulse: ActivePulse, expectedGeneration: number, failed: boolean): Promise<void> {
	await cleanupPulse(pulse);
	if (activePulse === pulse) {
		activePulse = null;
	}
	if (running && generation === expectedGeneration) {
		schedule(failed ? PAUSE_KEEPALIVE_RETRY_MS : PAUSE_KEEPALIVE_INTERVAL_MS, expectedGeneration);
	}
}
```

Ensure `onended` calls `void finishPulse(...)` only once by guarding with a local `finished` boolean.

- [ ] **Step 8: Implement start, stop, and debug state**

`start()` must schedule the first pulse after 20 seconds. If teardown from a previous generation is active, wait for it before scheduling:

```ts
function start(): Promise<void> {
	if (running) {
		return starting ?? Promise.resolve();
	}
	running = true;
	const expectedGeneration = ++generation;
	const begin = teardown ?? Promise.resolve();
	const pendingStart = begin.then(() => {
		if (running && generation === expectedGeneration) {
			schedule(PAUSE_KEEPALIVE_INTERVAL_MS, expectedGeneration);
		}
	});
	const trackedStart = pendingStart.finally(() => {
		if (starting === trackedStart) {
			starting = null;
		}
	});
	starting = trackedStart;
	return trackedStart;
}
```

`stop()` must set `running = false` and increment `generation` before its first await. Cancel the timer synchronously, then clean an active pulse:

```ts
function stop(): Promise<void> {
	running = false;
	generation++;
	if (timerHandle !== null) {
		scheduler.clearTimeout(timerHandle);
		timerHandle = null;
	}
	if (teardown) {
		return teardown;
	}
	if (!activePulse) {
		return starting ?? Promise.resolve();
	}
	const pulse = activePulse;
	const trackedTeardown = finishPulse(pulse, generation, false).finally(() => {
		if (teardown === trackedTeardown) {
			teardown = null;
		}
	});
	teardown = trackedTeardown;
	return trackedTeardown;
}
```

Return resource ownership without exposing nodes:

```ts
function getDebugState(): PauseKeepaliveDebugState {
	return {
		running,
		timerScheduled: timerHandle !== null,
		pulseActive: activePulse !== null,
	};
}
```

Before accepting the implementation, manually reason through Stop → immediate Start: the new generation cannot arm until old teardown resolves, and the old `onended` cannot schedule a timer for the new generation.

- [ ] **Step 9: Run the focused tests to green**

Run:

```bash
CI=true node --experimental-strip-types --test tests/unit/pause_keepalive.test.ts
```

Expected: all pause-keepalive tests PASS with zero cancelled or skipped tests.

- [ ] **Step 10: Run TypeScript/build verification**

Run:

```bash
CI=true pnpm build
```

Expected: `tsc` exits 0 and Rsbuild creates `dist/assets/offscreen.*.js`.

- [ ] **Step 11: Commit the helper if commits are in execution scope**

```bash
git add src/offscreen/pause_keepalive.ts tests/unit/pause_keepalive.test.ts
git commit -m "fix: pulse offscreen pause keepalive"
```

---

### Task 2: Wire browser timers and expose the memory invariant

**Files:**

- Modify: `src/offscreen/offscreen.ts:72-74`
- Modify: `src/offscreen/offscreen.ts:116-121`
- Test: `tests/e2e/reading-state.spec.ts:163-168`
- Test: `tests/e2e/reading-state.spec.ts:332-362`

**Interfaces:**

- Consumes `PauseKeepaliveScheduler` and `PauseKeepalive.getDebugState()` from Task 1.
- Produces this offscreen debug shape:

```ts
type OffscreenPlaybackDebug = {
	sessionId: string | null;
	sourceId: number;
	bufferOffsetSec: number;
	audioContextTime: number | null;
	pauseKeepalive: {
		running: boolean;
		timerScheduled: boolean;
		pulseActive: boolean;
	};
};
```

- [ ] **Step 1: Inject window timers into the helper**

Keep timer ownership browser-local and avoid importing Node timer types:

```ts
const pauseKeepalive = createPauseKeepalive(
	() => new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(),
	{
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle),
	},
);
```

Do not change the existing Pause and Resume ordering:

- Pause suspends the primary context before `pauseKeepalive.start()`.
- Resume awaits `pauseKeepalive.stop()` before resuming the primary context.
- Stop, natural completion, new playback, manual checkpoint, and synthesis error continue calling `pauseKeepalive.stop()`.

- [ ] **Step 2: Extend the existing debug hook**

Add the helper snapshot without exposing text, buffers, or audio samples:

```ts
(globalThis as unknown as { __readitPlaybackDebug?: () => unknown }).__readitPlaybackDebug = () => ({
	sessionId: currentExtensionSessionId,
	sourceId: currentSourceId,
	bufferOffsetSec: currentBufferOffsetSec,
	audioContextTime: audioCtx?.currentTime ?? null,
	pauseKeepalive: pauseKeepalive.getDebugState(),
});
```

- [ ] **Step 3: Extend the E2E debug type and assertions**

Immediately after Pause, assert the first pulse is scheduled but no auxiliary context is active:

```ts
expect(paused.pauseKeepalive).toEqual({
	running: true,
	timerScheduled: true,
	pulseActive: false,
});
```

After the existing 35-second wait, keep the offscreen context count and exact-resume assertions, then prove the first short-lived pulse has already released its context:

```ts
expect(held.pauseKeepalive).toEqual({
	running: true,
	timerScheduled: true,
	pulseActive: false,
});
```

After Resume, assert complete keepalive teardown:

```ts
expect(resumed.pauseKeepalive).toEqual({
	running: false,
	timerScheduled: false,
	pulseActive: false,
});
```

Do not weaken the existing source ID, buffer offset, primary audio time, lost-offscreen error, Read Again, or stale Stop assertions.

- [ ] **Step 4: Rebuild the unpacked extension**

Run:

```bash
CI=true pnpm build
```

Expected: build exits 0 and the new pulse constants/state machine are present in the generated offscreen bundle.

- [ ] **Step 5: Run the focused coordinator regression headless**

Run:

```bash
CI=true pnpm test:e2e tests/e2e/reading-state.spec.ts --grep "resumes the same session" --retries=0
```

Expected: the test PASSes quickly, verifies Pause/Resume and the lost-offscreen fallback, and annotates that headless Chromium has no audible output. It must not use headless mode as the oracle for the 30-second `AUDIO_PLAYBACK` lifetime.

- [ ] **Step 6: Run the same regression headed to verify real audibility**

Run:

```bash
CI=true pnpm test:e2e tests/e2e/reading-state.spec.ts --grep "resumes the same session" --headed --retries=0
```

Expected: the test PASSes after the real 35-second wait; `getOffscreenContextCount()` returns `1`, the primary source and offset are unchanged, and `pauseKeepalive.pulseActive` is `false`.

- [ ] **Step 7: Commit integration coverage if commits are in execution scope**

```bash
git add src/offscreen/offscreen.ts tests/e2e/reading-state.spec.ts
git commit -m "test: verify pulsed pause keepalive"
```

---

### Task 3: Run release-relevant verification and synchronize the graph

**Files:**

- Verify: `src/offscreen/pause_keepalive.ts`
- Verify: `src/offscreen/offscreen.ts`
- Verify: `tests/unit/pause_keepalive.test.ts`
- Verify: `tests/e2e/reading-state.spec.ts`
- Verify: `docs/specs/2026-07-28-offscreen-paused-resume-design.md`
- Verify: `docs/plans/2026-07-28-offscreen-paused-resume.md`
- Update generated graph: `graphify-out/`

**Interfaces:**

- Consumes all Task 1-2 outputs.
- Produces a release-ready verification record with no new failures.

- [ ] **Step 1: Run focused unit coverage again**

```bash
CI=true node --experimental-strip-types --test tests/unit/pause_keepalive.test.ts
```

Expected: all pause-keepalive tests PASS.

- [ ] **Step 2: Run the complete unit suite**

```bash
CI=true pnpm test:unit
```

Expected for this branch's current baseline: the new pause-keepalive tests PASS. The three existing theme/PDF failures may still appear; verify that no failure names or counts are added by this change and report those baseline failures separately.

- [ ] **Step 3: Build and validate the Free manifest**

```bash
CI=true pnpm build
CI=true pnpm validate:manifest
```

Expected: both commands exit 0; the manifest permission/reason boundary is unchanged.

- [ ] **Step 4: Run the full reading-state E2E file**

```bash
CI=true pnpm test:e2e tests/e2e/reading-state.spec.ts --retries=0
```

Expected: every reading-state test PASSes, including long pause, lost offscreen, pending model loading, tab lifecycle, and session replacement coverage.

- [ ] **Step 5: Update Graphify after code changes**

```bash
graphify update .
```

Expected: the graph records the new scheduler/debug interfaces and reports no update error.

- [ ] **Step 6: Check formatting boundaries and the literal diff**

```bash
pnpm exec biome check src/offscreen/pause_keepalive.ts src/offscreen/offscreen.ts tests/unit/pause_keepalive.test.ts tests/e2e/reading-state.spec.ts
git diff --check
git status --short
git diff -- src/offscreen/pause_keepalive.ts src/offscreen/offscreen.ts tests/unit/pause_keepalive.test.ts tests/e2e/reading-state.spec.ts docs/specs/2026-07-28-offscreen-paused-resume-design.md docs/plans/2026-07-28-offscreen-paused-resume.md
```

Expected:

- Biome exits 0.
- `git diff --check` prints nothing and exits 0.
- Only the scoped implementation, tests, approved docs, expected graph output, and pre-existing user changes appear.
- `.claude/settings.json` remains untouched.

- [ ] **Step 7: Create the final implementation commit only if requested**

If Tasks 1-2 were not committed separately and the user requests a commit:

```bash
git add src/offscreen/pause_keepalive.ts src/offscreen/offscreen.ts tests/unit/pause_keepalive.test.ts tests/e2e/reading-state.spec.ts docs/specs/2026-07-28-offscreen-paused-resume-design.md docs/plans/2026-07-28-offscreen-paused-resume.md
git commit -m "fix: keep paused offscreen playback alive"
```

Before committing, re-run `git diff --cached --check` and inspect `git diff --cached --stat` to ensure `.claude/settings.json` and unrelated files are not staged.
