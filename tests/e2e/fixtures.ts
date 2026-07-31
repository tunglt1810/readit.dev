import { type BrowserContext, test as base, chromium, type Page, type Request } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import type { AudioExportStateResponse, PageInfoResponse, PlaybackStateResponse } from '../../src/shared/types';
import { resolveExtensionId } from './extension_id';
import { MODEL_CACHE_SEED_DIR, MODEL_CACHE_SEED_MARKER } from './model_cache_seed';

export type RecordedRequest = Readonly<{
	url: string;
	serviceWorkerUrl: string | null;
	frameUrl: string | null;
	isNavigationRequest: boolean;
}>;

const requestAccessors = new WeakMap<BrowserContext, () => readonly RecordedRequest[]>();

type AudioExportRuntimeMockOptions = {
	deferInitialAudioExportStateResponse?: boolean;
};

export async function installExtensionUiRuntimeMock(
	page: Page,
	initialPlaybackState: PlaybackStateResponse,
	pageInfo?: PageInfoResponse,
	audioExportState: AudioExportStateResponse = { job: null },
	audioExportOptions: AudioExportRuntimeMockOptions = {},
): Promise<void> {
	await page.addInitScript(
		({ playbackState, currentPageInfo, initialAudioExportState, initialAudioExportOptions }) => {
			const listeners = new Set<Function>();
			const playbackStateKey = 'readit_e2e_playback_state';
			const audioExportStateKey = 'readit_e2e_audio_export_state';

			const readPlaybackState = (): PlaybackStateResponse => {
				const storedState = localStorage.getItem(playbackStateKey);
				if (storedState) {
					return JSON.parse(storedState) as PlaybackStateResponse;
				}
				localStorage.setItem(playbackStateKey, JSON.stringify(playbackState));
				return playbackState;
			};

			const readAudioExportState = (): AudioExportStateResponse => {
				const storedState = localStorage.getItem(audioExportStateKey);
				if (storedState) {
					return JSON.parse(storedState) as AudioExportStateResponse;
				}
				localStorage.setItem(audioExportStateKey, JSON.stringify(initialAudioExportState));
				return initialAudioExportState;
			};

			chrome.runtime.onMessage.addListener = (listener) => {
				listeners.add(listener);
			};
			chrome.runtime.onMessage.removeListener = (listener) => {
				listeners.delete(listener);
			};

			(window as any).sentMessages = [] as any[];
			(window as any).deferredRuntimeCallbacks = {} as Record<string, { callback: Function; response: unknown }>;
			(window as any).resolveDeferredRuntimeResponse = (action: string, response?: unknown) => {
				const deferred = (window as any).deferredRuntimeCallbacks[action];
				if (!deferred) {
					return;
				}
				delete (window as any).deferredRuntimeCallbacks[action];
				deferred.callback(response === undefined ? deferred.response : response);
			};
			(window as any).sidePanelOpenCalls = [] as chrome.sidePanel.OpenOptions[];
			(window as any).tabsQueryCalls = 0;
			chrome.tabs.query = async () => {
				(window as any).tabsQueryCalls += 1;
				return [{ windowId: (window as any).mockWindowId ?? 7 } as chrome.tabs.Tab];
			};
			chrome.sidePanel.open = async (options) => {
				(window as any).sidePanelOpenCalls.push(options);
			};
			chrome.runtime.sendMessage = (message: any, callback: any) => {
				(window as any).sentMessages.push(message);
				if (message.action === 'GET_PLAYBACK_STATE') {
					callback?.(readPlaybackState());
				} else if (message.action === 'GET_AUDIO_EXPORT_STATE') {
					const response = readAudioExportState();
					if (initialAudioExportOptions.deferInitialAudioExportStateResponse) {
						(window as any).deferredRuntimeCallbacks[message.action] = { callback, response };
					} else {
						callback?.(response);
					}
				} else if (message.action === 'GET_CURRENT_PAGE_INFO') {
					callback?.(currentPageInfo);
				} else if ((window as any).deferredRuntimeActions?.includes(message.action)) {
					(window as any).deferredRuntimeCallbacks[message.action] = {
						callback,
						response: (window as any).commandResponses?.[message.action] ?? { success: true },
					};
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
				if (message.action === 'AUDIO_EXPORT_STATE_UPDATE') {
					localStorage.setItem(audioExportStateKey, JSON.stringify({ job: message.job ?? null }));
				}
				for (const listener of listeners) {
					listener(message, {}, () => {});
				}
			};
		},
		{
			playbackState: initialPlaybackState,
			currentPageInfo: pageInfo,
			initialAudioExportState: audioExportState,
			initialAudioExportOptions: audioExportOptions,
		},
	);
}

export const installPopupRuntimeMock = installExtensionUiRuntimeMock;

export async function installOpfsAudioExportPicker(
	page: Page,
	filename = 'readit-export-test.mp3',
	options: { invalidHandleKind?: 'directory' } = {},
): Promise<void> {
	await page.addInitScript(
		({ outputFilename, invalidHandleKind }) => {
			window.showSaveFilePicker = async (options) => {
				(window as unknown as { __readitOpfsPickerOptions?: SaveFilePickerOptions }).__readitOpfsPickerOptions = options;
				const root = await navigator.storage.getDirectory();
				if (invalidHandleKind === 'directory') {
					return root as unknown as FileSystemFileHandle;
				}
				const handle = await root.getFileHandle(outputFilename, { create: true });
				return handle;
			};
		},
		{
			outputFilename: filename,
			invalidHandleKind: options.invalidHandleKind,
		},
	);
}

export async function readOpfsFile(page: Page, filename: string): Promise<number[]> {
	return page.evaluate(async (outputFilename) => {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle(outputFilename);
		return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
	}, filename);
}

export async function putOpfsAudioExportHandle(page: Page, jobId: string, filename: string): Promise<void> {
	await page.evaluate(
		async ({ jobId, filename }) => {
			const root = await navigator.storage.getDirectory();
			const handle = await root.getFileHandle(filename, { create: true });
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('readit-audio-export', 1);
				request.onupgradeneeded = () => {
					if (!request.result.objectStoreNames.contains('handles')) {
						request.result.createObjectStore('handles', { keyPath: 'jobId' });
					}
				};
				request.onerror = () => reject(request.error);
				request.onsuccess = () => resolve(request.result);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = database.transaction('handles', 'readwrite');
					transaction.objectStore('handles').put({ jobId, handle });
					transaction.onerror = () => reject(transaction.error);
					transaction.oncomplete = () => resolve();
				});
			} finally {
				database.close();
			}
		},
		{ jobId, filename },
	);
}

