import assert from 'node:assert/strict';
import test from 'node:test';
import {
	type RuntimeLike,
	requestPlaybackState,
	sendPlaybackCommand,
	sendRuntimeRequest,
	subscribePlaybackState,
} from '../../src/shared/playback_client.ts';

function createRuntime(responses: unknown[], runtimeErrors: Array<string | undefined> = []) {
	const sent: unknown[] = [];
	let listener: ((message: unknown) => void) | undefined;
	let removedListener: ((message: unknown) => void) | undefined;
	let activeRuntimeError: string | undefined;
	const runtime: RuntimeLike = {
		get lastError() {
			return activeRuntimeError ? { message: activeRuntimeError } : undefined;
		},
		sendMessage(message, callback) {
			sent.push(message);
			activeRuntimeError = runtimeErrors.shift();
			callback(responses.shift());
			activeRuntimeError = undefined;
		},
		onMessage: {
			addListener(value) {
				listener = value;
			},
			removeListener(value) {
				removedListener = value;
			},
		},
	};
	return { runtime, sent, getListener: () => listener, getRemovedListener: () => removedListener };
}

test('requests the current playback state', async () => {
	const fixture = createRuntime([{ session: null }]);
	assert.deepEqual(await requestPlaybackState(fixture.runtime), { session: null });
	assert.deepEqual(fixture.sent, [{ action: 'GET_PLAYBACK_STATE' }]);
});

test('returns successful generic request responses', async () => {
	const fixture = createRuntime([{ available: false }]);
	assert.deepEqual(await sendRuntimeRequest<{ available: false }>({ action: 'GET_CURRENT_PAGE_INFO' }, fixture.runtime), {
		available: false,
	});
});

test('rejects a runtime lastError read inside the callback', async () => {
	const fixture = createRuntime([{ available: false }], ['Could not establish connection']);
	await assert.rejects(sendRuntimeRequest({ action: 'GET_CURRENT_PAGE_INFO' }, fixture.runtime), /Could not establish connection/);
});

test('rejects a missing runtime response', async () => {
	const fixture = createRuntime([undefined]);
	await assert.rejects(
		sendRuntimeRequest({ action: 'GET_CURRENT_PAGE_INFO' }, fixture.runtime),
		/Extension runtime request returned no response/,
	);
});

test('rejects a null runtime response', async () => {
	const fixture = createRuntime([null]);
	await assert.rejects(
		sendRuntimeRequest({ action: 'GET_CURRENT_PAGE_INFO' }, fixture.runtime),
		/Extension runtime request returned no response/,
	);
});

test('preserves coordinator command failures', async () => {
	const fixture = createRuntime([{ success: false, error: 'failed' }]);
	assert.deepEqual(await sendPlaybackCommand({ action: 'STOP_READING' }, fixture.runtime), { success: false, error: 'failed' });
});

test('converts missing command responses into a handled transport failure', async () => {
	const fixture = createRuntime([undefined]);
	assert.deepEqual(await sendPlaybackCommand({ action: 'STOP_READING' }, fixture.runtime), {
		success: false,
		error: 'Extension runtime request returned no response.',
		transportError: true,
	});
});

test('falls back to an empty playback state on transport failure', async () => {
	const fixture = createRuntime([]);
	fixture.runtime.sendMessage = () => {
		throw new Error('Playback coordinator unavailable');
	};
	assert.deepEqual(await requestPlaybackState(fixture.runtime), { session: null });
});

test('subscribes only to playback state updates and removes the same listener', () => {
	const fixture = createRuntime([]);
	const received: unknown[] = [];
	const unsubscribe = subscribePlaybackState(fixture.runtime, (session) => received.push(session));
	fixture.getListener()?.({ action: 'PLAYBACK_STATE_UPDATE', session: null });
	fixture.getListener()?.({ action: 'MODEL_LOADED' });
	assert.deepEqual(received, [null]);
	unsubscribe();
	assert.equal(fixture.getRemovedListener(), fixture.getListener());
});
