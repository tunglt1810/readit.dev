/**
 * Test-only capture of immutable export preparation outcomes. It is exposed only
 * through the offscreen document's debugger-visible global; no extension
 * message or product UI reads these records.
 */
export type ExportPreparationOutcome = 'prepared' | 'rejected';

export interface ExportPreparationDiagnosticRecord {
	readonly jobId: string | null;
	readonly playbackSessionId: string | null;
	readonly outcome: ExportPreparationOutcome;
	readonly innerError: string | null;
	readonly reason: string | null;
	readonly payloadKeys: readonly string[];
}

export class ExportPreparationDiagnostics {
	private records: readonly ExportPreparationDiagnosticRecord[] = [];

	record(input: ExportPreparationDiagnosticRecord): void {
		const record = Object.freeze({ ...input });
		this.records = [...this.records, record].slice(-64);
	}

	read(jobId?: string): readonly ExportPreparationDiagnosticRecord[] {
		return this.records
			.filter((record) => jobId === undefined || record.jobId === jobId)
			.map((record) => Object.freeze({ ...record }));
	}

	clear(jobId?: string): void {
		this.records = jobId === undefined ? [] : this.records.filter((record) => record.jobId !== jobId);
	}
}
