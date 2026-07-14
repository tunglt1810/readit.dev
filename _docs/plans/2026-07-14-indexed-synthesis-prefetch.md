# Indexed Synthesis Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unindexed next-buffer slot with a keyed single-job coordinator so delayed or out-of-order synthesis cannot repeat, skip, or reorder speech units.

**Architecture:** Add a small browser-independent coordinator whose cache key is `{ session, unitIndex, speedVersion }`; prefetch and foreground reads share the same promise, while failed prefetch may receive one foreground retry. Integrate it into `offscreen.ts`, retain only current/next work, and guard playback callbacks with both session and unit index.

**Tech Stack:** TypeScript 6, Node 25 built-in test runner, Web Audio API, ONNX Runtime Web through the existing Supertonic wrapper, Biome, pnpm, Playwright.

## Global Constraints

- Execute after `_docs/plans/2026-07-14-weighted-speech-segmentation.md` so final listening covers both approved changes.
- Store implementation plans in `_docs/plans` and specifications in `_docs/specs`.
- Use TypeScript only; add no dependency, runtime model, network call, telemetry, or user-facing setting.
- Identify synthesis work by playback session, speech-unit index, and speed version.
- Permit at most one synthesis promise for the same active key and retain at most current/next keyed work.
- Stop, article replacement, voice replacement, and speed changes must make stale synthesis results unusable.
- Do not silently skip a unit after foreground synthesis failure.
- Preserve pause/resume behavior: resuming does not create a new session or synthesize the active buffer again.
- Keep all scratch artifacts under the repository's `.tmp/` directory; do not use the operating system temporary directory.
- Follow TDD: observe each new test fail before adding the implementation that makes it pass.
- Design source: `_docs/specs/2026-07-14-weighted-speech-segmentation-design.md`.

---

## File structure

- Create `src/offscreen/synthesis_coordinator.ts`: keyed promise sharing, prefetch-to-foreground retry, current/next retention, and invalidation.
- Create `tests/unit/synthesis_coordinator.test.ts`: deterministic deferred-promise coverage for the reported late-prefetch race and stale identities.
- Modify `src/offscreen/offscreen.ts`: remove `nextChunkBuffer`/`isPreFetching`, request exact indexed buffers, retain current/next keys, and guard source completion by unit index.
- Modify `_docs/evaluations/2026-07-14-vietnamese-pronunciation-listening.md`: add pending human scenarios for balanced segmentation and replay/stutter classification without changing the existing 16-of-20 gate.

### Task 1: Keyed synthesis coordinator

**Files:**
- Create: `tests/unit/synthesis_coordinator.test.ts`
- Create: `src/offscreen/synthesis_coordinator.ts`

**Interfaces:**
- Produces: `SynthesisKey { session: number; unitIndex: number; speedVersion: number }`.
- Produces: `IndexedSynthesisCoordinator<Input, Output>` with `prefetch`, `get`, `has`, `retain`, and `clear` methods.
- Guarantees: `prefetch(key)` followed by `get(key)` shares one promise; a failed prefetched promise permits one new foreground attempt; non-prefetch foreground failures are not automatically retried; explicit `retain` eviction or `clear` prevents stale readers from retrying.

- [ ] **Step 1: Write the failing coordinator tests**

