import { t } from '../shared/i18n.ts';

export function setupContextMenus(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof chrome === 'undefined' || !chrome.contextMenus) {
			resolve();
			return;
		}

		chrome.contextMenus.removeAll(() => {
			// Parent menu
			chrome.contextMenus.create({
				id: 'readit-menu',
				title: 'readit',
				contexts: ['page', 'selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			// Read selected text
			chrome.contextMenus.create({
				id: 'readit-read-selection',
				parentId: 'readit-menu',
				title: t('contextMenuReadSelection'),
				contexts: ['selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			// Separator
			chrome.contextMenus.create({
				id: 'readit-separator',
				parentId: 'readit-menu',
				type: 'separator',
				contexts: ['page', 'selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			// Add page to queue
			chrome.contextMenus.create({
				id: 'readit-add-to-queue',
				parentId: 'readit-menu',
				title: t('contextMenuAddToQueue'),
				contexts: ['page', 'selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			// Play queue
			chrome.contextMenus.create({
				id: 'readit-play-queue',
				parentId: 'readit-menu',
				title: t('contextMenuPlayQueue'),
				contexts: ['page', 'selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			// Replay queue
			chrome.contextMenus.create({
				id: 'readit-replay-queue',
				parentId: 'readit-menu',
				title: t('contextMenuReplayQueue'),
				contexts: ['page', 'selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			// Separator before pronunciation
			chrome.contextMenus.create({
				id: 'readit-pronunciation-separator',
				parentId: 'readit-menu',
				type: 'separator',
				contexts: ['selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			// Add pronunciation rule
			chrome.contextMenus.create({
				id: 'readit-add-pronunciation-rule',
				parentId: 'readit-menu',
				title: t('contextMenuAddRule'),
				contexts: ['selection'],
				documentUrlPatterns: ['http://*/*', 'https://*/*'],
			});

			resolve();
		});
	});
}
