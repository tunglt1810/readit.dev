import assert from 'node:assert/strict';
import test from 'node:test';
import { SynthesisArbiter } from '../../src/offscreen/synthesis_arbiter.ts';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test('runs only one inference at a time', async () => {
	let running = 0;
	let maximumRunning = 0;
	const arbiter = new SynthesisArbiter<string, string>(async (value) => {
		running++;
		maximumRunning = Math.max(maximumRunning, running);
		await Promise.resolve();
		running--;
		return value;
	});

	assert.deepEqual(await Promise.all([arbiter.foreground('one'), arbiter.foreground('two'), arbiter.background('three')]), [
		'one',
		'two',
		'three',
	]);
	assert.equal(maximumRunning, 1);
});

test('keeps FIFO order within each lane', async () => {
	const order: string[] = [];
	const arbiter = new SynthesisArbiter<string, string>(async (value) => {
		order.push(value);
		return value;
	});

	await Promise.all([arbiter.foreground('foreground-1'), arbiter.foreground('foreground-2'), arbiter.background('background-1'), arbiter.background('background-2')]);
	assert.deepEqual(order, ['foreground-1', 'foreground-2', 'background-1', 'background-2']);
});

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

test('never preempts a running background inference', async () => {
	const first = deferred<string>();
	const order: string[] = [];
	const arbiter = new SynthesisArbiter<string, string>(async (value) => {
		order.push(value);
		if (value === 'background') await first.promise;
		return value;
	});

	const background = arbiter.background('background');
	const foreground = arbiter.foreground('foreground');
	assert.deepEqual(order, ['background']);
	first.resolve('done');
	await Promise.all([background, foreground]);
	assert.deepEqual(order, ['background', 'foreground']);
});

test('isolates rejected work and resumes background after foreground drains', async () => {
	const order: string[] = [];
	const arbiter = new SynthesisArbiter<string, string>(async (value) => {
		order.push(value);
		if (value === 'foreground-failure') throw new Error('expected failure');
		return value;
	});

	const failedForeground = arbiter.foreground('foreground-failure');
	const background = arbiter.background('background-success');
	await assert.rejects(failedForeground, /expected failure/);
	assert.equal(await background, 'background-success');
	assert.deepEqual(order, ['foreground-failure', 'background-success']);
});
