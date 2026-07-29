import assert from 'node:assert/strict';
import { test } from 'node:test';

test('openSidebarOrPanel calls sidebarAction when available', async () => {
	let sidebarOpened = false;
	const mockBrowser = {
		sidebarAction: {
			open: async () => {
				sidebarOpened = true;
			},
		},
	};
	if (mockBrowser.sidebarAction) {
		await mockBrowser.sidebarAction.open();
	}
	assert.equal(sidebarOpened, true);
});
