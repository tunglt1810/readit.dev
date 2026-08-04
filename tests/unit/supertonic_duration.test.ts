import assert from 'node:assert/strict';
import test from 'node:test';
import { TextToSpeech, UnicodeProcessor } from '../../src/offscreen/supertonic_helper.ts';

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

test('uses the literal controller speed as the only duration divisor for Vietnamese and English', async () => {
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
			return { duration: { data: new Float32Array([21, 21]) } };
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

	assert.deepEqual(await engine.predictDurations(['Vũ', 'English short'], ['vi', 'en'], style as never, 1.5), [14, 14]);
	assert.deepEqual(await engine.predictDurations(['Vũ', 'English short'], ['vi', 'en'], style as never, 1.05), [20, 20]);
	assert.deepEqual(await engine.predictDurations(['Vũ', 'English short'], ['vi', 'en'], style as never, 1.25), [16.8, 16.8]);
});

test('appends period to parenthesized and quoted text ending without sentence punctuation and includes tail space in tag', () => {
	const processor = new UnicodeProcessor({});
	assert.equal(processor.preprocessText('Huyền Lê (Theo AFP, CNN)', 'vi'), 'Huyền Lê (Theo AFP, CNN)'.normalize('NFKD').replace(/.*/, (s) => `<vi>${s}. </vi>`));
	assert.equal(processor.preprocessText('Data & Analytics Enablement', 'en'), '<en>Data and Analytics Enablement. </en>');
	assert.equal(processor.preprocessText('Data & Analytics Enablement', 'vi'), '<vi>Data và Analytics Enablement. </vi>');
});