Create `tests/unit/synthesis_coordinator.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	IndexedSynthesisCoordinator,
	type SynthesisKey,
} from '../../src/offscreen/synthesis_coordinator.ts';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function key(unitIndex: number, session = 1, speedVersion = 0): SynthesisKey {
	return { session, unitIndex, speedVersion };
}

test('shares a late prefetch with the foreground request for the same unit', async () => {
	const pending = deferred<string>();
	let calls = 0;
	const coordinator = new IndexedSynthesisCoordinator<string, string>(() => {
		calls++;
		return pending.promise;
	});

	coordinator.prefetch(key(1), 'unit-1');
	const foreground = coordinator.get(key(1), 'unit-1');
	assert.equal(calls, 1);

	pending.resolve('audio-1');
	assert.equal(await foreground, 'audio-1');
	assert.equal(await coordinator.get(key(1), 'unit-1'), 'audio-1');
	assert.equal(calls, 1);
});

test('retries once when an in-flight prefetch fails under a foreground reader', async () => {
	const first = deferred<string>();
	let calls = 0;
	const coordinator = new IndexedSynthesisCoordinator<string, string>((input) => {
		calls++;
		return calls === 1 ? first.promise : Promise.resolve(`retry:${input}`);
	});

	coordinator.prefetch(key(1), 'unit-1');
	const foreground = coordinator.get(key(1), 'unit-1');
	first.reject(new Error('prefetch failed'));

	assert.equal(await foreground, 'retry:unit-1');
	assert.equal(calls, 2);
});

test('shares one foreground retry when two readers observe the same failed prefetch', async () => {
	const first = deferred<string>();
	let calls = 0;
	const coordinator = new IndexedSynthesisCoordinator<string, string>((input) => {
		calls++;
		return calls === 1 ? first.promise : Promise.resolve(`retry-${calls}:${input}`);
	});

	coordinator.prefetch(key(1), 'unit-1');
	const firstReader = coordinator.get(key(1), 'unit-1');
	const secondReader = coordinator.get(key(1), 'unit-1');
	first.reject(new Error('prefetch failed'));

	assert.deepEqual(await Promise.all([firstReader, secondReader]), ['retry-2:unit-1', 'retry-2:unit-1']);
	assert.equal(calls, 2);
});

test('does not retry a failed foreground synthesis', async () => {
	let calls = 0;
	const coordinator = new IndexedSynthesisCoordinator<string, string>(() => {
		calls++;
		return Promise.reject(new Error('foreground failed'));
	});

	await assert.rejects(coordinator.get(key(0), 'unit-0'), /foreground failed/);
	assert.equal(calls, 1);
});

test('does not share work across unit, session, or speed identities', async () => {
	let calls = 0;
	const coordinator = new IndexedSynthesisCoordinator<string, string>(async (input) => {
		calls++;
		return input;
	});

	assert.deepEqual(
		await Promise.all([
			coordinator.get(key(0, 1, 0), 'session-1-unit-0'),
			coordinator.get(key(1, 1, 0), 'session-1-unit-1'),
			coordinator.get(key(0, 2, 0), 'session-2-unit-0'),
			coordinator.get(key(0, 1, 1), 'session-1-speed-1'),
		]),
		['session-1-unit-0', 'session-1-unit-1', 'session-2-unit-0', 'session-1-speed-1'],
	);
	assert.equal(calls, 4);
});

test('retains only requested keys and clear prevents stale reuse', async () => {
	const pending = new Map<number, Deferred<string>>();
	const coordinator = new IndexedSynthesisCoordinator<number, string>((unitIndex) => {
		const job = deferred<string>();
		pending.set(unitIndex, job);
		return job.promise;
	});

	coordinator.prefetch(key(0), 0);
	coordinator.prefetch(key(1), 1);
	coordinator.prefetch(key(2), 2);
	coordinator.retain([key(1), key(2)]);
	assert.equal(coordinator.has(key(0)), false);
	assert.equal(coordinator.has(key(1)), true);
	assert.equal(coordinator.has(key(2)), true);

	coordinator.clear();
	assert.equal(coordinator.has(key(1)), false);
	assert.equal(coordinator.has(key(2)), false);
	pending.get(1)?.resolve('stale-audio-1');
	await Promise.resolve();
	assert.equal(coordinator.has(key(1)), false);
});

for (const invalidation of ['clear', 'retain eviction'] as const) {
	test(`${invalidation} prevents a stale foreground reader from retrying a failed prefetch`, async () => {
		const first = deferred<string>();
		const staleKey = key(1);
		const failure = new Error('prefetch failed');
		let calls = 0;
		const coordinator = new IndexedSynthesisCoordinator<string, string>(() => {
			calls++;
			return calls === 1 ? first.promise : Promise.resolve('stale-retry');
		});

		coordinator.prefetch(staleKey, 'stale-unit');
		const foreground = coordinator.get(staleKey, 'stale-unit');
		if (invalidation === 'clear') {
			coordinator.clear();
		} else {
			coordinator.retain([key(2)]);
		}
		first.reject(failure);

		const outcome = await foreground.then(
			(value) => ({ status: 'resolved' as const, value }),
			(error: unknown) => ({ status: 'rejected' as const, error }),
		);
		assert.deepEqual(outcome, { status: 'rejected', error: failure });
		assert.equal(calls, 1);
		assert.equal(coordinator.has(staleKey), false);
	});
}

test('a new request for the same key synthesizes normally after clear', async () => {
	const first = deferred<string>();
	const synthesisKey = key(1);
	let calls = 0;
	const coordinator = new IndexedSynthesisCoordinator<string, string>((input) => {
		calls++;
		return calls === 1 ? first.promise : Promise.resolve(`fresh:${input}`);
	});

	coordinator.prefetch(synthesisKey, 'stale-unit');
	coordinator.clear();
	const fresh = coordinator.get(synthesisKey, 'fresh-unit');
	first.reject(new Error('stale prefetch failed'));

	assert.equal(await fresh, 'fresh:fresh-unit');
	await Promise.resolve();
	assert.equal(calls, 2);
	assert.equal(coordinator.has(synthesisKey), true);
});

test('caches completion out of order while callers consume in requested unit order', async () => {
	const jobs = new Map<number, Deferred<string>>();
	const coordinator = new IndexedSynthesisCoordinator<number, string>((unitIndex) => {
		const job = deferred<string>();
		jobs.set(unitIndex, job);
		return job.promise;
	});
	const consumed: string[] = [];

	coordinator.prefetch(key(1), 1);
	const first = coordinator.get(key(0), 0);
	jobs.get(1)?.resolve('audio-1');
	await Promise.resolve();
	assert.deepEqual(consumed, []);

	jobs.get(0)?.resolve('audio-0');
	consumed.push(await first);
	consumed.push(await coordinator.get(key(1), 1));
	assert.deepEqual(consumed, ['audio-0', 'audio-1']);
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
node --experimental-strip-types --test tests/unit/synthesis_coordinator.test.ts
```

