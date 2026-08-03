import assert from 'node:assert/strict';
import test from 'node:test';
import { openSidebarOrPanel } from '../../src/shared/browser.ts';

test('opens the Firefox sidebar when sidebarAction is available', async () => {
	let opened = false;

	await openSidebarOrPanel(undefined, {
		sidebarAction: {
			open: async () => {
				opened = true;
			},
		},
	});

	assert.equal(opened, true);
});

test('falls back to the Chrome side panel with the target window ID', async () => {
	let openedWith: { windowId?: number } | undefined;

	await openSidebarOrPanel(42, {
		sidePanel: {
			open: async (options) => {
				openedWith = options;
			},
		},
	});

	assert.deepEqual(openedWith, { windowId: 42 });
});

test('rejects when neither sidebar nor side panel API is available', async () => {
	await assert.rejects(openSidebarOrPanel(undefined, {}), /sidebar or side panel API/);
});
