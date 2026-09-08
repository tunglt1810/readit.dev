import assert from 'node:assert/strict';
import test from 'node:test';
import type { EdgeFailureKind } from '../../src/offscreen/edge/edge_failure.ts';
import { EDGE_STARVATION_GRACE_MS, edgeRetryDelayMs, retryEdgeSynthesis } from '../../src/offscreen/edge/edge_retry.ts';

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
