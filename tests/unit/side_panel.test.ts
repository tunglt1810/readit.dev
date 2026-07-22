import assert from 'node:assert/strict';
import test from 'node:test';
import { openSidePanelForCurrentWindow } from '../../src/popup/side_panel.ts';

test('opens the Side Panel immediately with the pre-resolved window ID', async () => {
	const calls: unknown[] = [];
	const result = openSidePanelForCurrentWindow({
		windowId: 9,
		open: async (options) => calls.push(options),
	});
	assert.deepEqual(calls, [{ windowId: 9 }]);
	await result;
});

test('rejects without opening when the current window cannot be resolved', async () => {
	let openCalled = false;
	await assert.rejects(
		openSidePanelForCurrentWindow({
			windowId: undefined,
			open: async () => {
				openCalled = true;
			},
		}),
		/current window/,
	);
	assert.equal(openCalled, false);
});

test('propagates the Chrome Side Panel rejection', async () => {
	const error = new Error('Side Panel unavailable');
	await assert.rejects(
		openSidePanelForCurrentWindow({
			windowId: 9,
			open: async () => {
				throw error;
			},
		}),
		error,
	);
});
