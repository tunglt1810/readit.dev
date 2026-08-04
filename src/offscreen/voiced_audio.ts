/**
 * Initial raw-waveform calibration: a 128-sample (about 5 ms at 24 kHz) finite
 * window must have RMS at least 0.003 (-50.5 dBFS). The accompanying deterministic
 * fixtures document voiced, silent, non-finite, and padding-only cases; Task 3.5
 * real-model probes retain the production-capture validation record.
 */
export const MIN_VOICED_WINDOW_SAMPLES = 128;
export const MIN_VOICED_WINDOW_RMS = 0.003;

export type VoicedAudioFailureReason = 'empty' | 'non-finite' | 'materially-silent';

export interface VoicedAudioContext {
	unitIndex?: number;
	unitText?: string;
}

/** Metrics calculated from raw engine output, before any explicit-pause padding exists. */
export interface RawVoicedSampleMetrics {
	sampleCount: number;
	finite: boolean;
	peak: number;
	maxWindowRms: number;
	voiced: boolean;
}

export function inspectRawVoicedSamples(samples: ArrayLike<number>): RawVoicedSampleMetrics {
	let finite = true;
	let peak = 0;
	let rollingSquareSum = 0;
	let maxWindowRms = 0;

	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index];
		if (!Number.isFinite(sample)) {
			finite = false;
			continue;
		}

		peak = Math.max(peak, Math.abs(sample));
		rollingSquareSum += sample * sample;
		if (index >= MIN_VOICED_WINDOW_SAMPLES) {
			const oldestSample = samples[index - MIN_VOICED_WINDOW_SAMPLES];
			if (!Number.isFinite(oldestSample)) {
				finite = false;
				continue;
			}
			rollingSquareSum -= oldestSample * oldestSample;
		}
		if (index + 1 >= MIN_VOICED_WINDOW_SAMPLES) {
			maxWindowRms = Math.max(maxWindowRms, Math.sqrt(rollingSquareSum / MIN_VOICED_WINDOW_SAMPLES));
		}
	}

	return {
		sampleCount: samples.length,
		finite,
		peak,
		maxWindowRms,
		voiced: finite && maxWindowRms >= MIN_VOICED_WINDOW_RMS,
	};
}

/** A contextual synthesis failure raised when the engine produced no usable raw speech audio. */
export class VoicedAudioError extends Error {
	readonly reason: VoicedAudioFailureReason;
	readonly unitIndex?: number;
	readonly unitText?: string;

	constructor(reason: VoicedAudioFailureReason, context: VoicedAudioContext = {}) {
		const indexDiagnostic = context.unitIndex === undefined ? 'unknown unit' : `unit ${context.unitIndex}`;
		const textDiagnostic = context.unitText === undefined ? '' : `; canonical text: ${JSON.stringify(context.unitText)}`;
		super(`Unvoiced synthesis waveform (${reason}) for ${indexDiagnostic}${textDiagnostic}`);
		this.name = 'VoicedAudioError';
		this.reason = reason;
		this.unitIndex = context.unitIndex;
		this.unitText = context.unitText;
	}
}

/**
 * Reject raw model output that cannot contain usable speech. This deliberately
 * runs before a caller adds explicit trailing-pause zeros to an AudioBuffer.
 */
export function verifyRawVoicedSamples(samples: ArrayLike<number>, context: VoicedAudioContext = {}): void {
	const metrics = inspectRawVoicedSamples(samples);
	if (metrics.sampleCount === 0) {
		throw new VoicedAudioError('empty', context);
	}
	if (!metrics.finite) {
		throw new VoicedAudioError('non-finite', context);
	}
	if (!metrics.voiced) {
		throw new VoicedAudioError('materially-silent', context);
	}
}
