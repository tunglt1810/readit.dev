import assert from 'node:assert/strict';
import test from 'node:test';
import { registerModelCacheWarmLifecycle } from '../../src/background/model_cache_lifecycle.ts';

function createFakeEvent() {
	const listeners: Array<() => void> = [];
	return {
		addListener(fn: () => void) {
			listeners.push(fn);
		},
		emit() {
			for (const listener of listeners) {
				listener();
			}
		},
	};
}

test('registers listeners on onInstalled and onStartup to trigger warm', async () => {
	const onInstalled = createFakeEvent();
	const onStartup = createFakeEvent();
	let warmCalls = 0;

	registerModelCacheWarmLifecycle(
		{ onInstalled, onStartup },
		() => {
			warmCalls++;
		},
	);

	onInstalled.emit();
	assert.equal(warmCalls, 1);

	onStartup.emit();
	assert.equal(warmCalls, 2);
});

test('verifies chrome.runtime onInstalled and onStartup bind model cache warm listeners', async () => {
	const installedListeners: Array<() => void> = [];
	const startupListeners: Array<() => void> = [];

	const fakeChrome = {
		runtime: {
			onInstalled: {
				addListener(fn: () => void) {
					installedListeners.push(fn);
				},
			},
			onStartup: {
				addListener(fn: () => void) {
					startupListeners.push(fn);
				},
			},
		},
	};

	let warmTriggered = 0;
	registerModelCacheWarmLifecycle(
		fakeChrome.runtime,
		() => {
			warmTriggered++;
		},
	);

	assert.equal(installedListeners.length, 1);
	assert.equal(startupListeners.length, 1);

	installedListeners[0]();
	assert.equal(warmTriggered, 1);

	startupListeners[0]();
	assert.equal(warmTriggered, 2);
});
