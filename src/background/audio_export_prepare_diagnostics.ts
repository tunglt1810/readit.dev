/**
 * Test-only capture of export preparation outcomes. It is intentionally exposed
 * only through a debugger-visible service-worker global; no extension message
 * or product UI reads these records.
 */
export type AudioExportPreparationOutcome = 'prepared' | 'offscreen-rejected' | 'offscreen-transport-failed';

export interface AudioExportPreparationDiagnosticRecord {
	readonly jobId: string;
	readonly playbackSessionId: string;
	readonly outcome: AudioExportPreparationOutcome;
	readonly innerError: string | null;
}

export class AudioExportPreparationDiagnostics {
	private records: readonly AudioExportPreparationDiagnosticRecord[] = [];

	record(input: AudioExportPreparationDiagnosticRecord): void {
		const record = Object.freeze({ ...input });
		this.records = [...this.records, record].slice(-64);
	}

	read(jobId?: string): readonly AudioExportPreparationDiagnosticRecord[] {
		return this.records
			.filter((record) => jobId === undefined || record.jobId === jobId)
			.map((record) => Object.freeze({ ...record }));
	}

	clear(jobId?: string): void {
		this.records = jobId === undefined ? [] : this.records.filter((record) => record.jobId !== jobId);
	}
}
