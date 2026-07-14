import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexedSynthesisCoordinator, type SynthesisKey } from '../../src/offscreen/synthesis_coordinator.ts';

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

	const outcome = await foreground.catch((error: unknown) => error);
	assert.equal(outcome, 'retry:unit-1');
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
