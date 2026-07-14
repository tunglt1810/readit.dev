export function appendSilenceSamples(wav: Float32Array, sampleRate: number, pauseAfterMs: number): Float32Array {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError('sample rate must be positive and finite');
	}
	if (!Number.isFinite(pauseAfterMs) || pauseAfterMs < 0) {
		throw new RangeError('pause must be non-negative and finite');
	}
	const silenceSamples = Math.round((sampleRate * pauseAfterMs) / 1_000);
	const output = new Float32Array(wav.length + silenceSamples);
	output.set(wav);
	return output;
}

export type SpeechSynthesisCall = (
	text: string,
	lang: string,
	steps: number,
	speed: number,
	silenceDuration: number,
) => Promise<Float32Array | readonly number[]>;

export async function synthesizeSpeechUnitSamples(
	unit: SpeechUnit,
	lang: string,
	speed: number,
	sampleRate: number,
	synthesize: SpeechSynthesisCall,
): Promise<Float32Array> {
	const wav = await synthesize(unit.text, lang, 8, speed, 0);
	return appendSilenceSamples(wav instanceof Float32Array ? wav : Float32Array.from(wav), sampleRate, unit.pauseAfterMs);
}

import type { SpeechUnit } from './vietnamese/types.ts';
