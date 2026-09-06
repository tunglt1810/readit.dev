import { synthesizeSpeechUnitSamples } from './audio.ts';
import type { SpeechProvider, SpeechProviderInput, SynthesizedUnit } from './speech_provider.ts';
import type { Style } from './supertonic_helper.ts';

interface SupertonicEngine {
	sampleRate: number;
	call(text: string, lang: string, style: Style, steps: number, speed: number, silenceDuration: number): Promise<{ wav: Float32Array }>;
}

export interface SupertonicProviderDependencies {
	engine(): SupertonicEngine;
	style(voiceId: string): Promise<Style>;
}

/**
 * The on-device path, unchanged in behaviour — it only moved behind the provider interface.
 *
 * It has no notion of word timings: asking the duration model for them costs one padded batch per
 * word, which stalled playback at every unit boundary (see word_timing.ts).
 */
export function createSupertonicProvider(deps: SupertonicProviderDependencies): SpeechProvider {
	return {
		id: 'supertonic',
		async synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit> {
			const engine = deps.engine();
			const style = await deps.style(input.voiceId);
			const samples = await synthesizeSpeechUnitSamples(
				input.unit,
				input.lang,
				input.speed,
				async (text, lang, steps, speed, silenceDuration) =>
					(await engine.call(text, lang, style, steps, speed, silenceDuration)).wav,
				{ unitText: input.unit.text },
				input.onRawEngineSamples,
			);
			return { samples, sampleRate: engine.sampleRate, wordTimings: null };
		},
	};
}
