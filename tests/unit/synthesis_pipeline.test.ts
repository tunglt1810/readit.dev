// Guards how offscreen.ts composes the arbiter, the coordinator and the retry loop.
//
// Each piece is correct alone, and the bug this file exists for lived only in their composition:
// retrying outside the arbiter slot re-enqueues at the back of the queue, so flooding that queue
// with a whole prefetch window pushed the retry of the unit playback was waiting on behind every
// prefetched unit. First audio went from about a second to over a minute.
import assert from 'node:assert/strict';
import test from 'node:test';
import { retryEdgeSynthesis } from '../../src/offscreen/edge/edge_retry.ts';
import { MAX_PREFETCH_IN_FLIGHT, prefetchCap, prefetchStarts } from '../../src/offscreen/prefetch_window.ts';
import { SynthesisArbiter } from '../../src/offscreen/synthesis_arbiter.ts';
import { IndexedSynthesisCoordinator, type SynthesisKey } from '../../src/offscreen/synthesis_coordinator.ts';

/** Measured round trip for a unit-sized request against the live endpoint. */
const REQUEST_MS = 600;
/** Units the 180-second prefetch target covers for a typical article. */
const WINDOW = Array.from({ length: 30 }, (_, index) => index + 1);

type Input = { unitIndex: number };
const keyFor = (unitIndex: number): SynthesisKey => ({ session: 1, unitIndex, speedVersion: 0 });

/** The offscreen wiring on a fake clock, with prefetch bounded the way offscreen.ts bounds it. */
function pipeline(dropOnce: ReadonlySet<number>) {
	let clock = 0;
	const dropped = new Set<number>();
	const resolvedAt = new Map<number, number>();

	// Timing is recorded here rather than in onResolved: that callback runs in a microtask, by
	// which point the arbiter has already started the next request and moved the clock on.
	const completedAt = new Map<number, number>();

	const arbiter = new SynthesisArbiter<Input, string>(async (input) => {
		await Promise.resolve();
		clock += REQUEST_MS;
		if (dropOnce.has(input.unitIndex) && !dropped.has(input.unitIndex)) {
			dropped.add(input.unitIndex);
			throw new Error(`transient unit ${input.unitIndex}`);
		}
		completedAt.set(input.unitIndex, clock);
		return `audio ${input.unitIndex}`;
	});

	const coordinator = new IndexedSynthesisCoordinator<Input, string>(
		(input) =>
			retryEdgeSynthesis(() => arbiter.foreground(input), {
				classify: () => 'transient',
				headroomMs: () => 0,
				graceMs: 30_000,
				now: () => clock,
				sleep: (ms) => {
					clock += ms;
					return Promise.resolve();
				},
				onAttemptFailed: () => undefined,
				fallback: async () => 'fallback',
			}),
		{
			onResolved: (key) => {
				resolvedAt.set(key.unitIndex, clock);
				fill();
			},
		},
	);

	function fill(): void {
		const starts = prefetchStarts(WINDOW, (unitIndex) => {
			const key = keyFor(unitIndex);
			if (!coordinator.has(key)) {
				return 'idle';
			}
			return coordinator.peekResolved(key) === undefined ? 'inFlight' : 'resolved';
		});
		for (const unitIndex of starts) {
			coordinator.prefetch(keyFor(unitIndex), { unitIndex });
		}
	}

	/** Reproduces playNextUnit for unit 0: await unit 0, start prefetching, then await unit 1. */
	async function playFirstUnit(): Promise<number> {
		await coordinator.get(keyFor(0), { unitIndex: 0 });
		fill();
		await coordinator.get(keyFor(1), { unitIndex: 1 });
		return completedAt.get(1) ?? Number.POSITIVE_INFINITY;
	}

	async function drain(): Promise<void> {
		for (let tick = 0; tick < 500; tick += 1) {
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	return { playFirstUnit, drain, resolvedAt, clock: () => clock };
}

test('starts the first audio promptly when nothing fails', async () => {
	const p = pipeline(new Set());
	const firstAudioMs = await p.playFirstUnit();
	assert.ok(firstAudioMs <= 2 * REQUEST_MS, `expected two requests, took ${firstAudioMs}ms`);
});

// The regression: one drop on the unit playback is waiting for must cost one retry, not a trip
// behind the whole prefetch window.
test('a drop on the awaited unit does not put its retry behind the prefetch window', async () => {
	const p = pipeline(new Set([1]));
	const firstAudioMs = await p.playFirstUnit();
	assert.ok(
		firstAudioMs < 10 * REQUEST_MS,
		`retry waited behind the window: first audio took ${firstAudioMs}ms, which is ${Math.round(firstAudioMs / REQUEST_MS)} requests`,
	);
});

test('survives several consecutive drops without stalling the start', async () => {
	const p = pipeline(new Set([1, 2, 3]));
	const firstAudioMs = await p.playFirstUnit();
	assert.ok(firstAudioMs < 10 * REQUEST_MS, `first audio took ${firstAudioMs}ms`);
});

// Bounding the queue must not slow the fill: the arbiter runs one request at a time either way,
// so the bound changes ordering, not throughput.
test('still fills the whole prefetch window', async () => {
	const p = pipeline(new Set());
	await p.playFirstUnit();
	await p.drain();
	const filled = WINDOW.filter((unitIndex) => p.resolvedAt.has(unitIndex)).length;
	assert.equal(filled, WINDOW.length, `only ${filled} of ${WINDOW.length} units were synthesized`);
	assert.ok(p.clock() <= (WINDOW.length + 2) * REQUEST_MS, `fill took ${p.clock()}ms`);
});

test('never lets more than the in-flight bound sit queued', () => {
	assert.deepEqual(
		prefetchStarts(WINDOW, () => 'idle'),
		WINDOW.slice(0, MAX_PREFETCH_IN_FLIGHT),
	);
});

// Every speculative request queued while the reader sits on silence is one more thing the retry
// of the unit they are waiting for must queue behind.
test('queues only one request while the reader is waiting on silence', () => {
	assert.equal(prefetchCap(true), 1);
	assert.equal(prefetchCap(false), MAX_PREFETCH_IN_FLIGHT);
	assert.deepEqual(
		prefetchStarts(WINDOW, () => 'idle', prefetchCap(true)),
		[WINDOW[0]],
	);
});
