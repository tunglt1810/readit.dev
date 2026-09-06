import assert from 'node:assert/strict';
import test from 'node:test';
import { createEdgeProvider, EdgeUnsupportedLanguageError } from '../../src/offscreen/edge/edge_provider.ts';
import type { EdgeWordBoundary } from '../../src/offscreen/edge/edge_socket.ts';

function makeProvider(boundaries: EdgeWordBoundary[] = [{ offsetMs: 0, durationMs: 500, text: 'hello' }]) {
	const sent: string[] = [];
	const provider = createEdgeProvider({
		socket: {
			async synthesize(ssml: string) {
				sent.push(ssml);
				return { audio: new Uint8Array([1, 2, 3]), boundaries };
			},
		},
		decode: async () => ({ samples: new Float32Array([0.5, -0.5]), sampleRate: 24_000 }),
	});
	return { provider, sent };
}

test('identifies itself as the edge provider', () => {
	assert.equal(makeProvider().provider.id, 'edge');
});

test('sends ssml built from the unit canonical text, not the normalized text', async () => {
	const { provider, sent } = makeProvider([{ offsetMs: 0, durationMs: 300, text: '20/05' }]);
	await provider.synthesize({
		unit: {
			text: '20/05',
			synthesisText: 'hai mươi tháng năm',
			pauseAfterMs: 0,
			wordMap: [{ text: '20/05', start: 0, end: 5 }],
		},
		lang: 'vi',
		voiceId: 'vi-VN-HoaiMyNeural',
		speed: 1.5,
	});
	assert.match(sent[0], />20\/05</u);
	assert.doesNotMatch(sent[0], /hai mươi/u);
	assert.match(sent[0], /rate='\+50%'/u);
	assert.match(sent[0], /xml:lang='vi-VN'/u);
});

test('returns decoded samples with the decoder sample rate', async () => {
	const { provider } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.deepEqual(Array.from(result.samples), [0.5, -0.5]);
	assert.equal(result.sampleRate, 24_000);
});

test('reports aligned word timings when the boundaries reconcile', async () => {
	const { provider } = makeProvider();
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.deepEqual(result.wordTimings, [{ text: 'hello', wordIndex: 0, startSec: 0, endSec: 0.5 }]);
});

test('falls back to null timings when the boundaries cannot be aligned', async () => {
	const { provider } = makeProvider([{ offsetMs: 0, durationMs: 500, text: 'goodbye' }]);
	const result = await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.equal(result.wordTimings, null);
});

test('rejects a language Microsoft has no voices for', async () => {
	const { provider } = makeProvider();
	await assert.rejects(
		provider.synthesize({ unit: { text: 'hello', pauseAfterMs: 0 }, lang: 'na', voiceId: 'x', speed: 1 }),
		EdgeUnsupportedLanguageError,
	);
});

test('requests a trailing break for units with no pause', async () => {
	const { provider, sent } = makeProvider();
	await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: null, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
	});
	assert.match(sent[0], /<break time='300ms'\/>/u);
});

test('reports decoded samples to the diagnostics callback', async () => {
	const { provider } = makeProvider();
	const seen: Float32Array[] = [];
	await provider.synthesize({
		unit: { text: 'hello', pauseAfterMs: 0, wordMap: [{ text: 'hello', start: 0, end: 5 }] },
		lang: 'en',
		voiceId: 'en-US-AvaNeural',
		speed: 1,
		onRawEngineSamples: (samples) => seen.push(samples),
	});
	assert.equal(seen.length, 1);
	assert.deepEqual(Array.from(seen[0]), [0.5, -0.5]);
});
