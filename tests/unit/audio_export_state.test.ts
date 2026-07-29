import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAudioExportProgress, createAudioExportJob, transitionAudioExportJob } from '../../src/background/audio_export_state.ts';

function job() {
	return createAudioExportJob({
		jobId: 'job-1',
		playbackSessionId: 'session-1',
		title: 'An article',
		outputFilename: 'an-article.mp3',
		estimate: { durationSeconds: 60, estimatedBytes: 724_096 },
		now: 1_000,
	});
}

test('allows only the one-job export state transitions', () => {
	const preparing = job();
	const exporting = transitionAudioExportJob(preparing, 'exporting', 2_000);
	const waiting = transitionAudioExportJob(exporting, 'waiting-for-playback', 3_000);
	const resumed = transitionAudioExportJob(waiting, 'exporting', 4_000);
	const completed = transitionAudioExportJob(resumed, 'completed', 5_000);

	assert.equal(exporting?.state, 'exporting');
	assert.equal(waiting?.state, 'waiting-for-playback');
	assert.equal(resumed?.state, 'exporting');
	assert.equal(completed?.state, 'completed');
	assert.equal(transitionAudioExportJob(preparing, 'completed', 2_000), null);
	assert.equal(transitionAudioExportJob(completed, 'exporting', 6_000), null);
});

test('rejects stale jobs, regressions, and invalid progress metadata', () => {
	const exporting = transitionAudioExportJob(job(), 'exporting', 2_000);
	assert.ok(exporting);
	assert.equal(
		applyAudioExportProgress(exporting, {
			jobId: 'stale-job',
			state: 'exporting',
			processedDurationSeconds: 10,
			progressPercentage: 10,
			bytesWritten: 1_000,
		}),
		null,
	);
	assert.equal(
		applyAudioExportProgress(exporting, {
			jobId: exporting.jobId,
			state: 'exporting',
			processedDurationSeconds: -1,
			progressPercentage: 10,
			bytesWritten: 1_000,
		}),
		null,
	);

	const progressed = applyAudioExportProgress(exporting, {
		jobId: exporting.jobId,
		state: 'exporting',
		processedDurationSeconds: 10,
		progressPercentage: 10,
		bytesWritten: 1_000,
		etaSeconds: 50,
	});
	assert.ok(progressed);
	assert.equal(
		applyAudioExportProgress(progressed, {
			jobId: progressed.jobId,
			state: 'exporting',
			processedDurationSeconds: 9,
			progressPercentage: 9,
			bytesWritten: 999,
		}),
		null,
	);
});

test('does not mutate a terminal export from a late progress event', () => {
	const exporting = transitionAudioExportJob(job(), 'exporting', 2_000);
	assert.ok(exporting);
	const completed = transitionAudioExportJob(exporting, 'completed', 3_000);
	assert.ok(completed);
	assert.equal(
		applyAudioExportProgress(completed, {
			jobId: completed.jobId,
			state: 'completed',
			processedDurationSeconds: 60,
			progressPercentage: 100,
			bytesWritten: 7_200,
		}),
		null,
	);
});
