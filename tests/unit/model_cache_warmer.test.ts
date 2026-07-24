import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelCacheWarmer } from '../../src/background/model_cache_warmer.ts';

test('shares one active warm run between concurrent warm calls', async () => {
	let runs = 0;
	let resolveRun!: () => void;
	const runPromise = new Promise<void>((resolve) => {
		resolveRun = resolve;
	});

	const warmer = createModelCacheWarmer(async () => {
		runs++;
		await runPromise;
	});

	const first = warmer.warm();
	const second = warmer.warm();

	assert.equal(runs, 1);
	assert.strictEqual(first, second);

	resolveRun();
	await Promise.all([first, second]);
});

test('clears the current warm after rejection so a later lifecycle event retries', async () => {
	let runs = 0;
	const warmer = createModelCacheWarmer(async () => {
		runs++;
		if (runs === 1) {
			throw new Error('offline');
		}
	});

	await assert.rejects(warmer.warm(), /offline/);
	await warmer.warm();
	assert.equal(runs, 2);
});

test('waitForCurrentWarm resolves immediately when idle and waits when warming', async () => {
	let resolveRun!: () => void;
	const runPromise = new Promise<void>((resolve) => {
		resolveRun = resolve;
	});

	const warmer = createModelCacheWarmer(async () => {
		await runPromise;
	});

	// Idle state
	await warmer.waitForCurrentWarm();

	// Active state
	const warmPromise = warmer.warm();
	let waitResolved = false;
	const waitPromise = warmer.waitForCurrentWarm().then(() => {
		waitResolved = true;
	});

	assert.equal(waitResolved, false);
	resolveRun();
	await warmPromise;
	await waitPromise;
	assert.equal(waitResolved, true);
});

test('Play-during-warm: blocks setupOffscreen until warm settles and allows Play when warm fails', async () => {
	let resolveWarm!: () => void;
	let rejectWarm!: (err: Error) => void;

	// Case A: Play waits for successful warm before setupOffscreen
	const warmerA = createModelCacheWarmer(
		() =>
			new Promise<void>((resolve) => {
				resolveWarm = resolve;
			}),
	);

	void warmerA.warm();
	let offscreenCreatedA = false;
	const simulatedPlayA = (async () => {
		try {
			await warmerA.waitForCurrentWarm();
		} catch (_error) {
			// Gate tolerates warm rejection
		}
		offscreenCreatedA = true;
	})();

	assert.equal(offscreenCreatedA, false);
	resolveWarm();
	await simulatedPlayA;
	assert.equal(offscreenCreatedA, true);

	// Case B: Play proceeds with setupOffscreen even if warm rejected
	const warmerB = createModelCacheWarmer(
		() =>
			new Promise<void>((_resolve, reject) => {
				rejectWarm = reject;
			}),
	);

	void warmerB.warm().catch(() => {});
	let offscreenCreatedB = false;
	const simulatedPlayB = (async () => {
		try {
			await warmerB.waitForCurrentWarm();
		} catch (_error) {
			// Gate tolerates warm rejection
		}
		offscreenCreatedB = true;
	})();

	assert.equal(offscreenCreatedB, false);
	rejectWarm(new Error('Network error during warm'));
	await simulatedPlayB;
	assert.equal(offscreenCreatedB, true);
});
