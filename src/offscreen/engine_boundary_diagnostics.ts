import { inspectRawVoicedSamples } from './voiced_audio.ts';

/**
 * Test-only capture of the model output at the engine boundary. It intentionally
 * retains metrics only: raw samples remain owned by the caller and are never
 * copied into extension memory or exposed through the diagnostic view.
 */
export const ENGINE_BOUNDARY_DIAGNOSTIC_STAGE = 'after-engine-call-before-raw-verification-and-padding' as const;

export type EngineBoundaryOwner = 'foreground' | 'export';

export interface EngineBoundaryDiagnosticRecord {
	readonly stage: typeof ENGINE_BOUNDARY_DIAGNOSTIC_STAGE;
	readonly probeId: string | null;
	readonly unitIndex: number | null;
	readonly owner: EngineBoundaryOwner;
	readonly canonicalTextHash: string;
	readonly synthesisTextHash: string;
	readonly language: string;
	readonly requestedSpeed: number;
	readonly rawSampleCount: number;
	readonly finite: boolean;
	readonly peak: number;
	readonly maxWindowRms: number;
	readonly voiced: boolean;
}

export interface EngineBoundaryDiagnosticInput {
	probeId: string | null;
	unitIndex: number | null;
	owner: EngineBoundaryOwner;
	canonicalText: string;
	synthesisText: string;
	language: string;
	requestedSpeed: number;
	samples: ArrayLike<number>;
}

/** A stable non-reversible identifier suitable for fixture-oriented diagnostics. */
export function safeTextIdentifier(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${[...text].length}`;
}

/**
 * A bounded in-memory recorder with no runtime-message API. Its view is exposed
 * only on the offscreen target for acceptance probes using the browser debugger.
 */
export class EngineBoundaryDiagnostics {
	private records: readonly EngineBoundaryDiagnosticRecord[] = [];

	record(input: EngineBoundaryDiagnosticInput): void {
		const metrics = inspectRawVoicedSamples(input.samples);
		const record: EngineBoundaryDiagnosticRecord = Object.freeze({
			stage: ENGINE_BOUNDARY_DIAGNOSTIC_STAGE,
			probeId: input.probeId,
			unitIndex: input.unitIndex,
			owner: input.owner,
			canonicalTextHash: safeTextIdentifier(input.canonicalText),
			synthesisTextHash: safeTextIdentifier(input.synthesisText),
			language: input.language,
			requestedSpeed: input.requestedSpeed,
			rawSampleCount: metrics.sampleCount,
			finite: metrics.finite,
			peak: metrics.peak,
			maxWindowRms: metrics.maxWindowRms,
			voiced: metrics.voiced,
		});
		this.records = [...this.records, record].slice(-512);
	}

	read(probeId?: string | null): readonly EngineBoundaryDiagnosticRecord[] {
		return this.records
			.filter((record) => probeId === undefined || record.probeId === probeId)
			.map((record) => Object.freeze({ ...record }));
	}

	clear(probeId?: string | null): void {
		this.records = probeId === undefined ? [] : this.records.filter((record) => record.probeId !== probeId);
	}
}
