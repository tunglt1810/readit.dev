# edge-tts Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop edge-tts from downgrading to the on-device voice — by removing the SSML tag the endpoint rejects outright, and by replacing the three-fast-retries policy with a deep audio buffer that absorbs Microsoft's two-minute bad windows.

**Architecture:** Two independent parts. Part 1 (Tasks 1-3) removes `<break>` from the SSML and moves that 300ms of silence to the client side, which fixes a deterministic 100% failure for every non-Latin-script language. Part 2 (Tasks 4-8) buffers 180 seconds of audio ahead of the playhead, retries transient failures with a delay bounded by that buffer's headroom, and downgrades only when the buffer has actually been dry for 30 seconds. Retries wait *outside* the synthesis arbiter's slot so a retrying unit cannot block the buffer refill that makes retrying safe.

**Tech Stack:** TypeScript, Bun 1.4+, `node:test` + `node:assert/strict` for unit tests, Playwright for e2e, Biome for lint, rsbuild for the extension bundle.

**Spec:** `docs/specs/2026-09-08-edge-tts-stability-design.md`

## Global Constraints

- Bun only. Never `npm`, `pnpm`, `npx`, or `node`. Unit tests: `bun test tests/unit`. E2E: `bunx playwright test`. Lint: `bunx biome check .`.
- Unit tests use `node:test` and `node:assert/strict`, matching every file in `tests/unit/`. Do not introduce another test framework.
- Source files use tab indentation and single quotes, enforced by Biome. Run `bunx biome check --write .` before committing.
- Documentation and code comments are written in English.
- E2E tests load `dist/chrome`, so run `bun run build:chrome` before any Playwright run or the suite tests a stale bundle.
- `tests/e2e/edge-tts-live.spec.ts` talks to Microsoft's real endpoint and is excluded from the default Playwright run by `grepInvert` in `playwright.config.ts`. It is invoked explicitly by name.
- The readaloud endpoint accepts **only** `speak > voice > prosody > plain text`. Never add `<break>`, `<bookmark>`, `<mark>`, `<s>`, `<p>`, or `<silence>` to the edge path — each closes the socket with 1007.

---

## File Structure

**Part 1**
- Modify `src/offscreen/edge/edge_ssml.ts` — drop `internalSilenceMs` and the `<break>` tag.
- Modify `src/offscreen/edge/edge_provider.ts` — append 300ms of silent samples instead.
- Modify `tests/unit/edge_ssml.test.ts`, `tests/unit/edge_provider.test.ts`.
- Modify `tests/e2e/edge-tts-live.spec.ts` — guard that the endpoint still rejects `<break>`.

**Part 2**
- Create `src/offscreen/edge/edge_failure.ts` — classify an error as deterministic, transient, or foreign.
- Rewrite `src/offscreen/edge/edge_retry.ts` — headroom-bounded delay plus a starvation-deadline retry loop.
- Create `src/offscreen/prefetch_window.ts` — which unit indices must be in flight to buffer the target.
- Modify `src/offscreen/offscreen.ts` — wire retries outside the arbiter slot, deepen prefetch, widen retention.
- Create `tests/unit/edge_failure.test.ts`, `tests/unit/prefetch_window.test.ts`; rewrite `tests/unit/edge_retry.test.ts`.

---

## Task 1: Remove `<break>` from the SSML builder

**Files:**
- Modify: `src/offscreen/edge/edge_ssml.ts`
- Test: `tests/unit/edge_ssml.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildSsml(input: { text: string; voice: string; locale: string; speed: number }): string` — the `internalSilenceMs` field is gone from the parameter object.

- [ ] **Step 1: Replace the two break tests with a structural-tag guard**

In `tests/unit/edge_ssml.test.ts`, delete the `appends a break for internal silence` and `omits the break when there is no internal silence` tests, drop `internalSilenceMs: 0` from `base`, and add:

```typescript
// The readaloud endpoint closes with 1007 on <break>, <bookmark>, <mark>, <s>, <p> and
// <silence>. Measured 2026-09-08; see docs/specs/2026-09-08-edge-tts-stability-design.md.
test('emits no element other than speak, voice and prosody', () => {
	const ssml = buildSsml({ ...base, text: 'Hello there' });
	const elements = [...ssml.matchAll(/<\/?([a-z]+)/gu)].map((match) => match[1]);
	assert.deepEqual([...new Set(elements)].sort(), ['prosody', 'speak', 'voice']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/edge_ssml.test.ts`
Expected: FAIL — `base` still carries `internalSilenceMs`, so TypeScript rejects the object, or the assertion sees a `break` element.

- [ ] **Step 3: Remove the parameter and the tag**

In `src/offscreen/edge/edge_ssml.ts`, replace the `buildSsml` function and its doc comment with:

