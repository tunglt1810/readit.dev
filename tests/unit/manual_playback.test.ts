import assert from 'node:assert/strict';
import test from 'node:test';
import { isManualPlaybackControlMessage, isManualWordTimingMessage, isPanelInstanceId } from '../../src/shared/manual_playback.ts';

const panelInstanceId = 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd';

test('accepts only UUID-shaped Side Panel owner IDs', () => {
	assert.equal(isPanelInstanceId(panelInstanceId), true);
	assert.equal(isPanelInstanceId('not-an-owner'), false);
});

test('rejects a manual control message without an owner ID', () => {
	assert.equal(isManualPlaybackControlMessage({ action: 'RESUME_MANUAL_CHECKPOINT' }), false);
	assert.equal(isManualPlaybackControlMessage({ action: 'RESUME_MANUAL_CHECKPOINT', panelInstanceId }), true);
});

test('accepts only valid internal offscreen manual-word timing messages', () => {
	assert.equal(
		isManualWordTimingMessage({
			action: 'OFFSCREEN_MANUAL_WORD_TIMING',
			sessionId: 'manual-session',
			word: 'cat',
			wordIndex: 1,
		}),
		true,
	);
	assert.equal(
		isManualWordTimingMessage({
			action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
			sessionId: 'manual-session',
			word: 'cat',
			wordIndex: 1,
		}),
		false,
	);
	assert.equal(
		isManualWordTimingMessage({
			action: 'OFFSCREEN_MANUAL_WORD_TIMING',
			sessionId: 'manual-session',
			word: 'cat',
			wordIndex: -1,
		}),
		false,
	);
});
