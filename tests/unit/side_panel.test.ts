import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOpenSidePanelCommand, openSidePanelForCurrentWindow } from '../../src/popup/side_panel.ts';

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

test('handleOpenSidePanelCommand invokes sidePanel.open synchronously when command is open_side_panel', () => {
	const calls: unknown[] = [];
	let calledSynchronously = false;
	const handled = handleOpenSidePanelCommand('open_side_panel', { windowId: 42 }, (options) => {
		calls.push(options);
		calledSynchronously = true;
	});

	assert.equal(handled, true);
	assert.equal(calledSynchronously, true);
	assert.deepEqual(calls, [{ windowId: 42 }]);
});

test('handleOpenSidePanelCommand ignores non open_side_panel commands or missing tab windowId', () => {
	const calls: unknown[] = [];
	const handledWrongCommand = handleOpenSidePanelCommand('other_command', { windowId: 42 }, (options) => {
		calls.push(options);
	});
	assert.equal(handledWrongCommand, false);
	assert.deepEqual(calls, []);

	const handledNoWindow = handleOpenSidePanelCommand('open_side_panel', undefined, (options) => {
		calls.push(options);
	});
	assert.equal(handledNoWindow, false);
	assert.deepEqual(calls, []);
});
