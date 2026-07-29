import assert from 'node:assert/strict';
import test from 'node:test';
import { canStartBackgroundSynthesis } from '../../src/offscreen/audio_export_runway.ts';

const playingRunway = {
	active: true,
	status: 'playing' as const,
	currentRemainingSeconds: 2,
	nextBufferSeconds: 2,
	recentSynthesisMilliseconds: [500],
};

test('allows background synthesis with no active playback', () => {
	assert.equal(canStartBackgroundSynthesis({ ...playingRunway, active: false, status: 'stopped', nextBufferSeconds: null }), true);
});

test('blocks background synthesis for active non-playing states', () => {
	for (const status of ['loading', 'paused', 'error', 'stopped'] as const) {
		assert.equal(canStartBackgroundSynthesis({ ...playingRunway, status }), false);
	}
});

test('blocks when the next foreground buffer is unresolved', () => {
	assert.equal(canStartBackgroundSynthesis({ ...playingRunway, nextBufferSeconds: null }), false);
});

test('requires runway to strictly exceed the latest-five synthesis maximum plus 250 milliseconds', () => {
	const recentSynthesisMilliseconds = [9_999, 500, 750, 1_000, 1_250, 1_500];
	assert.equal(
		canStartBackgroundSynthesis({ ...playingRunway, currentRemainingSeconds: 1, nextBufferSeconds: 0.75, recentSynthesisMilliseconds }),
		false,
	);
	assert.equal(
		canStartBackgroundSynthesis({ ...playingRunway, currentRemainingSeconds: 1, nextBufferSeconds: 0.751, recentSynthesisMilliseconds }),
		true,
	);
});
