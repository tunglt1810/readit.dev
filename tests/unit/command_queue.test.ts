import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandLane } from '../../src/background/command_queue.ts';

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolveFn, rejectFn) => {
		resolve = resolveFn;
		reject = rejectFn;
	});
	return { promise, resolve, reject };
}

test('runs operations in call order, never overlapping them', async () => {
	const lane = createCommandLane();
	const events: string[] = [];
	const first = deferred();

	const firstDone = lane.enqueue(async () => {
		events.push('first:start');
		await first.promise;
		events.push('first:end');
	});
	const secondDone = lane.enqueue(async () => {
		events.push('second:start');
	});

	await Promise.resolve();
	assert.deepEqual(events, ['first:start'], 'the second operation must not start while the first is pending');

	first.resolve();
	await Promise.all([firstDone, secondDone]);
	assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('a rejected operation reaches its caller without stalling the lane', async () => {
	const lane = createCommandLane();
	const failure = lane.enqueue(async () => {
		throw new Error('boom');
	});

	await assert.rejects(failure, /boom/u);
	assert.equal(await lane.enqueue(async () => 'next'), 'next');
});

test('runQueuedEvent consumes a rejection instead of leaving it unhandled', async () => {
	const lane = createCommandLane();
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);
	process.on('unhandledRejection', onUnhandled);

	try {
		lane.runQueuedEvent(async () => {
			throw new Error('event failed');
		});
		// Two macrotask turns is enough for Node to report an unhandled rejection if one escaped.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(rejections, []);
		assert.equal(await lane.enqueue(async () => 'still alive'), 'still alive');
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