export async function opfsFileSizeOrNull(page: Page, filename: string): Promise<number | null> {
	return page.evaluate(async (outputFilename) => {
		try {
			const root = await navigator.storage.getDirectory();
			const handle = await root.getFileHandle(outputFilename);
			return (await handle.getFile()).size;
		} catch {
			return null;
		}
	}, filename);
}

export const test = base.extend<{
	context: BrowserContext;
	extensionId: string;
	openPopup: (page: Page) => Promise<void>;
	openSidePanel: (page: Page) => Promise<void>;
	getRecordedRequests: () => readonly RecordedRequest[];
	browserLocale: string;
	freshExtensionWorker: boolean;
}>({
	browserLocale: ['vi-VN', { option: true }],
	freshExtensionWorker: [true, { option: true }],
	context: async ({ browserLocale, headless, freshExtensionWorker }, use) => {
		const pathToExtension = path.join(process.cwd(), 'dist', 'chrome');
		const tempDir = path.join(process.cwd(), '.tmp');
		fs.mkdirSync(tempDir, { recursive: true });
		const userDataDir = fs.mkdtempSync(path.join(tempDir, 'playwright-chrome-profile-'));

		if (fs.existsSync(MODEL_CACHE_SEED_MARKER)) {
			if (freshExtensionWorker) {
				const seedCacheStorage = path.join(MODEL_CACHE_SEED_DIR, 'Default', 'Service Worker', 'CacheStorage');
				const profileCacheStorage = path.join(userDataDir, 'Default', 'Service Worker', 'CacheStorage');
				fs.mkdirSync(path.dirname(profileCacheStorage), { recursive: true });
				fs.cpSync(seedCacheStorage, profileCacheStorage, { recursive: true });
			} else {
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
		}

		// Khởi chạy Chromium với extension được unpack từ thư mục dist/chrome/
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
