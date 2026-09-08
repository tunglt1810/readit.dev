import { localeForLanguage } from '../../shared/edge_voices.ts';
import type { SpeechProvider, SpeechProviderInput, SynthesizedUnit } from '../speech_provider.ts';
import type { EdgeSynthesisResult } from './edge_socket.ts';
import { buildSsml } from './edge_ssml.ts';
import { alignWordBoundaries } from './word_boundary_alignment.ts';

/**
 * Matches the internal silence Supertonic renders for units with no trailing pause.
 *
 * Appended to the decoded samples rather than requested through SSML: the readaloud endpoint
 * closes the connection with 1007 on `<break>` and every other structural tag.
 */
const INTERNAL_SILENCE_MS = 300;

/** A copy of `samples` with `silenceMs` of zeroes after it, or `samples` itself when none is due. */
function withTrailingSilence(samples: Float32Array, sampleRate: number, silenceMs: number): Float32Array {
	if (silenceMs <= 0) {
		return samples;
	}
	const padded = new Float32Array(samples.length + Math.round((sampleRate * silenceMs) / 1_000));
	padded.set(samples);
	return padded;
}

export class EdgeUnsupportedLanguageError extends Error {
	constructor(lang: string) {
		super(`edge-tts has no voices for language ${lang}`);
		this.name = 'EdgeUnsupportedLanguageError';
	}
}

export interface EdgeProviderDependencies {
	socket: { synthesize(ssml: string): Promise<EdgeSynthesisResult> };
	/** Injected because decodeAudioData needs a real AudioContext. */
	decode(audio: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }>;
}

/**
 * The cloud path.
 *
 * It speaks `unit.text`, never `unit.synthesisText`: the normalizer exists to make Supertonic
 * pronounce numbers and dates correctly, and Microsoft's own frontend already does that job —
 * running both would expand the same string twice.
 */
export function createEdgeProvider(deps: EdgeProviderDependencies): SpeechProvider {
	return {
		id: 'edge',
		async synthesize(input: SpeechProviderInput): Promise<SynthesizedUnit> {
			const locale = localeForLanguage(input.lang);
			if (locale === null) {
				throw new EdgeUnsupportedLanguageError(input.lang);
			}
			const ssml = buildSsml({
				text: input.unit.text,
				voice: input.voiceId,
				locale,
				speed: input.speed,
			});
			const { audio, boundaries } = await deps.socket.synthesize(ssml);
			const { samples, sampleRate } = await deps.decode(audio);
			// Reported before padding: the diagnostics compare against what the engine produced.
			input.onRawEngineSamples?.(samples);
			return {
				samples: withTrailingSilence(samples, sampleRate, input.unit.pauseAfterMs === null ? INTERNAL_SILENCE_MS : 0),
				sampleRate,
				wordTimings: alignWordBoundaries(input.unit.wordMap ?? [], boundaries),
			};
		},
	};
}
