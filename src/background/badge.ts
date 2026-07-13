import type { PlaybackStatus } from '../shared/types';

export interface BadgeAppearance {
	text: string;
	color?: string;
}

export interface BadgeAction {
	setBadgeBackgroundColor(details: { color: string }): Promise<void>;
	setBadgeText(details: { text: string }): Promise<void>;
}

export function getBadgeAppearance(status: PlaybackStatus | null): BadgeAppearance {
	switch (status) {
		case 'loading':
			return { text: '…', color: '#f59e0b' };
		case 'playing':
			return { text: '▶', color: '#10b981' };
		case 'paused':
			return { text: 'Ⅱ', color: '#f59e0b' };
		case 'error':
			return { text: '!', color: '#ef4444' };
		default:
			return { text: '' };
	}
}

export async function syncPlaybackBadge(status: PlaybackStatus | null, action: BadgeAction): Promise<void> {
	const appearance = getBadgeAppearance(status);
	if (appearance.color) {
		await action.setBadgeBackgroundColor({ color: appearance.color });
	}
	await action.setBadgeText({ text: appearance.text });
}
