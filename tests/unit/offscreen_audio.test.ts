import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSilenceSamples, synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';

test('appends the requested silence without changing waveform samples', () => {
	const output = appendSilenceSamples(new Float32Array([0.25, -0.5]), 1_000, 80);
	assert.equal(output.length, 82);
	assert.deepEqual(Array.from(output.slice(0, 2)), [0.25, -0.5]);
	assert.ok(output.slice(2).every((sample) => sample === 0));
});

test('uses zero internal silence and appends a numeric Latin pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'Hello.', pauseAfterMs: 60 }, 'en', 1.15, 1_000, async (...args) => {
		calls.push(args);
		return [0.5];
	});
	assert.deepEqual(calls, [['Hello.', 'en', 8, 1.15, 0]]);
	assert.equal(output.length, 61);
});

test('treats numeric zero as an explicit pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'No punctuation', pauseAfterMs: 0 }, 'fr', 1, 1_000, async (...args) => {
		calls.push(args);
		return [0.25];
	});
	assert.deepEqual(calls, [['No punctuation', 'fr', 8, 1, 0]]);
	assert.deepEqual(Array.from(output), [0.25]);
});

test('uses engine silence without appending for a null compatibility pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: '中文内容', pauseAfterMs: null }, 'zh', 1.05, 1_000, async (...args) => {
		calls.push(args);
		return [0.75, -0.25];
	});
	assert.deepEqual(calls, [['中文内容', 'zh', 8, 1.05, 0.3]]);
	assert.deepEqual(Array.from(output), [0.75, -0.25]);
});

test('forwards Vietnamese and appends its existing explicit pause', async () => {
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
