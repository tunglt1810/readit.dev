import assert from 'node:assert/strict';
import test from 'node:test';

import { ExportPreparationDiagnostics } from '../../src/offscreen/export_prepare_diagnostics.ts';

test('records an immutable successful export preparation snapshot marker', () => {
	const diagnostics = new ExportPreparationDiagnostics();
	diagnostics.record({
		jobId: 'job-1',
		playbackSessionId: 'session-1',
		outcome: 'prepared',
		innerError: null,
		reason: null,
		payloadKeys: ['estimate', 'jobId', 'outputFilename', 'playbackSessionId'],
	});

	const [record] = diagnostics.read('job-1');
	assert.deepEqual(record, {
		jobId: 'job-1',
		playbackSessionId: 'session-1',
		outcome: 'prepared',
		innerError: null,
		reason: null,
		payloadKeys: ['estimate', 'jobId', 'outputFilename', 'playbackSessionId'],
	});
	assert.equal(Object.isFrozen(record), true);
});

test('retains the exact inner offscreen preparation rejection reason', () => {
	const diagnostics = new ExportPreparationDiagnostics();
	diagnostics.record({
		jobId: 'job-2',
		playbackSessionId: 'session-2',
		outcome: 'rejected',
		innerError: 'An audio export is already prepared',
		reason: 'engine-prepare',
		payloadKeys: ['estimate', 'jobId', 'outputFilename', 'playbackSessionId'],
	});

	assert.deepEqual(diagnostics.read('job-2'), [
		{
			jobId: 'job-2',
			playbackSessionId: 'session-2',
			outcome: 'rejected',
			innerError: 'An audio export is already prepared',
			reason: 'engine-prepare',
			payloadKeys: ['estimate', 'jobId', 'outputFilename', 'playbackSessionId'],
		},
	]);
});
