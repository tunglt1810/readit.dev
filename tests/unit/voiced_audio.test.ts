import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeechAudioBuffer, type AudioBufferFactory, synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';

/** Validates: Requirements 1.1, 2.3, 2.6, 2.8, 3.6 */

function stubAudioContext(): AudioBufferFactory {
	return {
		createBuffer(_channels, length, sampleRate) {
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

async function expectTypedVoicedFailure(samples: Float32Array, name: string): Promise<void> {
	await assert.rejects(
		() => synthesizeSpeechUnitSamples({ text: 'Solo short unit', pauseAfterMs: 180 }, 'en', 1.5, async () => samples),
		(error: unknown) => error instanceof Error && /voiced|waveform|audio/iu.test(error.message),
		`Property 1 raw pre-padding counterexample (${name}): the baseline accepted ${JSON.stringify(
			Array.from(samples.slice(0, 8)),
		)} from a retained short unit instead of reporting a typed synthesis failure.`,
	);
}

test('expected bug condition: isolated short unit rejects an empty raw waveform before padding', async () => {
	await expectTypedVoicedFailure(new Float32Array(), 'empty waveform');
});

test('expected bug condition: isolated short unit rejects a materially silent raw waveform before padding', async () => {
	const raw = new Float32Array(32);
	const padded = createSpeechAudioBuffer(stubAudioContext(), raw, 1_000, 180);
	assert.equal(padded.length, raw.length + 180, 'explicit trailing silence is appended only after the raw waveform');
	await expectTypedVoicedFailure(raw, 'all-zero waveform with a separate 180-sample padding tail');
});

test('expected bug condition: capacity-blocked short unit rejects a non-finite raw waveform before padding', async () => {
	await assert.rejects(
		() =>
			synthesizeSpeechUnitSamples(
				{ text: 'short-frag', pauseAfterMs: 0 },
				'ko',
				1.5,
				async () => new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]),
			),
		(error: unknown) => error instanceof Error && /voiced|waveform|audio/iu.test(error.message),
		'Property 1 raw pre-padding counterexample (Korean 120-character capacity-blocked neighbor): non-finite raw samples were accepted instead of producing a typed synthesis failure.',
	);
});
