import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildReadableSurfaceWords,
	isReadableSurfaceClearMessage,
	isReadableSurfaceInitMessage,
	isReadableSurfaceUpdateMessage,
} from '../../src/shared/readable_surface.ts';

test('flattens word maps into contiguous source-equivalent indexes', () => {
	assert.deepEqual(buildReadableSurfaceWords([{ wordMap: [{ text: 'rất' }, { text: 'rất' }] }, { wordMap: [{ text: 'nhiều' }] }]), [
		{ text: 'rất', globalIndex: 0 },
		{ text: 'rất', globalIndex: 1 },
		{ text: 'nhiều', globalIndex: 2 },
	]);
});

test('validates canonical initialize messages for every playback scope', () => {
	for (const contentScope of ['article', 'selection', 'manual']) {
		assert.equal(
			isReadableSurfaceInitMessage({
				action: 'READABLE_SURFACE_INIT',
				sessionId: 'session-1',
				contentScope,
				words: [{ text: 'First', globalIndex: 0 }],
			}),
			true,
		);
	}
	assert.equal(
		isReadableSurfaceInitMessage({
			action: 'READABLE_SURFACE_INIT',
			sessionId: 'session-1',
			contentScope: 'article',
			words: [{ text: 'First', globalIndex: 1 }],
		}),
		false,
	);
	assert.equal(
		isReadableSurfaceInitMessage({
			action: 'READABLE_SURFACE_INIT',
			sessionId: 'session-1',
			contentScope: 'article',
			words: [{ text: '', globalIndex: 0 }],
		}),
		false,
	);
});

test('validates canonical update and clear messages', () => {
	assert.equal(
		isReadableSurfaceUpdateMessage({
			action: 'READABLE_SURFACE_UPDATE',
			sessionId: 'session-1',
			wordIndex: 0,
			word: 'First',
		}),
		true,
	);
	assert.equal(
		isReadableSurfaceUpdateMessage({
			action: 'READABLE_SURFACE_UPDATE',
			sessionId: 'session-1',
			wordIndex: -1,
			word: 'First',
		}),
		false,
	);
	assert.equal(
		isReadableSurfaceUpdateMessage({
			action: 'READABLE_SURFACE_UPDATE',
			sessionId: 'session-1',
			wordIndex: 0,
			word: '',
		}),
		false,
	);
	assert.equal(isReadableSurfaceClearMessage({ action: 'READABLE_SURFACE_CLEAR', sessionId: 'session-1' }), true);
	assert.equal(isReadableSurfaceClearMessage({ action: 'READABLE_SURFACE_CLEAR', sessionId: '' }), false);
});
