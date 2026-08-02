import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createPendingQueueNavigation,
	isPendingQueueNavigation,
	matchesPendingQueueNavigation,
	selectNavigationTab,
} from '../../src/background/queue_navigation.ts';

const tabs = [
	{ id: 11, url: 'https://example.com/inactive', active: false },
	{ id: 12, url: 'https://example.com/active', active: true },
	{ id: 13, url: 'chrome://settings', active: false },
];

test('selectNavigationTab prefers the active web tab over tab order', () => {
	assert.equal(selectNavigationTab(tabs), 12);
});

test('selectNavigationTab honors a valid preferred tab', () => {
	assert.equal(selectNavigationTab(tabs, 11), 11);
	assert.equal(selectNavigationTab(tabs, 13), 12);
});

test('selectNavigationTab keeps an active tab when its URL is hidden by browser permissions', () => {
	assert.equal(
		selectNavigationTab([
			{ id: 21, active: true },
			{ id: 22, url: 'https://example.com/inactive', active: false },
		]),
		21,
	);
});

test('selectNavigationTab honors a preferred tab when its URL is hidden by browser permissions', () => {
	assert.equal(
		selectNavigationTab([
			{ id: 21, url: undefined, active: false },
			{ id: 22, url: 'https://example.com/active', active: true },
		], 21),
		21,
	);
});

test('pending navigation matches the exact normalized URL and tab', () => {
	const pending = createPendingQueueNavigation('item-1', 12, 'https://example.com/article?part=2#section');

	assert.deepEqual(pending, {
		itemId: 'item-1',
		tabId: 12,
		expectedUrl: 'https://example.com/article?part=2',
	});
	assert.equal(matchesPendingQueueNavigation(pending, 12, 'https://example.com/article?part=2#other'), true);
	assert.equal(matchesPendingQueueNavigation(pending, 12, 'https://example.com/article?part=3'), false);
	assert.equal(matchesPendingQueueNavigation(pending, 11, 'https://example.com/article?part=2'), false);
});

test('isPendingQueueNavigation rejects malformed persisted state', () => {
	assert.equal(isPendingQueueNavigation({ itemId: 'item-1', tabId: 12, expectedUrl: 'https://example.com/a' }), true);
	assert.equal(isPendingQueueNavigation({ itemId: 'item-1', tabId: 12, expectedUrl: 'not a url' }), false);
	assert.equal(isPendingQueueNavigation({ itemId: 'item-1', tabId: '12', expectedUrl: 'https://example.com/a' }), false);
});