```typescript
/**
 * One synthesis request.
 *
 * The readaloud endpoint accepts only `speak > voice > prosody > text`; every structural tag,
 * `<break>` included, closes the connection with 1007. Trailing silence is added to the decoded
 * samples instead — see edge_provider.ts.
 */
export function buildSsml(input: { text: string; voice: string; locale: string; speed: number }): string {
	return (
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${input.locale}'>` +
		`<voice name='${input.voice}'>` +
		`<prosody pitch='+0Hz' rate='${prosodyRate(input.speed)}' volume='+0%'>` +
		`${escapeXml(input.text)}` +
		`</prosody></voice></speak>`
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/edge_ssml.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/edge_ssml.ts tests/unit/edge_ssml.test.ts
git commit -m "fix: stop emitting the <break> tag edge-tts rejects with 1007"
```

---

## Task 2: Append the trailing silence client-side

**Files:**
- Modify: `src/offscreen/edge/edge_provider.ts`
- Test: `tests/unit/edge_provider.test.ts`

**Interfaces:**
- Consumes: `buildSsml` from Task 1, without `internalSilenceMs`.
- Produces: no signature change. `createEdgeProvider(deps).synthesize(input)` still returns `{ samples, sampleRate, wordTimings }`; `samples` now carries 300ms of trailing zeroes when `input.unit.pauseAfterMs === null`.

- [ ] **Step 1: Replace the break test with a silence test**

In `tests/unit/edge_provider.test.ts`, delete the `requests a trailing break for units with no pause` test and add:

```typescript
test('pads units with no pause with 300ms of trailing silence', async () => {
	const { provider, sent } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: null, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	// The endpoint rejects <break>, so the cadence Supertonic renders internally is added here.
	assert.doesNotMatch(sent[0], /<break/u);
	assert.equal(result.samples.length, 2 + 0.3 * 24_000);
	assert.deepEqual(Array.from(result.samples.slice(0, 2)), [0.5, -0.5]);
	assert.ok(
		result.samples.slice(2).every((sample) => sample === 0),
		'the padding must be silent',
	);
});

test('leaves units with a numeric pause unpadded', async () => {
	const { provider } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.equal(result.samples.length, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/edge_provider.test.ts`
Expected: FAIL — `result.samples.length` is 2, not 7202.

- [ ] **Step 3: Pad the decoded samples**

In `src/offscreen/edge/edge_provider.ts`, replace the `synthesize` body's tail. The full replacement for the `createEdgeProvider` function:

```typescript
/** Silence appended to units with no trailing pause, matching what Supertonic renders internally. */
function withTrailingSilence(samples: Float32Array, sampleRate: number, silenceMs: number): Float32Array {
	if (silenceMs <= 0) {
		return samples;
	}
	const padded = new Float32Array(samples.length + Math.round((sampleRate * silenceMs) / 1_000));
	padded.set(samples);
	return padded;
}

export function createEdgeProvider(deps: EdgeProviderDependencies): SpeechProvider {
	return {
		id: 'edge',
		async synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit> {
			const locale = localeForLanguage(input.lang);
			if (locale === null) {
				throw new EdgeUnsupportedLanguageError(input.lang);
			}
			const ssml = buildSsml({
				text: input.unit.text,
				voice: input.voiceId,
				locale,
				speed: input.speed,
			});
			const { audio, boundaries } = await deps.socket.synthesize(ssml);
			const { samples, sampleRate } = await deps.decode(audio);
			// Reported before padding: the diagnostics compare against what the engine produced.
			input.onRawEngineSamples?.(samples);
			return {
				samples: withTrailingSilence(samples, sampleRate, input.unit.pauseAfterMs === null ? INTERNAL_SILENCE_MS : 0),
				sampleRate,
				wordTimings: alignWordBoundaries(input.unit.wordMap ?? [], boundaries),
			};
		},
	};
}
```

Update the `INTERNAL_SILENCE_MS` doc comment to say the silence is appended to the samples rather than requested from the endpoint.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/edge_provider.test.ts`
Expected: PASS, 10 tests. The existing `reports decoded samples to the diagnostics callback` test must still see the unpadded 2-sample array.

- [ ] **Step 5: Run the whole unit suite for regressions**

Run: `bun test tests/unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/offscreen/edge/edge_provider.ts tests/unit/edge_provider.test.ts
git commit -m "fix: pad edge units with client-side silence instead of an SSML break"
```

---

## Task 3: Guard the SSML restriction against the live endpoint

**Files:**
- Modify: `tests/e2e/edge-tts-live.spec.ts`

**Interfaces:**
- Consumes: nothing. The live spec deliberately inlines its handshake rather than importing from `src/offscreen/edge`.
- Produces: nothing.

- [ ] **Step 1: Add the rejection test**

Append to `tests/e2e/edge-tts-live.spec.ts`:

```typescript
// If Microsoft ever starts accepting <break>, this test fails and the padding in
// edge_provider.ts can be reconsidered. Until then it documents why the padding exists.
test('the live endpoint still rejects a <break> tag', async ({ context, extensionId }) => {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/src/offscreen/offscreen.html`);

	const closeCode = await page.evaluate(async () => {
		const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
		const ticks = Math.floor((Date.now() / 1000 + 11_644_473_600) * 10_000_000);
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(`${ticks - (ticks % 3_000_000_000)}${TRUSTED_CLIENT_TOKEN}`),
		);
		const gec = Array.from(new Uint8Array(digest))
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase();

		const url =
			`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
			`?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-141.0.3537.57`;

		return await new Promise<number | null>((resolve) => {
			const socket = new WebSocket(url);
			socket.binaryType = 'arraybuffer';
			const timer = setTimeout(() => resolve(null), 20_000);
			socket.addEventListener('open', () => {
				const stamp = new Date().toString();
				socket.send(
					`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
						JSON.stringify({
							context: {
								synthesis: {
									audio: {
										metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
										outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
									},
								},
							},
						}),
				);
				const ssml =
					`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
					`<voice name='vi-VN-HoaiMyNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
					`Xin chào.<break time='300ms'/></prosody></voice></speak>`;
				socket.send(
					`X-RequestId:${crypto.randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\n` +
						`X-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`,
				);
			});
			socket.addEventListener('close', (event) => {
				clearTimeout(timer);
				resolve(event.code);
			});
		});
	});

	expect(closeCode, 'a <break> tag must still be rejected with 1007').toBe(1007);
});
```

- [ ] **Step 2: Rebuild and run the live spec**

```bash
bun run build:chrome
bunx playwright test tests/e2e/edge-tts-live.spec.ts --grep "rejects a <break>"
```

Expected: PASS. If it fails with a code other than 1007, stop and report — the endpoint's behaviour has changed and Tasks 1-2 need revisiting.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/edge-tts-live.spec.ts
git commit -m "test: pin the live endpoint's rejection of SSML break tags"
```

