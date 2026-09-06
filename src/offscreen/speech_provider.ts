import type { SpeechUnit } from './speech_unit.ts';
import type { WordTimingWindow } from './word_timing.ts';

export interface SpeechProviderInput {
	unit: SpeechUnit;
	lang: string;
	voiceId: string;
	speed: number;
	/** Called with the engine's raw output before verification, for boundary diagnostics. */
	onRawEngineSamples?: (samples: Float32Array) => void;
}

export interface SynthesizedUnit {
	samples: Float32Array;
	sampleRate: number;
	/** null when the provider cannot report timings; the caller estimates them instead. */
	wordTimings: WordTimingWindow[] | null;
}

/** What the synthesis coordinator caches: decoded audio plus whatever timings came with it. */
export interface SynthesizedPlayback {
	buffer: AudioBuffer;
	wordTimings: WordTimingWindow[] | null;
}

export interface SpeechProvider {
	readonly id: 'supertonic' | 'edge';
	synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit>;
}
