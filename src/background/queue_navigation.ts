import { normalizeQueueUrl } from './playlist_queue.ts';
import type { PendingQueueNavigation } from '../shared/types.ts';

export interface NavigationTab {
	id?: number;
	url?: string;
	active?: boolean;
}

function isWebOrFileUrl(url: string | undefined): boolean {
	if (typeof url !== 'string') {
		return false;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:';
	} catch {
		return false;
	}
}

function isSelectableTab(tab: NavigationTab): tab is NavigationTab & { id: number } {
	return Number.isInteger(tab.id) && isWebOrFileUrl(tab.url);
}

export function selectNavigationTab(tabs: readonly NavigationTab[], preferredTabId?: number): number | undefined {
	if (typeof preferredTabId === 'number') {
		const preferred = tabs.find(
			(tab) => tab.id === preferredTabId && (isSelectableTab(tab) || (Number.isInteger(tab.id) && tab.url === undefined)),
		);
		if (preferred?.id !== undefined) {
			return preferred.id;
		}
	}

	const activeTab = tabs.find((tab) => tab.active === true);
	if (activeTab?.id !== undefined && activeTab.url === undefined) {
		return activeTab.id;
	}
	if (activeTab && isSelectableTab(activeTab)) {
		return activeTab.id;
	}

	return tabs.find(isSelectableTab)?.id;
}

export function createPendingQueueNavigation(itemId: string, tabId: number, url: string): PendingQueueNavigation {
	return { itemId, tabId, expectedUrl: normalizeQueueUrl(url) };
}

export function matchesPendingQueueNavigation(pending: PendingQueueNavigation, tabId: number, currentUrl: string): boolean {
	if (pending.tabId !== tabId) {
		return false;
	}
	try {
		return normalizeQueueUrl(currentUrl) === pending.expectedUrl;
	} catch {
		return false;
	}
}

export function isPendingQueueNavigation(value: unknown): value is PendingQueueNavigation {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const pending = value as Record<string, unknown>;
	if (
		typeof pending.itemId !== 'string' ||
		!Number.isInteger(pending.tabId) ||
		typeof pending.expectedUrl !== 'string'
	) {
		return false;
	}
	try {
		return normalizeQueueUrl(pending.expectedUrl) === pending.expectedUrl;
	} catch {
		return false;
	}
}
