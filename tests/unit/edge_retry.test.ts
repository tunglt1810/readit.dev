import assert from 'node:assert/strict';
import test from 'node:test';
import { EDGE_SYNTHESIS_ATTEMPTS, retryEdgeSynthesis } from '../../src/offscreen/edge/edge_retry.ts';

const retryable = (error: unknown) => error instanceof Error && error.message === 'transient';

test('returns the first success without retrying', async () => {
	let calls = 0;
	const result = await retryEdgeSynthesis(
		async () => {
			calls += 1;
			return 'audio';
		},
		{ attempts: 3, isRetryable: retryable, onRetry: async () => undefined },
	);
	assert.equal(result, 'audio');
	assert.equal(calls, 1);
});

test('survives a transient failure that a later attempt recovers from', async () => {
	let calls = 0;
	const retried: number[] = [];
	const result = await retryEdgeSynthesis(
		async () => {
			calls += 1;
			if (calls < 3) {
				throw new Error('transient');
			}
			return 'audio';
		},
		{ attempts: 3, isRetryable: retryable, onRetry: async (_error, attempt) => void retried.push(attempt) },
	);
	assert.equal(result, 'audio');
	assert.equal(calls, 3);
	assert.deepEqual(retried, [1, 2], 'each failed attempt is reported before the next one starts');
});

test('gives up after the configured number of attempts', async () => {
	let calls = 0;
	await assert.rejects(
		retryEdgeSynthesis(
			async () => {
				calls += 1;
				throw new Error('transient');
			},
			{ attempts: 3, isRetryable: retryable, onRetry: async () => undefined },
		),
		/transient/u,
	);
	assert.equal(calls, 3);
});

test('does not retry an error the caller cannot recover from', async () => {
	let calls = 0;
	await assert.rejects(
		retryEdgeSynthesis(
			async () => {
				calls += 1;
				throw new Error('permanent');
			},
			{ attempts: 3, isRetryable: retryable, onRetry: async () => undefined },
		),
		/permanent/u,
	);
	assert.equal(calls, 1, 'a non-retryable error must surface immediately');
});

// One transient blip should not cost the rest of the article, which is what a single attempt did.
test('allows more than one attempt by default', () => {
	assert.ok(EDGE_SYNTHESIS_ATTEMPTS >= 3, `expected at least 3 attempts, got ${EDGE_SYNTHESIS_ATTEMPTS}`);
});
