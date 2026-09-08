import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEdgeFailure } from '../../src/offscreen/edge/edge_failure.ts';
import { EdgeUnsupportedLanguageError } from '../../src/offscreen/edge/edge_provider.ts';
import { EdgeSocketError } from '../../src/offscreen/edge/edge_socket.ts';

// 1007 is the endpoint's answer to SSML it will never accept, so retrying only burns the
// starvation budget that a genuinely transient drop needs.
test('treats a 1007 close as deterministic', () => {
	assert.equal(classifyEdgeFailure(new EdgeSocketError('connection closed', 1007)), 'deterministic');
});

test('treats an unsupported language as deterministic', () => {
	assert.equal(classifyEdgeFailure(new EdgeUnsupportedLanguageError('na')), 'deterministic');
});

test('treats an abnormal 1006 close as transient', () => {
	assert.equal(classifyEdgeFailure(new EdgeSocketError('connection closed', 1006)), 'transient');
});

test('treats a timeout with no close code as transient', () => {
	assert.equal(classifyEdgeFailure(new EdgeSocketError('synthesis request timed out')), 'transient');
});

test('treats a non-edge error as foreign', () => {
	assert.equal(classifyEdgeFailure(new Error('decodeAudioData failed')), 'foreign');
});
