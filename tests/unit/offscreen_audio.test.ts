import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ACOUSTIC_TAIL_PADDING_MS,
	type AudioBufferFactory,
	createSpeechAudioBuffer,
	synthesizeSpeechUnitSamples,
} from '../../src/offscreen/audio.ts';

function voicedSamples(prefix: readonly number[]): Float32Array {
	const samples = new Float32Array(128).fill(0.5);
	samples.set(prefix);
	return samples;
}

function stubAudioContext(): AudioBufferFactory & { readonly created: { length: number; sampleRate: number }[] } {
	const created: { length: number; sampleRate: number }[] = [];
	return {
		created,
		createBuffer(_channels: number, length: number, sampleRate: number) {
			created.push({ length, sampleRate });
			const channel = new Float32Array(length);
			return {
				length,
				sampleRate,
				duration: length / sampleRate,
				getChannelData: () => channel,
			} as unknown as AudioBuffer;
		},
	};
}

test('uses zero internal silence for a numeric Latin pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'Hello.', pauseAfterMs: 60 }, 'en', 1.15, async (...args) => {
		calls.push(args);
		return voicedSamples([0.5]);
	});
	assert.deepEqual(calls, [['Hello.', 'en', 8, 1.15, 0]]);
	assert.equal(output[0], 0.5);
	assert.equal(output.length, 128);
});

test('treats numeric zero as an explicit pause', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: 'No punctuation', pauseAfterMs: 0 }, 'fr', 1, async (...args) => {
		calls.push(args);
		return voicedSamples([0.25]);
	});
	assert.deepEqual(calls, [['No punctuation', 'fr', 8, 1, 0]]);
	assert.equal(output[0], 0.25);
	assert.equal(output.length, 128);
});

test('asks the engine for its own silence when the pause is a null compatibility marker', async () => {
	const calls: unknown[][] = [];
	const output = await synthesizeSpeechUnitSamples({ text: '中文内容', pauseAfterMs: null }, 'zh', 1.05, async (...args) => {
		calls.push(args);
		return voicedSamples([0.75, -0.25]);
	});
	assert.deepEqual(calls, [['中文内容', 'zh', 8, 1.05, 0.3]]);
	assert.deepEqual(Array.from(output.slice(0, 2)), [0.75, -0.25]);
	assert.equal(output.length, 128);
});

test('passes an engine Float32Array straight through instead of copying it', async () => {
	const samples = voicedSamples([0.5, -0.5]);
	const output = await synthesizeSpeechUnitSamples({ text: 'xin chào', pauseAfterMs: 80 }, 'vi', 1.15, async () => samples);
	assert.equal(output, samples);
});

test('uses only synthesis text as the rendering override and forwards literal 1.5 controller speed', async () => {
	const calls: unknown[][] = [];
	await synthesizeSpeechUnitSamples(
		{ text: 'Heading The article continues.', synthesisText: 'Heading. The article continues.', pauseAfterMs: 260 },
		'en',
		1.5,
		async (...args) => {
			calls.push(args);
			return voicedSamples([0.5, -0.25]);
		},
	);

	assert.deepEqual(calls, [['Heading. The article continues.', 'en', 8, 1.5, 0]]);
});

test('adds a fixed acoustic tail before the requested pause and leaves both tails silent', () => {
	const audioCtx = stubAudioContext();
	const buffer = createSpeechAudioBuffer(audioCtx, new Float32Array([0.25, -0.5]), 1_000, 80);

	assert.equal(ACOUSTIC_TAIL_PADDING_MS, 60);
	assert.deepEqual(audioCtx.created, [{ length: 142, sampleRate: 1_000 }]);
	const channel = buffer.getChannelData(0);
	assert.deepEqual(Array.from(channel.slice(0, 2)), [0.25, -0.5]);
	assert.ok(channel.slice(2).every((sample) => sample === 0));
});

test('keeps the engine sample rate rather than resampling into the context rate', () => {
	const audioCtx = stubAudioContext();
	const buffer = createSpeechAudioBuffer(audioCtx, new Float32Array(44_100), 44_100, 0);

	assert.equal(buffer.sampleRate, 44_100);
	assert.equal(buffer.duration, 1.06);
});

test('validates numeric inputs', () => {
	const audioCtx = stubAudioContext();
	const samples = new Float32Array([1]);
	for (const sampleRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => createSpeechAudioBuffer(audioCtx, samples, sampleRate, 1), /sample rate/);
	}
	for (const pause of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => createSpeechAudioBuffer(audioCtx, samples, 24_000, pause), /pause/);
	}
});
