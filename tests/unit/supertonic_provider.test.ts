import assert from 'node:assert/strict';
import test from 'node:test';
import type { Style } from '../../src/offscreen/supertonic_helper.ts';
import { createSupertonicProvider } from '../../src/offscreen/supertonic_provider.ts';

const style = { dp: {} } as unknown as Style;

// verifyRawVoicedSamples rejects anything under 128 samples or quieter than 0.003 RMS, so the
// fixture has to be an actual waveform rather than a token array.
const VOICED = Float32Array.from({ length: 256 }, (_, index) => Math.sin(index / 4) * 0.5);

interface RecordedCall {
	text: string;
	lang: string;
	steps: number;
	speed: number;
	silence: number;
}

function makeProvider(wav = VOICED) {
	const calls: RecordedCall[] = [];
	const provider = createSupertonicProvider({
		engine: () => ({
			sampleRate: 44_100,
			async call(text: string, lang: string, _style: Style, steps: number, speed: number, silence: number) {
				calls.push({ text, lang, steps, speed, silence });
				return { wav };
			},
		}),
		style: async () => style,
	});
	return { provider, calls };
}

test('identifies itself as the supertonic provider', () => {
	assert.equal(makeProvider().provider.id, 'supertonic');
});

test('synthesizes the unit synthesis text and reports the engine sample rate', async () => {
	const { provider, calls } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: '20/05', synthesisText: 'hai mươi tháng năm', pauseAfterMs: 0 },
		lang: 'vi',
		voiceId: 'F1',
		speed: 1.5,
	});
	assert.equal(result.sampleRate, 44_100);
	assert.equal(result.samples.length, VOICED.length);
	assert.equal(calls[0].text, 'hai mươi tháng năm');
	assert.equal(calls[0].speed, 1.5);
});

test('never reports word timings, so the caller estimates them', async () => {
	const { provider } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0 },
		lang: 'en',
		voiceId: 'F1',
		speed: 1,
	});
	assert.equal(result.wordTimings, null);
});

test('renders internal silence for units with no trailing pause', async () => {
	const { provider, calls } = makeProvider();
	await provider.synthesize({ unit: { text: 'hello', pauseAfterMs: null }, lang: 'en', voiceId: 'F1', speed: 1 });
	assert.equal(calls[0].silence, 0.3);
});

test('reports raw engine samples to the diagnostics callback', async () => {
	const { provider } = makeProvider();
	const seen: Float32Array[] = [];
	await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0 },
		lang: 'en',
		voiceId: 'F1',
		speed: 1,
		onRawEngineSamples: (samples) => seen.push(samples),
	});
	assert.equal(seen.length, 1);
	assert.equal(seen[0].length, VOICED.length);
});

test('resolves the voice style for the requested voice id', async () => {
	const requested: string[] = [];
	const provider = createSupertonicProvider({
		engine: () => ({
			sampleRate: 24_000,
			async call() {
				return { wav: VOICED };
			},
		}),
		style: async (voiceId: string) => {
			requested.push(voiceId);
			return style;
		},
	});
	await provider.synthesize({ unit: { text: 'hello', pauseAfterMs: 0 }, lang: 'en', voiceId: 'M3', speed: 1 });
	assert.deepEqual(requested, ['M3']);
});
