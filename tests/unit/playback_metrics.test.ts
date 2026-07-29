import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeUnitSequence, median, PlaybackMetricsRecorder, summarizePlaybackMetrics } from '../../src/offscreen/playback_metrics.ts';

function closeTo(actual: number, expected: number, tolerance = 1e-6): void {
	assert.ok(Math.abs(actual - expected) < tolerance, `expected ~${expected}, got ${actual}`);
}

describe('median', () => {
	it('returns null for an empty sample set', () => {
		assert.equal(median([]), null);
	});

	it('returns the middle value for an odd count', () => {
		assert.equal(median([5, 1, 3]), 3);
	});

	it('averages the two middle values for an even count', () => {
		assert.equal(median([4, 1, 3, 2]), 2.5);
	});
});

describe('PlaybackMetricsRecorder gap measurement', () => {
	it('records no gap for the first unit', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.recordUnitStart(0, 10, 1_000, 2);
		assert.deepEqual(recorder.snapshot().gaps, []);
	});

	it('measures silence against when the audio was due to end, not when the callback ran', () => {
		const recorder = new PlaybackMetricsRecorder();
		// Unit 0 starts at t=10 and is 2s long, so its audio runs out at t=12.
		recorder.recordUnitStart(0, 10, 1_000, 2);
		// The onended callback runs late, at t=12.5 — this must not affect the gap.
		recorder.recordUnitEnded(12.5);
		// Unit 1 actually starts at t=12.58, so there was 580ms of silence.
		recorder.recordUnitStart(1, 12.58, 1_100, 3);

		const [gap] = recorder.snapshot().gaps;
		assert.equal(gap.unitIndex, 1);
		closeTo(gap.gapMs, 580);
	});

	it('reports a seamless transition as zero', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.recordUnitStart(0, 10, 1_000, 2);
		recorder.recordUnitStart(1, 12, 1_100, 2);

		closeTo(recorder.snapshot().gaps[0].gapMs, 0);
	});

	it('accounts for a resume offset when computing the due end time', () => {
		const recorder = new PlaybackMetricsRecorder();
		// A 5s buffer resumed 3s in has only 2s left, so it is due to end at t=12.
		recorder.recordUnitStart(0, 10, 1_000, 5, 3);
		recorder.recordUnitStart(1, 12, 1_100, 2);

		closeTo(recorder.snapshot().gaps[0].gapMs, 0);
	});

	it('does not attribute a gap to a stop or pause', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.recordUnitStart(0, 10, 1_000, 2);
		recorder.discardPendingTransition();
		recorder.recordUnitStart(1, 30, 1_100, 2);

		assert.deepEqual(recorder.snapshot().gaps, []);
	});
});

describe('PlaybackMetricsRecorder callback lateness', () => {
	it('measures how late onended ran relative to the due end time', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.recordUnitStart(0, 10, 1_000, 2);
		recorder.recordUnitEnded(12.3);

		closeTo(recorder.snapshot().callbackLatenessMs[0], 300);
	});

	it('records nothing when there is no unit in flight', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.recordUnitEnded(12.3);

		assert.deepEqual(recorder.snapshot().callbackLatenessMs, []);
	});
});

describe('PlaybackMetricsRecorder time to first audio', () => {
	it('measures from the play request to the first unit start only', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.markPlayRequested(1_000);
		recorder.recordUnitStart(0, 10, 1_420, 2);
		recorder.recordUnitStart(1, 12, 3_000, 2);

		assert.equal(recorder.snapshot().timeToFirstAudioMs, 420);
	});

	it('stays null when playback never starts', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.markPlayRequested(1_000);
		assert.equal(recorder.snapshot().timeToFirstAudioMs, null);
	});
});

describe('PlaybackMetricsRecorder highlight drift', () => {
	it('reports drift against the 50ms interval, skipping the first tick', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.beginHighlightTracking();
		recorder.recordHighlightTick(1_000);
		recorder.recordHighlightTick(1_050);
		recorder.recordHighlightTick(1_180);

		assert.deepEqual(recorder.snapshot().highlightDriftsMs, [0, 80]);
	});
});

describe('PlaybackMetricsRecorder run boundaries', () => {
	it('clears the previous run when a new play is requested', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.markPlayRequested(1_000);
		recorder.recordUnitStart(0, 10, 1_100, 2);
		recorder.recordUnitStart(1, 12.1, 1_200, 2);
		recorder.recordSynthDuration(500);

		recorder.markPlayRequested(9_000);

		const snapshot = recorder.snapshot();
		assert.deepEqual(snapshot.gaps, []);
		assert.deepEqual(snapshot.synthDurationsMs, []);
		assert.deepEqual(snapshot.audioDurationsSec, []);
		assert.equal(snapshot.timeToFirstAudioMs, null);
	});

	it('accumulates across flushes within one run', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.markPlayRequested(1_000);
		recorder.recordUnitStart(0, 10, 1_100, 2);
		recorder.recordUnitStart(1, 12, 1_200, 2);
		recorder.recordUnitStart(2, 14, 1_300, 2);

		assert.equal(recorder.snapshot().gaps.length, 2);
		assert.equal(recorder.snapshot().timeToFirstAudioMs, 100);
	});

	it('keeps the execution provider across runs', () => {
		const recorder = new PlaybackMetricsRecorder();
		recorder.recordExecutionProvider('webgpu');
		recorder.markPlayRequested(1_000);
		assert.equal(recorder.snapshot().executionProvider, 'webgpu');
	});
});

