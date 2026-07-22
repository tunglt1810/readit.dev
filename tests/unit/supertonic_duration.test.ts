import assert from 'node:assert/strict';
import test from 'node:test';
import { TextToSpeech } from '../../src/offscreen/supertonic_helper.ts';

test('predicts a speed-adjusted duration for each text in one duration-model batch', async () => {
	const calls: unknown[] = [];
	const textProcessor = {
		call(textList: string[], langList: string[]) {
			calls.push({ textList, langList });
			return {
				textIds: [
					[1, 0],
					[2, 3],
				],
				textMask: [[[1, 0]], [[1, 1]]],
			};
		},
	};
	const durationPredictor = {
		async run(inputs: { style_dp: { data: Float32Array; dims: readonly number[] } }) {
			calls.push(inputs);
			assert.deepEqual(inputs.style_dp.dims, [2, 1, 2]);
			assert.deepEqual(Array.from(inputs.style_dp.data), [0.25, -0.5, 0.25, -0.5]);
			return { duration: { data: new Float32Array([2, 6]) } };
		},
	};
	const style = {
		dp: { type: 'float32', data: new Float32Array([0.25, -0.5]), dims: [1, 1, 2] },
	};
	const engine = new TextToSpeech(
		{ ae: { sample_rate: 24_000, base_chunk_size: 512 }, ttl: { chunk_compress_factor: 4, latent_dim: 64 } },
		textProcessor as never,
		durationPredictor as never,
		{} as never,
		{} as never,
		{} as never,
	);

	assert.deepEqual(await engine.predictDurations(['one', 'two'], ['en', 'en'], style as never, 2), [1, 3]);
	assert.deepEqual(calls[0], { textList: ['one', 'two'], langList: ['en', 'en'] });
	assert.equal(calls.length, 2);
});
