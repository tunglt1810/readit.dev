import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleFlight } from '../../src/offscreen/single_flight.ts';

test('shares concurrent work and permits retry after failure', async () => {
	let calls = 0;
	let shouldFail = true;
	const run = createSingleFlight(async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (shouldFail) {
			throw new Error('expected failure');
		}
	});

	await assert.rejects(Promise.all([run(), run()]), /expected failure/);
	assert.equal(calls, 1);

	shouldFail = false;
	await Promise.all([run(), run()]);
	assert.equal(calls, 2);
});
