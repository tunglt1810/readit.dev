import assert from 'node:assert/strict';
import test from 'node:test';
import { setupContextMenus } from '../../src/background/context_menu.ts';

test('setupContextMenus clears existing menus before creating sub-menus', async () => {
	const calls: { action: string; args?: unknown[] }[] = [];

	// Mock chrome.contextMenus API
	(globalThis as unknown as { chrome: unknown }).chrome = {
		contextMenus: {
			removeAll: (callback?: () => void) => {
				calls.push({ action: 'removeAll' });
				if (callback) callback();
			},
			create: (properties: Record<string, unknown>) => {
				calls.push({ action: 'create', args: [properties] });
			},
		},
	};

	await setupContextMenus();

	// Check removeAll was called first
	assert.equal(calls[0].action, 'removeAll');

	const createCalls = calls.filter((c) => c.action === 'create');
	assert.equal(createCalls.length, 8); // parent, selection, separator, add-to-queue, play-queue, replay-queue, pronunciation-separator, add-pronunciation-rule

	// Parent menu check
	const parentCall = createCalls[0].args?.[0] as Record<string, unknown>;
	assert.equal(parentCall.id, 'readit-menu');
	assert.equal(parentCall.title, 'readit');
	assert.equal(parentCall.parentId, undefined);

	// Child items check: every other item must have parentId === 'readit-menu'
	for (let i = 1; i < createCalls.length; i++) {
		const childCall = createCalls[i].args?.[0] as Record<string, unknown>;
		assert.equal(childCall.parentId, 'readit-menu', `Item ${String(childCall.id)} must have parentId 'readit-menu'`);
	}
});
