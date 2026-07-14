import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSilenceSamples, synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';

test('appends the requested silence without changing waveform samples', () => {
	const output = appendSilenceSamples(new Float32Array([0.25, -0.5]), 1_000, 80);
	assert.equal(output.length, 82);
	assert.deepEqual(Array.from(output.slice(0, 2)), [0.25, -0.5]);
	assert.ok(output.slice(2).every((sample) => sample === 0));
});

test('uses exact Vietnamese synthesis parameters and appends the unit pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'xin chào', pauseAfterMs: 80 }, 'vi', 1.15, 1_000, async (...args) => {
		calls.push(args);
		return [0.5];
	});
	assert.deepEqual(calls, [['xin chào', 'vi', 8, 1.15, 0]]);
	assert.equal(output.length, 81);
});

test('returns a copy for zero silence and validates numeric inputs', () => {
	const input = new Float32Array([1]);
	const output = appendSilenceSamples(input, 24_000, 0);
	assert.notEqual(output, input);
	assert.deepEqual(output, input);
	for (const sampleRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => appendSilenceSamples(input, sampleRate, 1), /sample rate/);
	}
	for (const pause of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => appendSilenceSamples(input, 24_000, pause), /pause/);
	}
});
