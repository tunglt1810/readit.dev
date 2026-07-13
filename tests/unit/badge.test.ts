import assert from 'node:assert/strict';
import test from 'node:test';
import { getBadgeAppearance, syncPlaybackBadge } from '../../src/background/badge.ts';

test('maps every playback state to the specified badge', () => {
	assert.deepEqual(getBadgeAppearance('loading'), { text: '…', color: '#f59e0b' });
	assert.deepEqual(getBadgeAppearance('playing'), { text: '▶', color: '#10b981' });
	assert.deepEqual(getBadgeAppearance('paused'), { text: 'Ⅱ', color: '#f59e0b' });
	assert.deepEqual(getBadgeAppearance('error'), { text: '!', color: '#ef4444' });
	assert.deepEqual(getBadgeAppearance('stopped'), { text: '' });
	assert.deepEqual(getBadgeAppearance(null), { text: '' });
});

test('awaits background color before showing badge text', async () => {
	const calls: string[] = [];
	await syncPlaybackBadge('playing', {
		setBadgeBackgroundColor: async ({ color }) => {
			calls.push(`color:${color}`);
		},
		setBadgeText: async ({ text }) => {
			calls.push(`text:${text}`);
		},
	});
	assert.deepEqual(calls, ['color:#10b981', 'text:▶']);
});

test('clears text without applying a color', async () => {
	const calls: string[] = [];
	await syncPlaybackBadge(null, {
		setBadgeBackgroundColor: async () => {
			calls.push('color');
		},
		setBadgeText: async ({ text }) => {
			calls.push(`text:${text}`);
		},
	});
	assert.deepEqual(calls, ['text:']);
});
