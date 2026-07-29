import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateSpeechUnits, estimateSpeechUnitDurations } from '../../src/offscreen/audio_export_estimate.ts';

test('estimates whitespace languages at 160 words per minute', () => {
	assert.deepEqual(estimateSpeechUnits([{ text: 'one two three four', pauseAfterMs: null, wordMap: [] }], 'en', 1), {
		durationSeconds: 1.5,
		estimatedBytes: 22_096,
	});
});

test('estimates Chinese language tags at 240 Han characters per minute', () => {
	assert.equal(estimateSpeechUnits([{ text: '你好世界', pauseAfterMs: null, wordMap: [] }], 'zh-Hant', 1).durationSeconds, 1);
});

test('scales speech duration by playback speed', () => {
	const units = [{ text: 'one two three four five six seven eight', pauseAfterMs: null, wordMap: [] }];
	assert.equal(estimateSpeechUnits(units, 'en', 1).durationSeconds, 3);
	assert.equal(estimateSpeechUnits(units, 'en', 2).durationSeconds, 1.5);
});

test('adds planned pauses after speed-scaled speech', () => {
	const estimate = estimateSpeechUnits([{ text: 'one two three four', pauseAfterMs: 500, wordMap: [] }], 'en', 2);
	assert.equal(estimate.durationSeconds, 1.25);
});

test('adds each unit pause and returns durations that sum to the total', () => {
	const units = [
		{ text: 'one two', pauseAfterMs: 100, wordMap: [] },
		{ text: 'three four', pauseAfterMs: 200, wordMap: [] },
	];
	const durations = estimateSpeechUnitDurations(units, 'en', 1);
	const estimate = estimateSpeechUnits(units, 'en', 1);
	assert.deepEqual(durations, [0.85, 0.95]);
	assert.equal(durations.reduce((total, duration) => total + duration, 0), estimate.durationSeconds);
});

test('returns a finite empty estimate and does not cap long content', () => {
	assert.deepEqual(estimateSpeechUnits([], 'en', 1), { durationSeconds: 0, estimatedBytes: 4_096 });
	const longText = new Array<string>(20_001).fill('word').join(' ');
	const estimate = estimateSpeechUnits([{ text: longText, pauseAfterMs: null, wordMap: [] }], 'en', 1);
	assert.equal(estimate.durationSeconds, 7_500.375);
	assert.ok(Number.isFinite(estimate.durationSeconds));
	assert.ok(Number.isFinite(estimate.estimatedBytes));
});
