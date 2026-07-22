import assert from 'node:assert/strict';
import test from 'node:test';
import { captureManualCheckpoint, isCheckpointOwner, resumeOffsetSeconds } from '../../src/offscreen/manual_checkpoint.ts';

const panelInstanceId = 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd';

test('captures a manual checkpoint at the current buffer offset for its owner', () => {
	const checkpoint = captureManualCheckpoint({
		sessionId: 'manual-1',
		panelInstanceId,
		unitIndex: 2,
		bufferDurationSec: 4,
		elapsedSec: 1.25,
		wordIndex: 11,
	});
	assert.equal(checkpoint.sourceOffsetSec, 1.25);
	assert.equal(checkpoint.wordIndex, 11);
	assert.equal(isCheckpointOwner(checkpoint, panelInstanceId), true);
	assert.equal(isCheckpointOwner(checkpoint, 'c45b5fc4-7d8a-4ab6-866d-53f17b29799d'), false);
});

test('clamps checkpoint offsets to the decoded buffer duration', () => {
	assert.equal(resumeOffsetSeconds({ bufferDurationSec: 2, elapsedSec: 5 }), 2);
	assert.equal(resumeOffsetSeconds({ bufferDurationSec: 2, elapsedSec: -1 }), 0);
});
