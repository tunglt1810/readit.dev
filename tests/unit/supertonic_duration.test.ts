import assert from 'node:assert/strict';
import test from 'node:test';
import { durationScaleForLanguage, TextToSpeech } from '../../src/offscreen/supertonic_helper.ts';

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

test('shortens the predicted duration per language, so a Vietnamese latent is not sized for English word lengths', async () => {
	const textProcessor = {
		call() {
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
		async run() {
			return { duration: { data: new Float32Array([16, 16]) } };
		},
	};
	const style = { dp: { type: 'float32', data: new Float32Array([0.25, -0.5]), dims: [1, 1, 2] } };
	const engine = new TextToSpeech(
		{ ae: { sample_rate: 24_000, base_chunk_size: 512 }, ttl: { chunk_compress_factor: 4, latent_dim: 64 } },
		textProcessor as never,
		durationPredictor as never,
		{} as never,
		{} as never,
		{} as never,
	);

	// Same raw prediction, same speed: only the language differs. How far Vietnamese is shortened is
	// a knob set by listening, so assert the relationship rather than pinning today's value.
	const [vietnamese, english] = await engine.predictDurations(['a', 'b'], ['vi', 'en'], style as never, 1);
	assert.equal(english, 16);
	assert.equal(vietnamese, 16 / durationScaleForLanguage('vi'));
	assert.ok(vietnamese < english);
});

test('leaves every uncalibrated language at the model prediction', () => {
	assert.equal(durationScaleForLanguage('en'), 1);
	assert.equal(durationScaleForLanguage('na'), 1);
	assert.equal(durationScaleForLanguage('ko'), 1);
	assert.ok(durationScaleForLanguage('vi') > 1);
});
