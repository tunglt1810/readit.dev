import { type BrowserContext, test as base, chromium, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import type { PlaybackStateResponse } from '../../src/shared/types';

export async function installPopupRuntimeMock(page: Page, initialPlaybackState: PlaybackStateResponse): Promise<void> {
	await page.addInitScript((playbackState) => {
		const listeners = new Set<Function>();
		const playbackStateKey = 'readit_e2e_playback_state';

		const readPlaybackState = (): PlaybackStateResponse => {
			const storedState = localStorage.getItem(playbackStateKey);
			if (storedState) {
				return JSON.parse(storedState) as PlaybackStateResponse;
			}
			localStorage.setItem(playbackStateKey, JSON.stringify(playbackState));
			return playbackState;
		};

		chrome.runtime.onMessage.addListener = (listener) => {
			listeners.add(listener);
		};
		chrome.runtime.onMessage.removeListener = (listener) => {
			listeners.delete(listener);
		};

		(window as any).sentMessages = [] as any[];
		chrome.runtime.sendMessage = (message: any, callback: any) => {
			(window as any).sentMessages.push(message);
			if (message.action === 'GET_PLAYBACK_STATE') {
				callback?.(readPlaybackState());
			} else {
				callback?.({ success: true });
			}
			return true;
		};

		(window as any).mockReceiveMessage = (message: any) => {
			if (message.action === 'PLAYBACK_STATE_UPDATE') {
				const currentState = readPlaybackState();
				localStorage.setItem(playbackStateKey, JSON.stringify({ ...currentState, session: message.session ?? null }));
			}
			for (const listener of listeners) {
				listener(message, {}, () => {});
			}
		};
	}, initialPlaybackState);
}

export const test = base.extend<{
	context: BrowserContext;
	extensionId: string;
	openPopup: (page: Page) => Promise<void>;
	browserLocale: string;
}>({
	browserLocale: ['vi-VN', { option: true }],
	context: async ({ browserLocale }, use) => {
		const pathToExtension = path.join(process.cwd(), 'dist');
		const tempDir = path.join(process.cwd(), '.tmp');
		fs.mkdirSync(tempDir, { recursive: true });
		const userDataDir = fs.mkdtempSync(path.join(tempDir, 'playwright-chrome-profile-'));

		// Khởi chạy Chromium với extension được unpack từ thư mục dist/
		const context = await chromium.launchPersistentContext(userDataDir, {
			headless: false,
			locale: browserLocale,
			args: [
				'--start-minimized',
				`--disable-extensions-except=${pathToExtension}`,
				`--load-extension=${pathToExtension}`,
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-sync',
			],
		});

		try {
			await use(context);
		} finally {
			await context.close();
			try {
				if (fs.existsSync(userDataDir)) {
					fs.rmSync(userDataDir, { recursive: true, force: true });
				}
			} catch (_err) {
				// Bỏ qua lỗi dọn dẹp nếu có
			}
		}
	},
	extensionId: async ({ context }, use) => {
		const wakePage = await context.newPage();
		const wakeUrl = 'https://readit.test/extension-wakeup';
		let extensionId: string;
		try {
			await context.route(wakeUrl, (route) =>
				route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Extension wakeup</body></html>' }),
			);
			await wakePage.goto(wakeUrl, { waitUntil: 'domcontentloaded' });

			const serviceWorker = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
			if (serviceWorker) {
				const serviceWorkerUrl = new URL(serviceWorker.url());
				if (!serviceWorkerUrl.hostname) {
					throw new Error(`Không thể lấy Extension ID từ service worker: ${serviceWorker.url()}`);
				}
				extensionId = serviceWorkerUrl.hostname;
			} else {
				const infoEl = await wakePage.waitForSelector('#readit-dev-ext-info', { state: 'attached', timeout: 10000 });
				const markerExtensionId = await infoEl.getAttribute('data-extension-id');
				if (!markerExtensionId) {
					throw new Error('Không tìm thấy Extension ID từ service worker hoặc content-script marker.');
				}
				extensionId = markerExtensionId;
			}
		} finally {
			await context.unroute(wakeUrl);
			await wakePage.close();
		}

		await use(extensionId);
	},
	openPopup: async ({ extensionId }, use) => {
		// Hàm helper để mở trang Popup UI của extension
		const openPopup = async (page: Page) => {
			const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
			await page.goto(popupUrl);
		};
		await use(openPopup);
	},
});

export { expect } from '@playwright/test';