describe('summarizePlaybackMetrics', () => {
	it('counts only gaps above the 50ms threshold', () => {
		const summary = summarizePlaybackMetrics({
			executionProvider: 'webgpu',
			timeToFirstAudioMs: 900,
			totalUnits: 4,
			unitSequence: [0, 1, 2, 3],
			droppedStarts: [],
			synthErrors: [],
			gaps: [
				{ unitIndex: 1, gapMs: 12 },
				{ unitIndex: 2, gapMs: 51 },
				{ unitIndex: 3, gapMs: 240 },
			],
			callbackLatenessMs: [10, 300],
			synthDurationsMs: [1_000, 3_000],
			inferDurationsMs: [800, 2_400],
			audioDurationsSec: [2, 4],
			highlightDriftsMs: [2, 45],
		});

		assert.equal(summary.transitions, 3);
		assert.equal(summary.gapsOverThreshold, 2);
		assert.equal(summary.gapMedianMs, 51);
		assert.equal(summary.gapMaxMs, 240);
		assert.equal(summary.callbackLatenessMaxMs, 300);
		assert.equal(summary.synthMedianMs, 2_000);
		assert.equal(summary.inferMedianMs, 1_600);
		assert.equal(summary.audioMedianSec, 3);
		assert.equal(summary.highlightDriftMaxMs, 45);
		assert.equal(summary.executionProvider, 'webgpu');
	});

	it('reports the synthesis-to-audio ratio, the signal that decides whether buffering can help', () => {
		const summary = summarizePlaybackMetrics({
			executionProvider: 'webgpu',
			timeToFirstAudioMs: null,
			totalUnits: null,
			unitSequence: [],
			droppedStarts: [],
			synthErrors: [],
			gaps: [],
			callbackLatenessMs: [],
			// 7s of synthesis to produce 3.5s of audio: synthesis cannot keep up.
			synthDurationsMs: [7_000],
			inferDurationsMs: [],
			audioDurationsSec: [3.5],
			highlightDriftsMs: [],
		});

		assert.equal(summary.synthToAudioRatio, 2);
	});

	it('reports nulls rather than zeros when nothing was sampled', () => {
		const summary = summarizePlaybackMetrics({
			executionProvider: null,
			timeToFirstAudioMs: null,
			totalUnits: null,
			unitSequence: [],
			droppedStarts: [],
			synthErrors: [],
			gaps: [],
			callbackLatenessMs: [],
			synthDurationsMs: [],
			inferDurationsMs: [],
			audioDurationsSec: [],
			highlightDriftsMs: [],
		});

		assert.equal(summary.transitions, 0);
		assert.equal(summary.gapMedianMs, null);
		assert.equal(summary.synthToAudioRatio, null);
		assert.equal(summary.highlightDriftMaxMs, null);
	});
});

describe('analyzeUnitSequence', () => {
	it('finds no problem in a clean run', () => {
		assert.deepEqual(analyzeUnitSequence([0, 1, 2, 3], 4), { skippedUnits: [], repeatedUnits: [] });
	});

	it('reports a unit that never played as skipped', () => {
		// Unit 2 is missing while 3 has already played, so it was passed over, not merely pending.
		assert.deepEqual(analyzeUnitSequence([0, 1, 3], 4), { skippedUnits: [2], repeatedUnits: [] });
	});

	it('reports a unit that played twice as repeated', () => {
		assert.deepEqual(analyzeUnitSequence([0, 1, 1, 2], 4), { skippedUnits: [], repeatedUnits: [1] });
	});

	it('does not treat units after the furthest reached as skipped', () => {
		// Playback is only three units in; units 3..9 have simply not been reached yet.
		assert.deepEqual(analyzeUnitSequence([0, 1, 2], 10), { skippedUnits: [], repeatedUnits: [] });
	});

	it('reports skips and repeats together', () => {
		assert.deepEqual(analyzeUnitSequence([0, 2, 2, 4], 6), { skippedUnits: [1, 3], repeatedUnits: [2] });
	});

	it('cannot report skips without knowing the unit count', () => {
		assert.deepEqual(analyzeUnitSequence([0, 3], null), { skippedUnits: [], repeatedUnits: [] });
	});
});