Expected: FAIL with `ERR_ASSERTION` from an API-availability bootstrap: catch the missing-module import, observe
`typeof coordinator?.IndexedSynthesisCoordinator` as `'undefined'`, and assert that it is `'function'`. `ERR_MODULE_NOT_FOUND` itself is not RED
evidence. Add only the minimal export to make the bootstrap green, then add the behavior tests above one at a time and observe each assertion failure
before implementing that behavior.

- [ ] **Step 3: Implement keyed promise sharing and retry semantics**

Create `src/offscreen/synthesis_coordinator.ts` with:

```ts
export interface SynthesisKey {
	session: number;
	unitIndex: number;
	speedVersion: number;
}

interface SynthesisLease {
	active: boolean;
}

interface SynthesisEntry<Output> {
	key: SynthesisKey;
	lease: SynthesisLease;
	promise: Promise<Output>;
	prefetched: boolean;
}

function identity(key: SynthesisKey): string {
	return `${key.session}:${key.unitIndex}:${key.speedVersion}`;
}

export class IndexedSynthesisCoordinator<Input, Output> {
	private readonly entries = new Map<string, SynthesisEntry<Output>>();
	private readonly leases = new Map<string, SynthesisLease>();
	private readonly synthesize: (input: Input) => Promise<Output>;

	constructor(synthesize: (input: Input) => Promise<Output>) {
		this.synthesize = synthesize;
	}

	prefetch(key: SynthesisKey, input: Input): void {
		const id = identity(key);
		if (this.entries.has(id)) {
			return;
		}
		const entry = this.createEntry(key, input, true);
		void entry.promise.catch(() => undefined);
	}

	async get(key: SynthesisKey, input: Input): Promise<Output> {
		const id = identity(key);
		const existing = this.entries.get(id);
		if (!existing) {
			return await this.createEntry(key, input, false).promise;
		}
		try {
			return await existing.promise;
		} catch (error) {
			if (!existing.prefetched) {
				throw error;
			}
			if (!existing.lease.active) {
				throw error;
			}
			const current = this.entries.get(id);
			if (current && current !== existing) {
				return await current.promise;
			}
			return await this.createEntry(key, input, false).promise;
		}
	}

	has(key: SynthesisKey): boolean {
		return this.entries.has(identity(key));
	}

	retain(keys: readonly SynthesisKey[]): void {
		const retained = new Set(keys.map(identity));
		for (const [id, lease] of this.leases) {
			if (!retained.has(id)) {
				lease.active = false;
				this.leases.delete(id);
				this.entries.delete(id);
			}
		}
	}

	clear(): void {
		for (const lease of this.leases.values()) {
			lease.active = false;
		}
		this.leases.clear();
		this.entries.clear();
	}

	private createEntry(key: SynthesisKey, input: Input, prefetched: boolean): SynthesisEntry<Output> {
		const id = identity(key);
		let lease = this.leases.get(id);
		if (!lease) {
			lease = { active: true };
			this.leases.set(id, lease);
		}
		const entry: SynthesisEntry<Output> = {
			key,
			lease,
			promise: this.synthesize(input),
			prefetched,
		};
		this.entries.set(id, entry);
		void entry.promise.catch(() => {
			if (this.entries.get(id) === entry) {
				this.entries.delete(id);
			}
		});
		return entry;
	}
}
```

