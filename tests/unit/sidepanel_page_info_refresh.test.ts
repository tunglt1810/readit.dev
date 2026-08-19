import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRefreshForActivated, shouldRefreshForUpdated } from '../../src/sidepanel/page_info_refresh.ts';

test('refreshes when another tab becomes active in the panel window', () => {
	assert.equal(shouldRefreshForActivated(3, { windowId: 3 }), true);
});

test('ignores a tab activated in a different window', () => {
	assert.equal(shouldRefreshForActivated(3, { windowId: 4 }), false);
});

test('ignores tab activations until the panel window is known', () => {
	assert.equal(shouldRefreshForActivated(null, { windowId: 3 }), false);
});

test('refreshes when the active tab of the panel window finishes loading', () => {
	assert.equal(shouldRefreshForUpdated(3, { status: 'complete' }, { active: true, windowId: 3 }), true);
});

test('ignores a load that completes in a background tab', () => {
	assert.equal(shouldRefreshForUpdated(3, { status: 'complete' }, { active: false, windowId: 3 }), false);
});

test('ignores a load that completes in a different window', () => {
	assert.equal(shouldRefreshForUpdated(3, { status: 'complete' }, { active: true, windowId: 4 }), false);
});

test('ignores intermediate load states of the active tab', () => {
	assert.equal(shouldRefreshForUpdated(3, { status: 'loading' }, { active: true, windowId: 3 }), false);
	assert.equal(shouldRefreshForUpdated(3, {}, { active: true, windowId: 3 }), false);
});

test('ignores tab updates until the panel window is known', () => {
	assert.equal(shouldRefreshForUpdated(null, { status: 'complete' }, { active: true, windowId: 3 }), false);
});
