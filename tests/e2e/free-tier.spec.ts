import { MODEL_FILES, STORAGE_KEYS, SUPERTONIC_HF_BASE } from '../../src/shared/constants';
import { expect, type RecordedRequest, test } from './fixtures';

const EXTENSION_WAKE_URL = 'https://readit.test/extension-wakeup';
const APPROVED_MODEL_URLS = new Set(Object.values(MODEL_FILES));

function isExtensionInitiated(request: RecordedRequest): boolean {
	return Boolean(request.serviceWorkerUrl?.startsWith('chrome-extension://') || request.frameUrl?.startsWith('chrome-extension://'));
}

function isFixtureControlledRequest(request: RecordedRequest): boolean {
	return request.url === EXTENSION_WAKE_URL && request.serviceWorkerUrl === null && request.isNavigationRequest;
}

test('hides unavailable Pro UI and does not request license status', async ({ page, openPopup }) => {
	await page.addInitScript(() => {
		(window as any).sentMessages = [] as { action: string }[];
		chrome.runtime.sendMessage = (message: { action: string }, callback?: (response: unknown) => void) => {
			(window as any).sentMessages.push(message);
			callback?.({ success: true });
			return true;
		};
	});

	await openPopup(page);

	await expect(page.locator('.tier-badge-container')).not.toBeVisible();
	await expect(page.locator('.license-section')).not.toBeAttached();
	await expect(page.getByText('Kích hoạt bản quyền Pro')).not.toBeAttached();
	await expect(page.locator('.privacy-disclosure')).toContainText('không gửi lên server');

	const sentActions = await page.evaluate(() => (window as any).sentMessages.map((message: { action: string }) => message.action));
	expect(sentActions).not.toContain('CHECK_LICENSE');
	expect(sentActions).not.toContain('ACTIVATE_LICENSE');
});

test('Side Panel stays within the Free runtime and storage boundary', async ({ getRecordedRequests, page, openSidePanel }) => {
	await page.addInitScript(() => {
		if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
			return;
		}
		const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime) as (...args: any[]) => unknown;
		(window as any).sentMessages = [] as unknown[];
		(chrome.runtime as any).sendMessage = (...args: any[]) => {
			const message = typeof args[0] === 'string' ? args[1] : args[0];
			(window as any).sentMessages.push(message);
			return originalSendMessage(...args);
		};
	});

	await openSidePanel(page);
	await expect(page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' })).toBeVisible();
	await expect(page.locator('.tier-badge-container')).not.toBeAttached();
	await expect(page.locator('.license-section')).not.toBeAttached();
	await expect(page.getByText('Kích hoạt bản quyền Pro')).not.toBeAttached();
	const startupRecords = getRecordedRequests();
	expect(startupRecords.some(isFixtureControlledRequest)).toBe(true);

	await page.evaluate(() => {
		(window as any).modelLoadingProgressCount = 0;
		chrome.runtime.onMessage.addListener((message: { action?: unknown }) => {
			if (message.action === 'MODEL_LOADING_PROGRESS') {
				(window as any).modelLoadingProgressCount += 1;
			}
		});
	});

	const sentinel = 'READIT_FREE_DRAFT_SENTINEL_5A7E19';
	await page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' }).fill(sentinel);
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	await expect(page.locator('.status-display')).toHaveAttribute('data-status', 'loading');
	await expect
		.poll(() => page.evaluate(() => (window as any).modelLoadingProgressCount as number), {
			message: 'expected manual playback to begin real offscreen model work',
			timeout: 10_000,
		})
		.toBeGreaterThan(0);

	const stored = await page.evaluate(async () => ({
		local: await chrome.storage.local.get(null),
		session: await chrome.storage.session.get(null),
		permissions: chrome.runtime.getManifest().permissions ?? [],
		hostPermissions: chrome.runtime.getManifest().host_permissions ?? [],
		sidePanelDefaultPath: chrome.runtime.getManifest().side_panel?.default_path,
	}));
	const approvedLocalKeys = [
		STORAGE_KEYS.ACTIVE_VOICE,
		STORAGE_KEYS.SPEED,
		STORAGE_KEYS.READ_MODE_SETTINGS,
		STORAGE_KEYS.THEME,
		STORAGE_KEYS.SELECTION_BUTTON_ENABLED,
		STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED,
	];
	expect(Object.keys(stored.local).every((key) => approvedLocalKeys.includes(key))).toBe(true);
	expect(Object.keys(stored.session)).toEqual([STORAGE_KEYS.PLAYBACK_SESSION]);
	expect([...Object.keys(stored.local), ...Object.keys(stored.session)].some((key) => /draft/i.test(key))).toBe(false);
	expect(JSON.stringify({ local: stored.local, session: stored.session })).not.toContain(sentinel);

	const snapshot = stored.session[STORAGE_KEYS.PLAYBACK_SESSION] as Record<string, unknown>;
	expect(snapshot).toMatchObject({ contentScope: 'manual', source: { kind: 'manual' }, lang: 'en', status: 'loading' });
	expect(snapshot).not.toHaveProperty('content');
	expect(snapshot).not.toHaveProperty('text');
	expect(snapshot).not.toHaveProperty('title');
	expect(snapshot).not.toHaveProperty('url');
	expect(snapshot).not.toHaveProperty('tabId');
	expect(snapshot.source).toEqual({ kind: 'manual' });
	expect([...stored.permissions].sort()).toEqual(['activeTab', 'contextMenus', 'offscreen', 'scripting', 'sidePanel', 'storage'].sort());
	expect(stored.hostPermissions).toEqual(['https://huggingface.co/*']);
	expect(stored.sidePanelDefaultPath).toBe('src/sidepanel/sidepanel.html');

	const sentActions = await page.evaluate(() =>
		(window as any).sentMessages.map((message: { action?: string }) => message?.action).filter(Boolean),
	);
	expect(sentActions).not.toContain('CHECK_LICENSE');
	expect(sentActions).not.toContain('ACTIVATE_LICENSE');

	const recordedRequests = getRecordedRequests();
	const extensionRemoteRequests = recordedRequests.filter(
		(request) => /^https?:\/\//u.test(request.url) && isExtensionInitiated(request),
	);
	for (const request of extensionRemoteRequests) {
		expect(request.url.startsWith(`${SUPERTONIC_HF_BASE}/`)).toBe(true);
		expect(APPROVED_MODEL_URLS.has(request.url)).toBe(true);
	}
	const nonExtensionRemoteRequests = recordedRequests.filter(
		(request) => /^https?:\/\//u.test(request.url) && !isExtensionInitiated(request),
	);
	expect(nonExtensionRemoteRequests.filter((request) => !isFixtureControlledRequest(request))).toEqual([]);
});
