import type { SpeechUnit } from './speech_unit.ts';
import { type VoicedAudioContext, verifyRawVoicedSamples } from './voiced_audio.ts';

export const ACOUSTIC_TAIL_PADDING_MS = 60;

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
	synthesize: SpeechSynthesisCall,
	context: VoicedAudioContext = { unitText: unit.text },
	onRawEngineSamples?: (samples: Float32Array) => void,
): Promise<Float32Array> {
	const internalSilence = unit.pauseAfterMs === null ? 0.3 : 0;
	const wav = await synthesize(unit.synthesisText ?? unit.text, lang, 8, speed, internalSilence);
	const samples = wav instanceof Float32Array ? wav : Float32Array.from(wav);
	// This runs directly after the engine result resolves, before verification or pause padding.
	onRawEngineSamples?.(samples);
	verifyRawVoicedSamples(samples, context);
	return samples;
}

/** The minimal surface of an AudioContext this module needs, so it can be exercised without one. */
export interface AudioBufferFactory {
	createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

/**
 * A unit's audio followed by fixed acoustic-tail padding and its requested trailing pause, as one
 * AudioBuffer.
 *
 * The zero-filled tail and pause are part of the allocation rather than separate arrays concatenated
 * on. The samples go in as float32 rather than through a 16-bit WAV that `decodeAudioData` then had
 * to parse back out. That removes two full copies of every unit and the 16-bit quantization with
 * them. The buffer keeps the engine's sample rate: `AudioBufferSourceNode` resamples on playback if
 * the context runs at a different one.
 */
export function createSpeechAudioBuffer(
	audioCtx: AudioBufferFactory,
	samples: Float32Array,
	sampleRate: number,
	pauseAfterMs: number,
): AudioBuffer {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError('sample rate must be positive and finite');
	}
	if (!Number.isFinite(pauseAfterMs) || pauseAfterMs < 0) {
		throw new RangeError('pause must be non-negative and finite');
	}
	const acousticTailSamples = Math.round((sampleRate * ACOUSTIC_TAIL_PADDING_MS) / 1_000);
	const silenceSamples = Math.round((sampleRate * pauseAfterMs) / 1_000);
	const buffer = audioCtx.createBuffer(1, samples.length + acousticTailSamples + silenceSamples, sampleRate);
	// Written through the channel rather than copyToChannel, which insists on a Float32Array backed
	// by a plain ArrayBuffer — the engine's output makes no such promise about its backing store.
	buffer.getChannelData(0).set(samples);
	return buffer;
}