- [ ] **Step 4: Run the focused test and verify the green state**

Run:

```bash
node --experimental-strip-types --test tests/unit/synthesis_coordinator.test.ts
```

Expected: 10 tests pass, 0 fail.

- [ ] **Step 5: Format and check the coordinator files**

Run:

```bash
pnpm exec biome check --write src/offscreen/synthesis_coordinator.ts tests/unit/synthesis_coordinator.test.ts
pnpm exec biome check src/offscreen/synthesis_coordinator.ts tests/unit/synthesis_coordinator.test.ts
```

Expected: both commands exit 0 with no remaining diagnostics.

- [ ] **Step 6: Commit the coordinator**

```bash
git add src/offscreen/synthesis_coordinator.ts tests/unit/synthesis_coordinator.test.ts
git commit -m "Add indexed synthesis coordinator"
```

### Task 2: Offscreen indexed playback integration

**Files:**
- Modify: `src/offscreen/offscreen.ts:1-30`
- Modify: `src/offscreen/offscreen.ts:139-319`
- Modify: `src/offscreen/offscreen.ts:335-461`
- Test: `tests/unit/synthesis_coordinator.test.ts`
- Test: `tests/unit/offscreen_audio.test.ts`
- Test: `tests/e2e/reading-state.spec.ts`

**Interfaces:**
- Consumes: `IndexedSynthesisCoordinator<SynthesisInput, AudioBuffer>` and `SynthesisKey` from Task 1.
- Produces: `prefetchNextUnit(lang, style, session)` and `playNextUnit(lang, style, session)` using exact indexed keys.
- Preserves: existing `synthesizeUnit`, progress reporting, pause/resume, stop, voice loading, and speed behavior.
- Guarantees: a new `PLAY` reports `loading` and binds its payload speed before asynchronous preparation, so `CHANGE_SPEED` during loading keeps the same session and remains authoritative.

- [ ] **Step 1: Re-run the race regression before integration**

Run:

```bash
node --experimental-strip-types --test tests/unit/synthesis_coordinator.test.ts tests/unit/offscreen_audio.test.ts
```

Expected: all coordinator and audio tests pass before the offscreen call-site migration.

- [ ] **Step 1a: Lock the pending-load speed lifecycle with a failing E2E regression**

Add a test beside the existing pending-model lifecycle case in `tests/e2e/reading-state.spec.ts`. Start playback on the local routed article, capture the background `loading` session, change speed while the offscreen start remains pending, and poll the serialized background state without an arbitrary sleep:

