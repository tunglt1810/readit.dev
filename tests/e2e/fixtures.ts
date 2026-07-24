import { type BrowserContext, test as base, chromium, type Page, type Request } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import type { PageInfoResponse, PlaybackStateResponse } from '../../src/shared/types';
import { resolveExtensionId } from './extension_id';
import { MODEL_CACHE_SEED_DIR, MODEL_CACHE_SEED_MARKER } from './model_cache_seed';

export type RecordedRequest = Readonly<{
	url: string;
	serviceWorkerUrl: string | null;
	frameUrl: string | null;
	isNavigationRequest: boolean;
}>;

const requestAccessors = new WeakMap<BrowserContext, () => readonly RecordedRequest[]>();

export async function installExtensionUiRuntimeMock(
	page: Page,
	initialPlaybackState: PlaybackStateResponse,
	pageInfo?: PageInfoResponse,
): Promise<void> {
	await page.addInitScript(
		({ playbackState, currentPageInfo }) => {
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
			(window as any).sidePanelOpenCalls = [] as chrome.sidePanel.OpenOptions[];
			(window as any).tabsQueryCalls = 0;
			chrome.tabs.query = async () => {
				(window as any).tabsQueryCalls += 1;
				return [{ windowId: 7 } as chrome.tabs.Tab];
			};
			chrome.sidePanel.open = async (options) => {
				(window as any).sidePanelOpenCalls.push(options);
			};
			chrome.runtime.sendMessage = (message: any, callback: any) => {
				(window as any).sentMessages.push(message);
				if (message.action === 'GET_PLAYBACK_STATE') {
					callback?.(readPlaybackState());
				} else if (message.action === 'GET_CURRENT_PAGE_INFO') {
					callback?.(currentPageInfo);
				} else if ((window as any).missingResponseActions?.includes(message.action)) {
					callback?.(undefined);
				} else {
					callback?.((window as any).commandResponses?.[message.action] ?? { success: true });
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
		},
		{ playbackState: initialPlaybackState, currentPageInfo: pageInfo },
	);
}

export const installPopupRuntimeMock = installExtensionUiRuntimeMock;

export const test = base.extend<{
	context: BrowserContext;
	extensionId: string;
	openPopup: (page: Page) => Promise<void>;
	openSidePanel: (page: Page) => Promise<void>;
	getRecordedRequests: () => readonly RecordedRequest[];
	browserLocale: string;
}>({
	browserLocale: ['vi-VN', { option: true }],
	context: async ({ browserLocale, headless }, use) => {
		const pathToExtension = path.join(process.cwd(), 'dist');
		const tempDir = path.join(process.cwd(), '.tmp');
		fs.mkdirSync(tempDir, { recursive: true });
		const userDataDir = fs.mkdtempSync(path.join(tempDir, 'playwright-chrome-profile-'));

		if (fs.existsSync(MODEL_CACHE_SEED_MARKER)) {
			// Clone the pre-warmed profile (see global_setup.ts) so this test's
			// Supertonic model Cache Storage is already populated — avoids
			// racing real network I/O against startPlayback()'s wait for the
			// background cache warm to settle.
			fs.rmSync(userDataDir, { recursive: true, force: true });
			fs.cpSync(MODEL_CACHE_SEED_DIR, userDataDir, { recursive: true });
			for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
				fs.rmSync(path.join(userDataDir, lockFile), { force: true });
			}
		}

		// Khởi chạy Chromium với extension được unpack từ thư mục dist/
		const context = await chromium.launchPersistentContext(userDataDir, {
			channel: 'chromium',
			headless,
			locale: browserLocale,
			args: [
				`--disable-extensions-except=${pathToExtension}`,
				`--load-extension=${pathToExtension}`,
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-sync',
			],
		});
		const recordedRequests: RecordedRequest[] = [];
		const recordRequest = (request: Request) => {
			let frameUrl: string | null = null;
			try {
				frameUrl = request.frame().url() || null;
			} catch (_error) {
				// Navigation and service-worker requests may not expose a frame.
			}
			recordedRequests.push(
				Object.freeze({
					url: request.url(),
					serviceWorkerUrl: request.serviceWorker()?.url() ?? null,
					frameUrl,
					isNavigationRequest: request.isNavigationRequest(),
				}),
			);
		};
		context.on('request', recordRequest);
		requestAccessors.set(context, () => Object.freeze([...recordedRequests]));

		try {
			await use(context);
		} finally {
			context.off('request', recordRequest);
			requestAccessors.delete(context);
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
	getRecordedRequests: async ({ context }, use) => {
		const getRecordedRequests = requestAccessors.get(context);
		if (!getRecordedRequests) {
			throw new Error('Request recorder was not initialized for this browser context.');
		}
		await use(getRecordedRequests);
	},
	extensionId: async ({ context }, use) => {
		await use(await resolveExtensionId(context));
	},
	openPopup: async ({ extensionId }, use) => {
		// Hàm helper để mở trang Popup UI của extension
		const openPopup = async (page: Page) => {
			const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
			await page.goto(popupUrl);
		};
		await use(openPopup);
	},
	openSidePanel: async ({ extensionId }, use) => {
		const openSidePanel = async (page: Page) => {
			const sidePanelUrl = `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`;
			await page.goto(sidePanelUrl);
		};
		await use(openSidePanel);
	},
});

export { expect } from '@playwright/test';
