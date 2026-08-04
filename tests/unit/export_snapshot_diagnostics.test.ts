import assert from 'node:assert/strict';
import test from 'node:test';

import { ExportSnapshotDiagnostics } from '../../src/offscreen/export_snapshot_diagnostics.ts';
import type { PreparedAudioExport } from '../../src/offscreen/audio_export_engine.ts';
import type { Style } from '../../src/offscreen/supertonic_helper.ts';

function preparedExport(): PreparedAudioExport {
	return {
		jobId: 'job-1',
		playbackSessionId: 'session-1',
		outputFilename: 'private-output.mp3',
		units: [{ text: 'Prepared text must not be exposed.', pauseAfterMs: 0 }],
		language: 'en',
		voiceStyleId: 'voice-1',
		style: { privateStyleData: true } as unknown as Style,
		speed: 1.5,
		estimate: { durationSeconds: 12, estimatedBytes: 148_096 },
	};
}

test('exposes only immutable export snapshot metadata for a prepared job', () => {
	const diagnostics = new ExportSnapshotDiagnostics();
	const snapshot = preparedExport();
	diagnostics.record(snapshot);

	snapshot.units[0]!.text = 'mutated after preparation';
	snapshot.estimate.durationSeconds = 999;
	const [record] = diagnostics.read('job-1');

	assert.deepEqual(record, {
		jobId: 'job-1',
		playbackSessionId: 'session-1',
		unitCount: 1,
		language: 'en',
		voiceStyleId: 'voice-1',
		speed: 1.5,
		estimate: { durationSeconds: 12, estimatedBytes: 148_096 },
	});
	assert.deepEqual(Object.keys(record!).sort(), [
		'estimate',
		'jobId',
		'language',
		'playbackSessionId',
		'speed',
		'unitCount',
		'voiceStyleId',
	]);
	assert.equal(Object.isFrozen(record), true);
	assert.equal(Object.isFrozen(record!.estimate), true);
});

test('can clear an individual prepared snapshot without exposing others', () => {
	const diagnostics = new ExportSnapshotDiagnostics();
	diagnostics.record(preparedExport());
	diagnostics.record({ ...preparedExport(), jobId: 'job-2', playbackSessionId: 'session-2' });

	diagnostics.clear('job-1');
	assert.deepEqual(diagnostics.read().map((record) => record.jobId), ['job-2']);
});