```ts
test('speed change during pending model loading keeps the same loading session', async ({ context, extensionId }) => {
	const targetPage = await createTargetPage(context);
	const controlPage = await context.newPage();
	await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await targetPage.bringToFront();

	const start = sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' });
	expect(await responseWithin(start)).toEqual({ success: true });
	const loadingState = await responseWithin(getBackgroundState(controlPage));
	expect(loadingState).not.toBe('timed out');
	const loadingSession = (loadingState as PlaybackStateResponse).session;
	expect(loadingSession).toMatchObject({ status: 'loading' });

	const response = await responseWithin(sendCoordinatorCommand(controlPage, { action: 'CHANGE_SPEED', payload: { speed: 1.3 } }));
	expect(response).toEqual({ success: true });
	await expect
		.poll(async () => (await getBackgroundState(controlPage)).session)
		.toMatchObject({ sessionId: loadingSession?.sessionId, status: 'loading', speed: 1.3 });
});
```

Build the current production code, then run the focused E2E against the unpacked extension outside the sandbox where Chromium Crashpad is available:

```bash
pnpm build
pnpm exec playwright test tests/e2e/reading-state.spec.ts --grep "speed change during pending model loading"
```

Expected RED: `CHANGE_SPEED` responds successfully, then the state assertion fails because the background session becomes `null` after offscreen reports the stale `stopped` status.

- [ ] **Step 2: Import the coordinator and remove the unindexed queue state**

Add this import beside the other offscreen imports:

```ts
import { IndexedSynthesisCoordinator, type SynthesisKey } from './synthesis_coordinator';
```

Replace the queue state at `src/offscreen/offscreen.ts:25-30` with:

```ts
// Pipelining Queue state
let speechUnits: SpeechUnit[] = [];
let currentUnitIndex = 0;
let currentSourceNode: AudioBufferSourceNode | null = null;
```

- [ ] **Step 3: Add exact synthesis inputs, keys, and current/next retention**

Immediately after `synthesizeUnit` at `src/offscreen/offscreen.ts:174`, add:

```ts
interface SynthesisInput {
	unit: SpeechUnit;
	lang: string;
	style: Style;
	speed: number;
}

const synthesisCoordinator = new IndexedSynthesisCoordinator<SynthesisInput, AudioBuffer>(({ unit, lang, style, speed }) =>
	synthesizeUnit(unit, lang, style, speed),
);

function synthesisKey(session: number, unitIndex: number): SynthesisKey {
	return { session, unitIndex, speedVersion };
}

function isCurrentSynthesisKey(key: SynthesisKey): boolean {
	return key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion === speedVersion;
}

function retainedSynthesisKeys(session: number): SynthesisKey[] {
	const keys = [synthesisKey(session, currentUnitIndex)];
	if (currentUnitIndex + 1 < speechUnits.length) {
		keys.push(synthesisKey(session, currentUnitIndex + 1));
	}
	return keys;
}
```

- [ ] **Step 4: Replace unindexed prefetch with keyed prefetch**

Replace `preFetchNextChunk` at `src/offscreen/offscreen.ts:176-205` with:

```ts
function prefetchNextUnit(lang: string, style: Style, session: number): void {
	const unitIndex = currentUnitIndex + 1;
	if (unitIndex >= speechUnits.length) {
		return;
	}
	const key = synthesisKey(session, unitIndex);
	synthesisCoordinator.retain(retainedSynthesisKeys(session));
	synthesisCoordinator.prefetch(key, {
		unit: speechUnits[unitIndex],
		lang,
		style,
		speed: currentSpeed,
	});
}
```

- [ ] **Step 5: Invalidate keyed work whenever audio state is cleared**

Replace `stopAudio` at `src/offscreen/offscreen.ts:225-234` with:

```ts
function stopAudio() {
	stopCurrentSource();
	isPaused = false;
	synthesisCoordinator.clear();
	reportProgress('stopped');
	speechUnits = [];
	currentUnitIndex = 0;
	currentExtensionSessionId = null;
}
```

- [ ] **Step 6: Guard source playback and completion with the unit index**

Replace `playAudioBuffer` at `src/offscreen/offscreen.ts:239-270` with:

