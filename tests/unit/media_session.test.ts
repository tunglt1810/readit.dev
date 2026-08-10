import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaSessionController, type MediaSessionLike, toMediaSessionPlaybackState } from '../../src/offscreen/media_session.ts';

type PositionCall = { duration: number; position: number; playbackRate: number } | 'reset';

type FakeSession = MediaSessionLike & {
	handlers: Map<string, (() => void) | null>;
	failOn: Set<string>;
	positionCalls: PositionCall[];
	failPositionState: boolean;
};

function createFakeSession(failOn: string[] = []): FakeSession {
	return {
		metadata: undefined,
		playbackState: 'none',
		handlers: new Map(),
		failOn: new Set(failOn),
		positionCalls: [],
		failPositionState: false,
		setActionHandler(action: string, handler: (() => void) | null) {
			if (this.failOn.has(action)) {
				throw new DOMException(`unsupported: ${action}`, 'NotSupportedError');
			}
			this.handlers.set(action, handler);
		},
		setPositionState(state?: { duration: number; position: number; playbackRate: number }) {
			if (this.failPositionState) {
				throw new TypeError('bad position state');
			}
			this.positionCalls.push(state ? { ...state } : 'reset');
		},
	} as FakeSession;
}

const createMetadata = (init: unknown) => init;

function noopHandlers() {
	return { play: () => {}, pause: () => {}, stop: () => {} };
}

test('playing maps to playing', () => {
	assert.equal(toMediaSessionPlaybackState('playing'), 'playing');
});

test('loading maps to playing, not none', () => {
	// `reportProgress('loading')` runs at every paragraph boundary (playNextUnit,
	// offscreen.ts). Mapping it to 'none' made playbackState flip
	// playing -> none -> playing for the whole session, which reads to the OS as
	// "nothing to control". A reading session that is synthesising the next unit
	// is still playing.
	assert.equal(toMediaSessionPlaybackState('loading'), 'playing');
});

test('paused maps to paused', () => {
	assert.equal(toMediaSessionPlaybackState('paused'), 'paused');
});

test('stopped maps to none', () => {
	assert.equal(toMediaSessionPlaybackState('stopped'), 'none');
});

test('error maps to none', () => {
	assert.equal(toMediaSessionPlaybackState('error'), 'none');
});

test('sync writes the mapped state onto the session', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.sync('playing');
	assert.equal(session.playbackState, 'playing');
	controller.sync('paused');
	assert.equal(session.playbackState, 'paused');
	controller.sync('stopped');
	assert.equal(session.playbackState, 'none');
});

test('setMetadata carries title, artist and a fixed album', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.setMetadata({ title: 'Bài X', artist: 'vnexpress.net' });

	assert.deepEqual(session.metadata, { title: 'Bài X', artist: 'vnexpress.net', album: 'readit.dev' });
});

test('setMetadata with nothing clears the tile', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.setMetadata({ title: 'Bài X', artist: 'vnexpress.net' });
	controller.setMetadata(undefined);

	assert.equal(session.metadata, null);
});

test('clear drops the metadata so no stale tile survives a stop', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.setMetadata({ title: 'Bài X', artist: 'vnexpress.net' });
	controller.clear();

	assert.equal(session.metadata, null);
});

test('install registers play, pause and stop and routes each to its callback', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);
	const calls: string[] = [];

	controller.install({
		play: () => calls.push('play'),
		pause: () => calls.push('pause'),
		stop: () => calls.push('stop'),
	});

	for (const action of ['play', 'pause', 'stop']) {
		const handler = session.handlers.get(action);
		assert.equal(typeof handler, 'function', `${action} should be registered`);
		handler?.();
	}

	assert.deepEqual(calls, ['play', 'pause', 'stop']);
});

test('an action Chrome refuses does not block the remaining actions', () => {
	// Chrome throws NotSupportedError for actions a given version does not handle.
	// A single throw must not abort install(), or one unsupported action silently
	// costs every other control. This only shows up on a different Chrome build,
	// so clicking around locally can never catch it.
	const session = createFakeSession(['pause']);
	const controller = createMediaSessionController(session, createMetadata);

	assert.doesNotThrow(() => controller.install(noopHandlers()));

	assert.equal(typeof session.handlers.get('play'), 'function');
	assert.equal(typeof session.handlers.get('stop'), 'function');
	assert.equal(session.handlers.has('pause'), false);
});

test('setNextTrack registers a handler and null removes the button', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);
	let skipped = 0;

	controller.setNextTrack(() => {
		skipped++;
	});
	session.handlers.get('nexttrack')?.();
	assert.equal(skipped, 1);

	controller.setNextTrack(null);
	// Registered as null rather than left alone: the OS keeps showing a next
	// button until the handler is explicitly cleared.
	assert.equal(session.handlers.has('nexttrack'), true);
	assert.equal(session.handlers.get('nexttrack'), null);
});

test('setPosition reports duration, position and rate', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.setPosition({ duration: 600, position: 42, playbackRate: 1.5 });

	assert.deepEqual(session.positionCalls, [{ duration: 600, position: 42, playbackRate: 1.5 }]);
});

test('a position past the duration is clamped rather than thrown', () => {
	// The duration is an estimate over unsynthesised units, so real playback can run
	// past it. setPositionState throws a TypeError on position > duration, which would
	// take out the tile the position state exists to support.
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.setPosition({ duration: 100, position: 137, playbackRate: 1 });

	assert.deepEqual(session.positionCalls, [{ duration: 100, position: 100, playbackRate: 1 }]);
});

test('a non-positive duration is skipped instead of reported', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.setPosition({ duration: 0, position: 0, playbackRate: 1 });

	assert.deepEqual(session.positionCalls, []);
});

test('setPosition(null) resets the position state', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.setPosition(null);

	assert.deepEqual(session.positionCalls, ['reset']);
});

test('a rejected position state does not break playback reporting', () => {
	const session = createFakeSession();
	session.failPositionState = true;
	const controller = createMediaSessionController(session, createMetadata);

	assert.doesNotThrow(() => controller.setPosition({ duration: 10, position: 1, playbackRate: 1 }));
	assert.equal(controller.getDebugState().positionStateError !== null, true);
});

test('a browser without setPositionState is tolerated', () => {
	const session = createFakeSession();
	(session as { setPositionState?: unknown }).setPositionState = undefined;
	const controller = createMediaSessionController(session, createMetadata);

	assert.doesNotThrow(() => controller.setPosition({ duration: 10, position: 1, playbackRate: 1 }));
});

test('no seek or previous-track actions are registered', () => {
	const session = createFakeSession();
	const controller = createMediaSessionController(session, createMetadata);

	controller.install(noopHandlers());
	controller.setNextTrack(() => {});

	for (const action of ['previoustrack', 'seekto', 'seekbackward', 'seekforward']) {
		assert.equal(session.handlers.has(action), false, `${action} must not be registered`);
	}
});
