import type { PreparedAudioExport } from './audio_export_engine.ts';
import type { AudioExportEstimate } from '../shared/types.ts';

/**
 * Test-only view of an immutable export snapshot. It deliberately excludes
 * speech units, voice data, titles, filenames, and output handles.
 */
export interface ExportSnapshotDiagnosticRecord {
	readonly jobId: string;
	readonly playbackSessionId: string;
	readonly unitCount: number;
	readonly language: string;
	readonly voiceStyleId: string;
	readonly speed: number;
	readonly estimate: Readonly<AudioExportEstimate>;
}

function snapshotMetadata(input: PreparedAudioExport): ExportSnapshotDiagnosticRecord {
	return Object.freeze({
		jobId: input.jobId,
		playbackSessionId: input.playbackSessionId,
		unitCount: input.units.length,
		language: input.language,
		voiceStyleId: input.voiceStyleId,
		speed: input.speed,
		estimate: Object.freeze({ ...input.estimate }),
	});
}

/**
 * Bounded metadata capture for CDP-only acceptance probes. There is no runtime
 * message or product UI route to this recorder.
 */
export class ExportSnapshotDiagnostics {
	private records: readonly ExportSnapshotDiagnosticRecord[] = [];

	record(input: PreparedAudioExport): void {
		this.records = [...this.records, snapshotMetadata(input)].slice(-64);
	}

	read(jobId?: string): readonly ExportSnapshotDiagnosticRecord[] {
		return this.records
			.filter((record) => jobId === undefined || record.jobId === jobId)
			.map((record) => Object.freeze({ ...record, estimate: Object.freeze({ ...record.estimate }) }));
	}

	clear(jobId?: string): void {
		this.records = jobId === undefined ? [] : this.records.filter((record) => record.jobId !== jobId);
	}
}