---

## Task 4: Classify edge failures

**Files:**
- Create: `src/offscreen/edge/edge_failure.ts`
- Test: `tests/unit/edge_failure.test.ts`

**Interfaces:**
- Consumes: `EdgeSocketError` from `./edge_socket.ts`, `EdgeUnsupportedLanguageError` from `./edge_provider.ts`.
- Produces:
  - `type EdgeFailureKind = 'deterministic' | 'transient' | 'foreign'`
  - `classifyEdgeFailure(error: unknown): EdgeFailureKind`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge_failure.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEdgeFailure } from '../../src/offscreen/edge/edge_failure.ts';
import { EdgeUnsupportedLanguageError } from '../../src/offscreen/edge/edge_provider.ts';
import { EdgeSocketError } from '../../src/offscreen/edge/edge_socket.ts';

// 1007 is the endpoint's answer to SSML it will never accept, so retrying only burns the
// starvation budget that a genuinely transient drop needs.
test('treats a 1007 close as deterministic', () => {
	assert.equal(classifyEdgeFailure(new EdgeSocketError('connection closed', 1007)), 'deterministic');
});

test('treats an unsupported language as deterministic', () => {
	assert.equal(classifyEdgeFailure(new EdgeUnsupportedLanguageError('na')), 'deterministic');
});

test('treats an abnormal 1006 close as transient', () => {
	assert.equal(classifyEdgeFailure(new EdgeSocketError('connection closed', 1006)), 'transient');
});

test('treats a timeout with no close code as transient', () => {
	assert.equal(classifyEdgeFailure(new EdgeSocketError('synthesis request timed out')), 'transient');
});