```ts
function playAudioBuffer(buffer: AudioBuffer, lang: string, style: Style, session: number, unitIndex: number) {
	if (!audioCtx || currentSourceNode !== null || session !== playbackSession || unitIndex !== currentUnitIndex) {
		return;
	}

	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.connect(audioCtx.destination);
	currentSourceNode = source;

	reportProgress('playing');

	source.onended = () => {
		if (
			currentSourceNode !== source ||
			session !== playbackSession ||
			unitIndex !== currentUnitIndex ||
			playbackStatus === 'stopped' ||
			isPaused
		) {
			return;
		}

		currentSourceNode = null;
		currentUnitIndex = unitIndex + 1;
		if (currentUnitIndex < speechUnits.length) {
			void playNextUnit(lang, style, session);
		} else {
			stopAudio();
		}
	};

	source.start(0);
}
```

- [ ] **Step 7: Replace foreground synthesis and next-buffer consumption with an exact keyed read**

Replace `playNextChunk` at `src/offscreen/offscreen.ts:275-319` with:

```ts
async function playNextUnit(lang: string, style: Style, session: number) {
	if (session !== playbackSession) {
		return;
	}

	if (currentUnitIndex >= speechUnits.length) {
		stopAudio();
		return;
	}

	const unitIndex = currentUnitIndex;
	const key = synthesisKey(session, unitIndex);
	const input: SynthesisInput = {
		unit: speechUnits[unitIndex],
		lang,
		style,
		speed: currentSpeed,
	};
	synthesisCoordinator.retain(retainedSynthesisKeys(session));
	reportProgress('loading');

	try {
		const buffer = await synthesisCoordinator.get(key, input);
		if (!isCurrentSynthesisKey(key)) {
			if (key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion !== speedVersion) {
				void playNextUnit(lang, style, session);
			}
			return;
		}
		playAudioBuffer(buffer, lang, style, session, unitIndex);
		prefetchNextUnit(lang, style, session);
	} catch (error) {
		if (key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion !== speedVersion) {
			void playNextUnit(lang, style, session);
			return;
		}
		if (isCurrentSynthesisKey(key)) {
			reportProgress('error', { error: (error as Error).message });
		}
	}
}
```

- [ ] **Step 8: Update PLAY initialization and speed invalidation call sites**

In the non-resume `PLAY` branch, extract the complete start payload before the asynchronous IIFE. Immediately after clearing old audio and binding the new extension session, bind the payload speed and report `loading`:

```ts
const data = payload as { article: { content: string; lang: string }; voiceStyleId: string; speed: number };
const { article, voiceStyleId, speed } = data;
const session = ++playbackSession;
stopAudio();
currentExtensionSessionId = sessionId;
currentSpeed = speed;
reportProgress('loading');
```

After `preparePlaybackUnits` resolves, leave only:

```ts
speechUnits = preparedUnits;
currentUnitIndex = 0;
isPaused = false;
```

Do not reassign `currentSpeed` after any asynchronous preparation; an intervening `CHANGE_SPEED` is authoritative.

Replace the first-play call at `src/offscreen/offscreen.ts:403-404` with:

```ts
void playNextUnit(article.lang, style, session);
```

Replace the mutable queue reset inside `CHANGE_SPEED` at `src/offscreen/offscreen.ts:455-459` with:

```ts
currentSpeed = speed;
speedVersion++;
synthesisCoordinator.clear();
reportProgress(playbackStatus);
```

- [ ] **Step 9: Run focused tests and production TypeScript build**

Run:

```bash
node --experimental-strip-types --test tests/unit/synthesis_coordinator.test.ts tests/unit/offscreen_audio.test.ts
pnpm build
pnpm exec playwright test tests/e2e/reading-state.spec.ts --grep "speed change during pending model loading"
```

Expected: all focused unit and E2E tests pass; TypeScript and Rsbuild exit 0 with no references to `nextChunkBuffer`, `isPreFetching`, `preFetchNextChunk`, or `playNextChunk`.

- [ ] **Step 10: Search for stale unindexed queue references**

Run:

```bash
rg -n "nextChunkBuffer|isPreFetching|preFetchNextChunk|playNextChunk" src/offscreen tests
```

Expected: no matches.

- [ ] **Step 11: Format and check the offscreen integration**

Run:

```bash
pnpm exec biome check --write src/offscreen/offscreen.ts
pnpm exec biome check src/offscreen/offscreen.ts src/offscreen/synthesis_coordinator.ts tests/unit/synthesis_coordinator.test.ts
```

Expected: both commands exit 0 with no remaining diagnostics.

- [ ] **Step 12: Commit the offscreen migration**

```bash
git add src/offscreen/offscreen.ts
git commit -m "Index offscreen synthesis prefetch"
```

### Task 3: Integrated regression and listening gate

**Files:**
- Modify: `_docs/evaluations/2026-07-14-vietnamese-pronunciation-listening.md:33-35`
- Verify: `tests/unit/synthesis_coordinator.test.ts`
- Verify: `tests/e2e/reading-state.spec.ts`
- Verify: `tests/e2e/tts-controls.spec.ts`
- Verify: `tests/e2e/vietnamese-pronunciation.spec.ts`

**Interfaces:**
- Consumes: the weighted segmenter plan and Tasks 1-2 of this plan.
- Produces: an explicit pending human-review matrix that distinguishes queue replay from acoustic repetition inside one buffer.

- [ ] **Step 1: Add targeted pending listening scenarios**

Insert this section before `Reviewer signature` in `_docs/evaluations/2026-07-14-vietnamese-pronunciation-listening.md`:

```markdown
## Weighted segmentation and replay follow-up

All four follow-up cases must have no semantic error, repeated/skipped unit, or
unacceptable TTFA regression. A repeated sound inside one buffer must be marked
as an acoustic issue; a whole unit played twice is a queue failure.

| ID    | Target                                      | Reviewer | Semantic error | Pause issue | Repeated/skipped | Acoustic repeat | TTFA concern |
| ----- | ------------------------------------------- | -------- | -------------- | ----------- | ---------------- | --------------- | ------------ |
| VI-21 | consecutive short sentences in one unit     | pending  | pending        | pending     | pending          | pending         | pending      |
| VI-22 | long sentence with mixed punctuation        | pending  | pending        | pending     | pending          | pending         | pending      |
| VI-23 | punctuation-sparse paragraph over 300 chars | pending  | pending        | pending     | pending          | pending         | pending      |
| VI-24 | speed change while next unit is synthesizing | pending  | pending        | pending     | pending          | pending         | pending      |
```

- [ ] **Step 2: Run the complete unit suite**

Run:

```bash
pnpm test:unit
```

Expected: exit 0 with no failed, skipped, or cancelled tests.

- [ ] **Step 3: Build and validate the production extension**

Run:

```bash
pnpm build
pnpm validate:manifest
```

Expected: both commands exit 0; `dist/manifest.json` remains inside the approved Free manifest boundary.

- [ ] **Step 4: Run the full Playwright suite**

Run:

```bash
pnpm test:e2e
```

Expected: exit 0 with no Playwright failures, retries exhausted, or unexpected skips.

- [ ] **Step 5: Check formatting and the complete diff**

Run:

```bash
pnpm exec biome check src/offscreen/segmentation.ts src/offscreen/vietnamese/speech_units.ts src/offscreen/synthesis_coordinator.ts src/offscreen/offscreen.ts tests/unit/segmentation.test.ts tests/unit/vietnamese_speech_units.test.ts tests/unit/synthesis_coordinator.test.ts
git diff --check
git status --short
```

Expected: Biome and `git diff --check` exit 0. Status shows only the listening-template edit plus unrelated pre-existing user files.

- [ ] **Step 6: Commit the listening gate template**

```bash
git add _docs/evaluations/2026-07-14-vietnamese-pronunciation-listening.md
git commit -m "Add speech replay listening gate"
```

- [ ] **Step 7: Hand the pending human gate to the reviewer**

Provide the reviewer with `_docs/evaluations/2026-07-14-vietnamese-pronunciation-listening.md` and the same voice/style inputs used for the original VI-01 through VI-20 comparison.

Expected: implementation automation stops with VI-21 through VI-24 still marked `pending`; no agent fills human judgments or claims the release listening gate passed.