test('treats a non-edge error as foreign', () => {
	assert.equal(classifyEdgeFailure(new Error('decodeAudioData failed')), 'foreign');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/edge_failure.test.ts`
Expected: FAIL — cannot resolve `edge_failure.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/offscreen/edge/edge_failure.ts`:

```typescript
import { EdgeUnsupportedLanguageError } from './edge_provider.ts';
import { EdgeSocketError } from './edge_socket.ts';

/**
 * How a failed edge request should be answered.
 *
 * `deterministic` errors repeat no matter how long the caller waits, so retrying them spends the
 * starvation budget for nothing. `transient` errors are the drops Microsoft's endpoint produces
 * under load — silent for two seconds, then an abnormal close — which a later attempt recovers
 * from. `foreign` errors did not come from the cloud path at all and belong to the caller.
 */
export type EdgeFailureKind = 'deterministic' | 'transient' | 'foreign';

/** The close code for a payload the endpoint refuses; every structural SSML tag produces it. */
const INVALID_PAYLOAD = 1007;

export function classifyEdgeFailure(error: unknown): EdgeFailureKind {
	if (error instanceof EdgeUnsupportedLanguageError) {
		return 'deterministic';
	}
	if (error instanceof EdgeSocketError) {
		return error.closeCode === INVALID_PAYLOAD ? 'deterministic' : 'transient';
	}
	return 'foreign';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/edge_failure.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/edge_failure.ts tests/unit/edge_failure.test.ts
git commit -m "feat: classify edge failures as deterministic, transient or foreign"
```

---

## Task 5: Bound the retry delay by buffer headroom

**Files:**
- Modify: `src/offscreen/edge/edge_retry.ts`
- Test: `tests/unit/edge_retry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `edgeRetryDelayMs(attempt: number, headroomMs: number): number`. The old single-argument `edgeRetryDelayMs` and `EDGE_SYNTHESIS_ATTEMPTS` are removed in this task; `retryEdgeSynthesis` is rewritten in Task 6.

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `tests/unit/edge_retry.test.ts` with just the delay tests for now (Task 6 adds the loop tests back):

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { edgeRetryDelayMs } from '../../src/offscreen/edge/edge_retry.ts';

const MINUTE_OF_HEADROOM = 60_000;

test('backs off exponentially while the buffer is deep', () => {
	assert.equal(edgeRetryDelayMs(1, MINUTE_OF_HEADROOM), 1_000);
	assert.equal(edgeRetryDelayMs(2, MINUTE_OF_HEADROOM), 2_000);
	assert.equal(edgeRetryDelayMs(3, MINUTE_OF_HEADROOM), 4_000);
});

// A unit the playhead is waiting on must not wait 45 seconds, so the delay can never exceed
// half the audio still buffered ahead of it.
test('never waits longer than half the remaining headroom', () => {
	assert.equal(edgeRetryDelayMs(5, 3_000), 1_500);
	assert.equal(edgeRetryDelayMs(9, 10_000), 5_000);
});

test('collapses to the floor when the buffer is dry', () => {
	assert.equal(edgeRetryDelayMs(1, 0), 250);
	assert.equal(edgeRetryDelayMs(7, 0), 250);
});

test('caps the delay so a session never stalls on one sleep', () => {
	assert.equal(edgeRetryDelayMs(20, Number.MAX_SAFE_INTEGER), 45_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/edge_retry.test.ts`
Expected: FAIL — `edgeRetryDelayMs(1, 60_000)` returns 250, the old first-attempt constant.

- [ ] **Step 3: Write the implementation**

Replace the top of `src/offscreen/edge/edge_retry.ts` (delete `EDGE_SYNTHESIS_ATTEMPTS`, the old `edgeRetryDelayMs`, and `EdgeRetryOptions`; leave `retryEdgeSynthesis` alone for now, it is rewritten in Task 6):

```typescript
/** Where the exponential ladder starts, doubling on every further attempt. */
const BASE_DELAY_MS = 1_000;
/** A unit the playhead is starving for retries almost immediately. */
const FLOOR_DELAY_MS = 250;
/** No single sleep may outlast a bad window's useful retry budget. */
const CEILING_DELAY_MS = 45_000;

/**
 * How long to wait before offering a unit to edge-tts again.
 *
 * Microsoft's drops come in windows lasting around two minutes, so a patient ladder recovers
 * where three fast attempts could not. Patience is only affordable while audio is still buffered
 * ahead of the playhead, so the delay is capped at half that headroom: with a full buffer the
 * ladder runs its course, and as the playhead starves the delays collapse to the floor on their
 * own without a second policy.
 */
export function edgeRetryDelayMs(attempt: number, headroomMs: number): number {
	const exponential = BASE_DELAY_MS * 2 ** (attempt - 1);
	const patience = Math.min(exponential, headroomMs / 2);
	return Math.min(Math.max(patience, FLOOR_DELAY_MS), CEILING_DELAY_MS);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/edge_retry.test.ts`
Expected: PASS, 4 tests. `bun test tests/unit` will still fail to typecheck `offscreen.ts` imports until Task 8 — that is expected and resolved there.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/edge_retry.ts tests/unit/edge_retry.test.ts
git commit -m "feat: bound the edge retry delay by buffered audio headroom"
```

---

## Task 6: Retry until starvation, not until a counter runs out

**Files:**
- Modify: `src/offscreen/edge/edge_retry.ts`
- Test: `tests/unit/edge_retry.test.ts`

**Interfaces:**
- Consumes: `edgeRetryDelayMs` from Task 5, `EdgeFailureKind` from Task 4.
- Produces:
  ```typescript
  export const EDGE_STARVATION_GRACE_MS = 30_000;
  export interface EdgeRetryOptions<T> {
      classify(error: unknown): EdgeFailureKind;
      headroomMs(): number;
      fallback(error: unknown): Promise<T>;
      onAttemptFailed(error: unknown, attempt: number): void;
      sleep(ms: number): Promise<void>;
      now(): number;
      graceMs: number;
  }
  export function retryEdgeSynthesis<T>(attempt: () => Promise<T>, options: EdgeRetryOptions<T>): Promise<T>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/edge_retry.test.ts` (keep the Task 5 tests, and extend the import):

```typescript
import { EDGE_STARVATION_GRACE_MS, retryEdgeSynthesis } from '../../src/offscreen/edge/edge_retry.ts';
import type { EdgeFailureKind } from '../../src/offscreen/edge/edge_failure.ts';

/** A retry harness on a fake clock: sleeping is the only thing that advances time. */
function harness(headroomMs: number, kind: EdgeFailureKind = 'transient') {
	let clock = 0;
	const slept: number[] = [];
	return {
		slept,
		get elapsed() {
			return clock;
		},
		options: {
			classify: () => kind,
			headroomMs: () => headroomMs,
			fallback: async (error: unknown) => `fallback:${(error as Error).message}`,
			onAttemptFailed: () => undefined,
			sleep: async (ms: number) => {
				slept.push(ms);
				clock += ms;
			},
			now: () => clock,
			graceMs: EDGE_STARVATION_GRACE_MS,
		},
	};
}

test('returns the first success without retrying', async () => {
	const h = harness(120_000);
	let calls = 0;
	const result = await retryEdgeSynthesis(async () => {
		calls += 1;
		return 'audio';
	}, h.options);
	assert.equal(result, 'audio');
	assert.equal(calls, 1);
	assert.deepEqual(h.slept, []);
});

test('recovers from a transient failure a later attempt survives', async () => {
	const h = harness(120_000);
	let calls = 0;
	const result = await retryEdgeSynthesis(async () => {
		calls += 1;
		if (calls < 4) {
			throw new Error('transient');
		}
		return 'audio';
	}, h.options);
	assert.equal(result, 'audio');
	assert.equal(calls, 4);
	assert.deepEqual(h.slept, [1_000, 2_000, 4_000], 'the ladder runs while the buffer is deep');
});

// Three attempts used to span one second, well inside a two-minute bad window. With 180s of
// buffer the loop keeps trying far past where the old policy gave up.
test('keeps retrying well past three attempts while audio is still buffered', async () => {
	const h = harness(120_000);
	let calls = 0;
	await retryEdgeSynthesis(async () => {
		calls += 1;
		if (calls < 9) {
			throw new Error('transient');
		}
		return 'audio';
	}, h.options);
	assert.equal(calls, 9);
	assert.ok(h.elapsed > 120_000, `expected to outlast a bad window, only spent ${h.elapsed}ms`);
});

test('falls back once the buffer has been dry beyond the grace window', async () => {
	const h = harness(0);
	const result = await retryEdgeSynthesis(async () => {
		throw new Error('transient');
	}, h.options);
	assert.equal(result, 'fallback:transient');
	assert.ok(h.elapsed > EDGE_STARVATION_GRACE_MS, 'the grace window must actually elapse first');
	assert.ok(
		h.slept.every((ms) => ms === 250),
		'a starving playhead retries at the floor delay',
	);
});

test('falls back immediately on a deterministic failure', async () => {
	const h = harness(120_000, 'deterministic');
	let calls = 0;
	const result = await retryEdgeSynthesis(async () => {
		calls += 1;
		throw new Error('1007');
	}, h.options);
	assert.equal(result, 'fallback:1007');
	assert.equal(calls, 1, 'a deterministic error must not spend the starvation budget');
	assert.deepEqual(h.slept, []);
});

test('rethrows an error that did not come from the cloud path', async () => {
	const h = harness(120_000, 'foreign');
	await assert.rejects(
		retryEdgeSynthesis(async () => {
			throw new Error('decode failed');
		}, h.options),
		/decode failed/u,
	);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/edge_retry.test.ts`
Expected: FAIL — `EDGE_STARVATION_GRACE_MS` is not exported and the old `retryEdgeSynthesis` signature rejects these options.

- [ ] **Step 3: Write the implementation**

Replace everything below `edgeRetryDelayMs` in `src/offscreen/edge/edge_retry.ts`:

```typescript
import type { EdgeFailureKind } from './edge_failure.ts';

/**
 * How long the player may sit on a dry buffer before the session moves on-device.
 *
 * Added to the 180 seconds the prefetch window holds, this outlasts the roughly two-minute bad
 * windows measured against the endpoint, while still bounding how long a reader stares at a
 * loading state when the endpoint is genuinely gone.
 */
export const EDGE_STARVATION_GRACE_MS = 30_000;

export interface EdgeRetryOptions<T> {
	classify(error: unknown): EdgeFailureKind;
	/** Audio still buffered ahead of the playhead. Zero means the reader is waiting. */
	headroomMs(): number;
	/** Moves the session on-device; its result is returned to the caller. */
	fallback(error: unknown): Promise<T>;
	onAttemptFailed(error: unknown, attempt: number): void;
	sleep(ms: number): Promise<void>;
	now(): number;
	graceMs: number;
}

/**
 * Offer a unit to edge-tts until it succeeds, until the error proves deterministic, or until the
 * reader has been waiting on an empty buffer for longer than the grace window.
 *
 * There is deliberately no attempt cap. Retrying costs the reader nothing while audio is still
 * buffered, so the stop condition is starvation rather than a counter — a counter is what let a
 * one-second retry budget lose a whole article to a two-minute outage.
 *
 * The caller must not hold a synthesis arbiter slot across this call: the sleeps below have to
 * leave the queue free, or a single retrying unit blocks the very buffer refill that makes
 * waiting safe.
 */
export async function retryEdgeSynthesis<T>(attempt: () => Promise<T>, options: EdgeRetryOptions<T>): Promise<T> {
	let dryAt: number | null = null;
	for (let attemptNumber = 1; ; attemptNumber += 1) {
		try {
			return await attempt();
		} catch (error) {
			const kind = options.classify(error);
			if (kind === 'foreign') {
				throw error;
			}
			if (kind === 'deterministic') {
				return await options.fallback(error);
			}
			options.onAttemptFailed(error, attemptNumber);
			const headroomMs = options.headroomMs();
			if (headroomMs > 0) {
				dryAt = null;
			} else {
				dryAt ??= options.now();
				if (options.now() - dryAt > options.graceMs) {
					return await options.fallback(error);
				}
			}
			await options.sleep(edgeRetryDelayMs(attemptNumber, headroomMs));
		}
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/edge_retry.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/edge/edge_retry.ts tests/unit/edge_retry.test.ts
git commit -m "feat: retry edge synthesis until starvation instead of a fixed attempt count"
```

---

## Task 7: Compute the prefetch window in seconds of audio

**Files:**
- Create: `src/offscreen/prefetch_window.ts`
- Test: `tests/unit/prefetch_window.test.ts`

**Interfaces:**
- Consumes: `estimateSpeechUnitDurations` from `./audio_export_estimate.ts`, `SpeechUnit` from `./speech_unit.ts`.
- Produces:
  - `export const PREFETCH_TARGET_SECONDS = 180;`
  - `prefetchWindow(units: readonly SpeechUnit[], currentIndex: number, language: string, speed: number, targetSeconds?: number): number[]` — unit indices strictly after `currentIndex`, in order, whose estimated durations first reach `targetSeconds`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prefetch_window.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { PREFETCH_TARGET_SECONDS, prefetchWindow } from '../../src/offscreen/prefetch_window.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

/** 160 words per minute at speed 1, so 16 words is exactly six seconds of speech. */
function unitOfWords(words: number): SpeechUnit {
	return { text: Array.from({ length: words }, () => 'word').join(' '), pauseAfterMs: 0 };
}

const units = Array.from({ length: 60 }, () => unitOfWords(16));

test('buffers ahead until the target duration is reached', () => {
	const window = prefetchWindow(units, 0, 'en', 1, 30);
	assert.deepEqual(window, [1, 2, 3, 4, 5], 'five six-second units reach thirty seconds');
});

test('starts strictly after the unit being played', () => {
	assert.equal(prefetchWindow(units, 10, 'en', 1, 30)[0], 11);
});

test('stops at the end of the article', () => {
	assert.deepEqual(prefetchWindow(units.slice(0, 3), 0, 'en', 1, 300), [1, 2]);
});

test('returns nothing when the last unit is playing', () => {
	assert.deepEqual(prefetchWindow(units.slice(0, 3), 2, 'en', 1, 300), []);
});

// Faster playback drains the buffer faster, so the same wall-clock target needs more units.
test('accounts for playback speed', () => {
	assert.ok(prefetchWindow(units, 0, 'en', 2, 30).length > prefetchWindow(units, 0, 'en', 1, 30).length);
});

test('targets three minutes by default', () => {
	assert.equal(PREFETCH_TARGET_SECONDS, 180);
	assert.equal(prefetchWindow(units, 0, 'en', 1).length, 30, 'thirty six-second units cover three minutes');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/prefetch_window.test.ts`
Expected: FAIL — cannot resolve `prefetch_window.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/offscreen/prefetch_window.ts`:

```typescript
import { estimateSpeechUnitDurations } from './audio_export_estimate.ts';
import type { SpeechUnit } from './speech_unit.ts';

/**
 * How much audio to keep synthesized ahead of the playhead.
 *
 * Microsoft's endpoint drops requests in windows lasting around two minutes; three minutes of
 * buffer rides one out without the reader hearing a gap. Filling it costs about ten seconds,
 * since the arbiter runs requests one at a time and a unit-sized request returns in well under a
 * second, and about 33MB of decoded audio in the offscreen document.
 */
export const PREFETCH_TARGET_SECONDS = 180;

/**
 * The unit indices that must be synthesized, in order, to buffer `targetSeconds` past the unit
 * currently playing.
 *
 * Durations are estimated rather than measured because these units have not been synthesized
 * yet — that is the whole point. The estimate only has to be good enough to size a buffer.
 */
export function prefetchWindow(
	units: readonly SpeechUnit[],
	currentIndex: number,
	language: string,
	speed: number,
	targetSeconds: number = PREFETCH_TARGET_SECONDS,
): number[] {
	const durations = estimateSpeechUnitDurations(units, language, speed);
	const window: number[] = [];
	let buffered = 0;
	for (let index = currentIndex + 1; index < units.length && buffered < targetSeconds; index += 1) {
		window.push(index);
		buffered += durations[index];
	}
	return window;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/prefetch_window.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/offscreen/prefetch_window.ts tests/unit/prefetch_window.test.ts
git commit -m "feat: size the prefetch window by seconds of audio"
```

---

## Task 8: Wire the buffer and retry policy into the offscreen session

**Files:**
- Modify: `src/offscreen/offscreen.ts` — imports near line 26 and 41; `isEdgeFailure` at line 453; `synthesizeWithFallback` at lines 489-520; `synthesisArbiter`/`synthesisCoordinator` at lines 597-602; `retainedSynthesisKeys` at lines 617-623; `prefetchNextUnit` at lines 676-678; the prefetch calls at lines 1014-1038.

**Interfaces:**
- Consumes: `classifyEdgeFailure` (Task 4), `retryEdgeSynthesis` / `EDGE_STARVATION_GRACE_MS` (Task 6), `prefetchWindow` (Task 7).
- Produces: nothing new for other tasks. This is the final wiring task.

This task has no unit test: `offscreen.ts` is the wiring layer and has no unit-test harness in this repo. Its verification is the existing e2e suite plus a manual listen. Do not invent a harness for it as part of this plan.

- [ ] **Step 1: Replace the imports and the failure predicate**

In `src/offscreen/offscreen.ts`, update the edge imports to add the new modules:

```typescript
import { classifyEdgeFailure } from './edge/edge_failure.ts';
import { EDGE_STARVATION_GRACE_MS, retryEdgeSynthesis } from './edge/edge_retry.ts';
import { PREFETCH_TARGET_SECONDS, prefetchWindow } from './prefetch_window.ts';
```

Remove the now-unused `EDGE_SYNTHESIS_ATTEMPTS` and `edgeRetryDelayMs` from the existing `./edge/edge_retry.ts` import, and delete the `isEdgeFailure` function at line 453 along with its `EdgeSocketError` import if nothing else uses it.

- [ ] **Step 2: Add a headroom reading**

Add next to `retainedSynthesisKeys`:

```typescript
/**
 * Audio already synthesized ahead of the playhead, in milliseconds.
 *
 * Counted over the contiguous run after the current unit: a hole means the reader reaches
 * silence there regardless of what is buffered past it, so anything beyond the hole is not
 * headroom. This is what bounds how patiently a failed unit may be retried.
 */
function bufferedHeadroomMs(): number {
	let seconds = 0;
	for (let unitIndex = currentUnitIndex + 1; unitIndex < speechUnits.length; unitIndex += 1) {
		const resolved = synthesisCoordinator.peekResolved(synthesisKey(playbackSession, unitIndex));
		if (!resolved) {
			break;
		}
		seconds += resolved.buffer.duration;
	}
	return seconds * 1_000;
}
```

- [ ] **Step 3: Move the retry outside the arbiter slot**

Replace `synthesizeWithFallback` (lines 489-520) with a plain arbiter task and a retrying wrapper:

```typescript
/**
 * One attempt, inside the arbiter slot. No retrying happens here — see synthesizeWithEdgeRetry.
 */
async function synthesizeOnce(input: SynthesisInput): Promise<SynthesizedPlayback> {
	return await synthesizeUnit(input.unit, input.lang, input.speed, input.owner, input.probeId);
}

/**
 * Retry around the arbiter rather than inside it.
 *
 * `SynthesisArbiter.drain` awaits one task at a time, so sleeping inside the slot would stall
 * every other unit — including the prefetch that keeps the buffer deep enough to make waiting
 * safe in the first place. Each attempt therefore takes a fresh slot and the backoff happens
 * between them, leaving the queue free to advance.
 */
async function synthesizeWithEdgeRetry(input: SynthesisInput): Promise<SynthesizedPlayback> {
	if (sessionProviderId !== 'edge') {
		return await synthesisArbiter.foreground(input);
	}
	const unitIndex = input.unit.synthesisIndex ?? speechUnits.indexOf(input.unit);
	return await retryEdgeSynthesis(() => synthesisArbiter.foreground(input), {
		classify: classifyEdgeFailure,
		headroomMs: bufferedHeadroomMs,
		graceMs: EDGE_STARVATION_GRACE_MS,
		now: () => performance.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		// Recorded even when a later attempt succeeds: a downgrade that leaves no trace is
		// indistinguishable from the engine simply sounding different.
		onAttemptFailed: (error, attempt) => {
			playbackMetrics.recordSynthError(unitIndex, `edge attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
			// The connection is spent either way; the next attempt opens a fresh one.
			edgeSocket?.close();
			edgeSocket = null;
		},
		fallback: async (error) => {
			playbackMetrics.recordSynthError(unitIndex, `edge exhausted: ${error instanceof Error ? error.message : String(error)}`);
			await downgradeToSupertonic(input.lang);
			return await synthesisArbiter.foreground(input);
		},
	});
}
```

- [ ] **Step 4: Repoint the arbiter and coordinator**

Replace lines 597-602:

```typescript
const synthesisArbiter = new SynthesisArbiter<SynthesisInput, SynthesizedPlayback>((input) => synthesizeOnce(input));

const synthesisCoordinator = new IndexedSynthesisCoordinator<SynthesisInput, SynthesizedPlayback>(
	(input) => synthesizeWithEdgeRetry(input),
	{ onResolved: () => notifyExportRunway() },
);
```

- [ ] **Step 5: Widen retention to the prefetch window**

Replace `retainedSynthesisKeys` (lines 617-623):

```typescript
function retainedSynthesisKeys(session: number): SynthesisKey[] {
	const keys = [synthesisKey(session, currentUnitIndex)];
	// `currentPlaybackLanguage` is null between sessions (offscreen.ts:74). The estimate only
	// sizes a buffer, and an empty language means the non-Chinese words-per-minute rate, which is
	// the right default for a window nothing is playing into yet.
	const window = prefetchWindow(speechUnits, currentUnitIndex, currentPlaybackLanguage ?? '', currentSpeed);
	for (const unitIndex of window) {
		keys.push(synthesisKey(session, unitIndex));
	}
	return keys;
}
```

Note that `prefetchWindow` already defaults its fifth argument to `PREFETCH_TARGET_SECONDS`, so it is not passed here. Keep the `PREFETCH_TARGET_SECONDS` import only if Step 6 or a comment still references it; otherwise drop it to satisfy Biome.

- [ ] **Step 6: Fill the whole window instead of one unit**

Replace `prefetchNextUnit` (lines 676-678):

```typescript
/** Keep synthesizing forward until the buffer reaches the target, so a bad window stays inaudible. */
function prefetchNextUnit(lang: string, session: number): void {
	for (const unitIndex of prefetchWindow(speechUnits, currentUnitIndex, lang, currentSpeed)) {
		prefetchUnit(unitIndex, lang, session);
	}
}
```

Then delete the now-redundant special case at lines 1033-1035 (`if (speechUnits.length > 3) prefetchUnit(2, lang, session)`), since the window covers it. Leave the unit-0 successor priming at lines 1014-1024 alone — it exists so the first source does not start before its successor is in flight.

- [ ] **Step 7: Typecheck and lint**

```bash
bunx tsc --noEmit
bunx biome check --write .
```

Expected: no errors. Fix any unused-import fallout from removing `isEdgeFailure` and `EDGE_SYNTHESIS_ATTEMPTS`.

- [ ] **Step 8: Run the full unit suite**

Run: `bun test tests/unit`
Expected: PASS.

- [ ] **Step 9: Rebuild and run the e2e suite**

```bash
bun run build:chrome
bunx playwright test
```

Expected: PASS. The build is mandatory — Playwright loads `dist/chrome`, so a stale bundle would test the old code and report green.

- [ ] **Step 10: Listen to it**

Play a long article end to end with the edge provider selected and confirm: audio starts within a couple of seconds, no gaps between units, and no fallback notice. Then repeat with a Chinese or Japanese article, which could not use edge-tts at all before Task 1.

- [ ] **Step 11: Commit**

```bash
git add src/offscreen/offscreen.ts
git commit -m "feat: buffer three minutes of edge audio and downgrade only on starvation"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Drop `<break>` from `buildSsml` | 1 |
| Append 300ms of silence in the provider | 2 |
| Live e2e guard on the `<break>` rejection | 3 |
| Error taxonomy splitting 1007 from 1006 | 4 |
| Headroom-bounded retry delay | 5 |
| No attempt cap; starvation deadline of 30s | 6 |
| Prefetch measured in seconds, 180s target | 7 |
| Retries must not hold the arbiter slot | 8, Step 3 |
| Retention widened to the prefetch window | 8, Step 5 |
| Downgrade keeps whole-session behaviour | 8, Step 3 (`fallback` calls the existing `downgradeToSupertonic`) |
| Unit tests for delay, downgrade, prefetch, provider, ssml | 1, 2, 4, 5, 6, 7 |

No spec requirement is unclaimed.

**Type consistency**

`edgeRetryDelayMs(attempt, headroomMs)` is defined in Task 5 and used in Task 6. `EdgeFailureKind` is defined in Task 4 and consumed by `EdgeRetryOptions.classify` in Task 6 and by `classifyEdgeFailure` in Task 8. `prefetchWindow(units, currentIndex, language, speed, targetSeconds?)` is defined in Task 7 and called in Task 8 Steps 5 and 6 with matching argument order. `EDGE_STARVATION_GRACE_MS` and `PREFETCH_TARGET_SECONDS` are exported where defined and imported in Task 8.

**Known risks carried into execution**

- Task 8 is the only task without a unit test, because `offscreen.ts` is the wiring layer and this repo has no harness for it. Steps 8-10 are its real gate; do not skip the manual listen.
- Deepening the prefetch changes when synthesis errors surface. Previously a failure reached `playNextUnit`'s catch almost immediately; now a prefetched unit can fail and retry for minutes before the playhead arrives. Watch the `reportProgress('error', ...)` path at offscreen.ts:1044-1049 during Step 10 — an error raised for a unit the reader is nowhere near would be a regression.
- `bufferedHeadroomMs` reads `synthesisCoordinator.peekResolved`, which only returns a value once `onResolved` has fired for a retained entry. During the first fill the headroom is genuinely near zero, so early failures retry at the floor delay. That is intended, but it means the 30-second grace window can start counting before the buffer has ever filled.
