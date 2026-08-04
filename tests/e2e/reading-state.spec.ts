import type { BrowserContext, Page } from '@playwright/test';

import type {
	AudioExportJobSnapshot,
	ManualPlaybackSessionSnapshot,
	PlaybackStateResponse,
	TabPlaybackSessionSnapshot,
} from '../../src/shared/types';
import { expect, installPopupRuntimeMock, test } from './fixtures';

test.use({ freshExtensionWorker: true });

const activeSession = {
	sessionId: 'session-1',
	contentScope: 'article' as const,
	readableSurface: 'website-dom' as const,
	source: {
		kind: 'tab' as const,
		tabId: 11,
		title: 'Keeping playback alive across popup reopen',
		url: 'https://example.com/articles/reopen',
	},
	lang: 'en',
	status: 'playing' as const,
	currentParagraphIndex: 2,
	totalParagraphs: 8,
	progressPercentage: 37.5,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

const replacementSession = {
	...activeSession,
	sessionId: 'session-2',
	source: {
		kind: 'tab' as const,
		tabId: 22,
		title: 'Reading from tab B replaces tab A',
		url: 'https://example.com/articles/replacement',
	},
	status: 'loading' as const,
	currentParagraphIndex: 0,
	totalParagraphs: 0,
	progressPercentage: 0,
	updatedAt: 2000,
};

const manualPanelInstanceId = 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd';

async function broadcastCoordinatorState(page: Page, session: PlaybackStateResponse['session']): Promise<void> {
	await page.evaluate((nextSession) => {
		(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
	}, session);
}

async function expectStoppedState(page: Page): Promise<void> {
	await expect(page.locator('.status-display')).toHaveAttribute('data-status', 'stopped');
	await expect(page.locator('.status-text')).toHaveText('Sẵn sàng đọc trang web');
	await expect(page.locator('.session-meta')).toHaveCount(0);
	await expect(page.locator('.progress-bar-container')).toHaveCount(0);
}

async function getCoordinatorCommands(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		(window as any).sentMessages
			.map((message: { action: string }) => message.action)
			.filter((action: string) => action !== 'GET_PLAYBACK_STATE' && action !== 'GET_AUDIO_EXPORT_STATE'),
	);
}

async function createTargetPage(context: BrowserContext): Promise<Page> {
	await context.route('https://example.com/**', async (route) => {
		await route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<main><article>
				<h1>Lifecycle article</h1>
				<p>This local article contains enough readable text to exercise extraction and start the offscreen text-to-speech lifecycle without relying on a network page.</p>
				<p>The test intentionally keeps model loading pending while it checks that popup hydration, stop commands, and tab lifecycle events remain responsive.</p>
				<p>Background coordination must never wait for a large model download before handling a user request to stop reading or inspect the current session.</p>
				<p>Late responses from superseded synthesis work must be ignored so that an old article cannot restore a session after the user has already stopped it.</p>
			</article></main>`,
		});
	});
	const targetPage = await context.newPage();
	await targetPage.goto('https://example.com/articles/lifecycle', { waitUntil: 'domcontentloaded' });
	return targetPage;
}

async function seedCoordinatorSession(
	context: BrowserContext,
	extensionId: string,
	targetPage: Page,
	overrides: Partial<TabPlaybackSessionSnapshot> = {},
): Promise<{ controlPage: Page; session: TabPlaybackSessionSnapshot }> {
	const controlPage = await context.newPage();
	await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await targetPage.bringToFront();
	const tabId = await controlPage.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		return tab.id;
	});
	if (typeof tabId !== 'number') {
		throw new Error('Could not resolve the lifecycle target tab ID');
	}

	const session: TabPlaybackSessionSnapshot = { ...activeSession, source: { ...activeSession.source, tabId }, ...overrides };
	await controlPage.evaluate(async (nextSession) => {
		await chrome.storage.session.set({ readit_playback_session: nextSession });
	}, session);

	const cdp = await context.newCDPSession(controlPage);
	const { targetInfos } = await cdp.send('Target.getTargets');
	const workerTarget = targetInfos.find(
		(targetInfo) => targetInfo.type === 'service_worker' && targetInfo.url.startsWith(`chrome-extension://${extensionId}/`),
	);
	if (!workerTarget) {
		throw new Error('Could not resolve the extension service-worker target');
	}
	await cdp.send('Target.closeTarget', { targetId: workerTarget.targetId });

	const hydrated = await getBackgroundState(controlPage);
	expect(hydrated.session?.sessionId).toBe(session.sessionId);
	return { controlPage, session };
}

async function getBackgroundState(page: Page): Promise<PlaybackStateResponse> {
	return page.evaluate(async () => {
		return new Promise<PlaybackStateResponse>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve));
	});
}

async function sendCoordinatorCommand(page: Page, message: unknown): Promise<unknown> {
	return page.evaluate((runtimeMessage) => chrome.runtime.sendMessage(runtimeMessage), message);
}

async function responseWithin<T>(request: Promise<T>, timeoutMs = 2000): Promise<T | 'timed out'> {
	return Promise.race([request, new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), timeoutMs))]);
}

async function sendBackgroundMessage(page: Page, message: unknown): Promise<void> {
	await page.evaluate(async (runtimeMessage) => {
		try {
			await chrome.runtime.sendMessage(runtimeMessage);
		} catch {
			// Progress broadcasts intentionally have no response payload.
		}
	}, message);
}

async function waitForBackgroundSessionClear(page: Page): Promise<void> {
	await page.waitForFunction(async () => {
		const stored = await chrome.storage.session.get('readit_playback_session');
		return stored.readit_playback_session === undefined;
	});
}

async function getBadgeText(page: Page): Promise<string> {
	return page.evaluate(() => chrome.action.getBadgeText({}));
}

async function getOffscreenContextCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const contexts = await chrome.runtime.getContexts({
			contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
		});
		return contexts.length;
	});
}

type OffscreenPlaybackDebug = {
	sessionId: string | null;
	sourceId: number;
	bufferOffsetSec: number;
	audioContextTime: number | null;
	pauseKeepalive: {
		running: boolean;
		timerScheduled: boolean;
		pulseActive: boolean;
	};
};

async function getOffscreenPlaybackDebug(context: BrowserContext, page: Page): Promise<OffscreenPlaybackDebug> {
	const cdp = await context.newCDPSession(page);
	const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
	const offscreenTarget = targetInfos.find((targetInfo) => targetInfo.url.includes('/src/offscreen/offscreen.html'));
	if (!offscreenTarget) {
		const offscreenContexts = await page.evaluate(async () => {
			const contexts = await chrome.runtime.getContexts({
				contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
			});
			return contexts.map((runtimeContext) => ({
				contextType: runtimeContext.contextType,
				documentId: runtimeContext.documentId,
				documentUrl: runtimeContext.documentUrl,
			}));
		});
		const targetSummary = targetInfos.map((targetInfo) => ({ type: targetInfo.type, url: targetInfo.url }));
		throw new Error(
			`Could not resolve the offscreen playback target. Runtime contexts: ${JSON.stringify(offscreenContexts)}. CDP targets: ${JSON.stringify(targetSummary)}`,
		);
	}
	const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: offscreenTarget.targetId, flatten: false });
	const messageId = 1;
	const result = new Promise<OffscreenPlaybackDebug>((resolve, reject) => {
		const listener = (event: { sessionId: string; message: string }) => {
			if (event.sessionId !== sessionId) {
				return;
			}
			const message = JSON.parse(event.message) as {
				id?: number;
				result?: { result?: { value?: OffscreenPlaybackDebug } };
				error?: { message?: string };
			};
			if (message.id !== messageId) {
				return;
			}
			cdp.off('Target.receivedMessageFromTarget', listener);
			if (message.error?.message) {
				reject(new Error(message.error.message));
				return;
			}
			if (!message.result?.result?.value) {
				reject(new Error('Offscreen playback debug state was unavailable'));
				return;
			}
			resolve(message.result.result.value);
		};
		cdp.on('Target.receivedMessageFromTarget', listener);
	});

	try {
		await cdp.send('Target.sendMessageToTarget', {
			sessionId,
			message: JSON.stringify({
				id: messageId,
				method: 'Runtime.evaluate',
				params: { expression: 'globalThis.__readitPlaybackDebug?.()', returnByValue: true },
			}),
		});
		return await result;
	} finally {
		await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
	}
}

test('manual session popup shows localized metadata without tab actions', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, {
		session: {
			sessionId: 'manual-session',
			contentScope: 'manual',
			readableSurface: 'manual-reader',
			source: { kind: 'manual', panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' },
			lang: 'vi',
			status: 'paused',
			currentParagraphIndex: 0,
			totalParagraphs: 2,
			progressPercentage: 50,
			voiceStyleId: 'F1',
			speed: 1.05,
			updatedAt: 1000,
		},
		currentTabId: 7,
	});
	await openPopup(page);

	await expect(page.locator('.session-title')).toHaveText('Văn bản đã dán');
	await expect(page.locator('.session-context')).toContainText('Phiên đọc văn bản');
	await expect(page.locator('.session-host')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Đọc trang này thay thế' })).toHaveCount(0);
});

test.describe('Reading state lifecycle', () => {
	test('toolbar badge follows hydrated playback state and clears on stop', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const { controlPage, session } = await seedCoordinatorSession(context, extensionId, targetPage, {
			status: 'loading',
		});
		await expect.poll(() => getBadgeText(controlPage)).toBe('…');

		await sendBackgroundMessage(controlPage, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId: session.sessionId,
			progress: { status: 'playing', currentParagraphIndex: 0, totalParagraphs: 8, progressPercentage: 10 },
		});
		await expect.poll(() => getBadgeText(controlPage)).toBe('▶');

		await sendBackgroundMessage(controlPage, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId: session.sessionId,
			progress: { status: 'paused', currentParagraphIndex: 0, totalParagraphs: 8, progressPercentage: 10 },
		});
		await expect.poll(() => getBadgeText(controlPage)).toBe('Ⅱ');

		await sendBackgroundMessage(controlPage, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId: session.sessionId,
			progress: {
				status: 'error',
				currentParagraphIndex: 0,
				totalParagraphs: 8,
				progressPercentage: 10,
				error: 'Expected test error',
			},
		});
		await expect.poll(() => getBadgeText(controlPage)).toBe('!');

		await sendBackgroundMessage(controlPage, { action: 'STOP_READING' });
		await expect.poll(() => getBadgeText(controlPage)).toBe('');
	});

	test('start and stop remain responsive while offscreen model loading is pending', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await targetPage.bringToFront();
		const targetTabId = await controlPage.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
			return tab.id;
		});
		expect(typeof targetTabId).toBe('number');

		const start = sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' });
		expect(await responseWithin(start)).toEqual({ success: true });

		const loadingState = await responseWithin(getBackgroundState(controlPage));
		expect(loadingState).not.toBe('timed out');
		expect((loadingState as PlaybackStateResponse).session).toMatchObject({
			status: 'loading',
			source: { kind: 'tab', tabId: targetTabId },
		});

		expect(await responseWithin(sendCoordinatorCommand(controlPage, { action: 'STOP_READING' }))).toEqual({ success: true });
		await expect.poll(async () => (await getBackgroundState(controlPage)).session).toBeNull();
	});

	test.describe('Headed audio lifecycle', () => {
		test('resumes the same session after Chrome audio idle cutoff and clears a lost paused session', async ({
			context,
			extensionId,
			page,
			openPopup,
		}) => {
			test.setTimeout(300_000);
			const targetPage = await createTargetPage(context);
			const controlPage = await context.newPage();
			await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
			await targetPage.bringToFront();

			const start = sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' });
			expect(await responseWithin(start)).toEqual({ success: true });
			await expect
				.poll(async () => (await getBackgroundState(controlPage)).session, { timeout: 240_000 })
				.toMatchObject({ status: 'playing' });
			const playingSession = (await getBackgroundState(controlPage)).session;
			expect(playingSession?.sessionId).toEqual(expect.any(String));
			const beforePause = await getOffscreenPlaybackDebug(context, controlPage);
			expect(beforePause).toMatchObject({ sessionId: playingSession?.sessionId, sourceId: expect.any(Number) });

			await expect(sendCoordinatorCommand(controlPage, { action: 'PAUSE_READING' })).resolves.toEqual({ success: true });
			await expect
				.poll(async () => (await getBackgroundState(controlPage)).session)
				.toMatchObject({
					sessionId: playingSession?.sessionId,
					status: 'paused',
				});
			const paused = await getOffscreenPlaybackDebug(context, controlPage);
			expect(paused.sourceId).toBe(beforePause.sourceId);
			expect(paused.bufferOffsetSec).toBe(beforePause.bufferOffsetSec);
			expect(paused.audioContextTime).toEqual(expect.any(Number));
			expect(paused.pauseKeepalive).toEqual({
				running: true,
				timerScheduled: true,
				pulseActive: false,
			});

			// Chrome documents that AUDIO_PLAYBACK offscreen documents close after 30 seconds without audio.
			await controlPage.waitForTimeout(35_000);
			await expect.poll(() => getOffscreenContextCount(controlPage)).toBe(1);
			const held = await getOffscreenPlaybackDebug(context, controlPage);
			expect(held.sourceId).toBe(paused.sourceId);
			expect(held.bufferOffsetSec).toBe(paused.bufferOffsetSec);
			expect(held.audioContextTime).toBeCloseTo(paused.audioContextTime as number, 3);
			expect(held.pauseKeepalive).toEqual({
				running: true,
				timerScheduled: true,
				pulseActive: false,
			});

			await expect(sendCoordinatorCommand(controlPage, { action: 'RESUME_READING' })).resolves.toEqual({ success: true });
			await expect
				.poll(async () => (await getBackgroundState(controlPage)).session)
				.toMatchObject({
					sessionId: playingSession?.sessionId,
					status: 'playing',
				});
			const resumed = await getOffscreenPlaybackDebug(context, controlPage);
			expect(resumed.sourceId).toBe(paused.sourceId);
			expect(resumed.bufferOffsetSec).toBe(paused.bufferOffsetSec);
			expect(resumed.audioContextTime).toBeGreaterThanOrEqual(paused.audioContextTime as number);
			expect(resumed.pauseKeepalive).toEqual({
				running: false,
				timerScheduled: false,
				pulseActive: false,
			});

			await expect(sendCoordinatorCommand(controlPage, { action: 'PAUSE_READING' })).resolves.toEqual({ success: true });
			await openPopup(page);
			await expect(page.locator('.status-display')).toHaveAttribute('data-status', 'paused');
			await controlPage.evaluate(async () => chrome.offscreen.closeDocument());

			await expect(sendCoordinatorCommand(controlPage, { action: 'RESUME_READING' })).resolves.toMatchObject({ success: false });
			await expect(page.locator('.status-display')).toHaveAttribute('data-status', 'error');
			await expect(page.getByRole('button', { name: 'Đọc trang hiện tại' })).toBeVisible();
			await expect(page.getByRole('button', { name: 'Dừng đọc' })).toHaveCount(0);
		});
	});

	test('speed change during pending model loading keeps the same loading session', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await targetPage.bringToFront();

		const loadingSession = await test.step('start playback and reach pending model loading', async () => {
			const start = sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' });
			expect(await responseWithin(start)).toEqual({ success: true });

			const loadingState = await responseWithin(getBackgroundState(controlPage));
			expect(loadingState).not.toBe('timed out');
			expect((loadingState as PlaybackStateResponse).session).toMatchObject({ status: 'loading' });
			return (loadingState as PlaybackStateResponse).session;
		});

		await test.step('change speed without completing the loading session', async () => {
			const response = await responseWithin(sendCoordinatorCommand(controlPage, { action: 'CHANGE_SPEED', payload: { speed: 1.3 } }));
			expect(response).toMatchObject({
				success: true,
				audioExportEstimate: { durationSeconds: expect.any(Number), estimatedBytes: expect.any(Number) },
			});
			await expect
				.poll(async () => (await getBackgroundState(controlPage)).session)
				.toMatchObject({ sessionId: loadingSession?.sessionId, status: 'loading', speed: 1.3 });
		});
	});

	test('reopen hydration uses the latest coordinator snapshot', async ({ context, extensionId, page, openPopup }) => {
		const targetPage = await createTargetPage(context);
		const { session } = await seedCoordinatorSession(context, extensionId, targetPage);
		await openPopup(page);

		await expect(page.locator('.session-title')).toHaveText(session.source.title);
		await expect(page.locator('.status-text')).toHaveText('Đang đọc đoạn 3/8');
		await expect(page.locator('.progress-bar')).toHaveAttribute('style', 'width: 37.5%;');

		await page.reload();

		await expect(page.locator('.session-title')).toHaveText(session.source.title);
		await expect(page.locator('.status-text')).toHaveText('Đang đọc đoạn 3/8');
		await expect(page.locator('.progress-bar')).toHaveAttribute('style', 'width: 37.5%;');
	});

	test('background hydration preserves a numeric audio export estimate', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const { controlPage, session } = await seedCoordinatorSession(context, extensionId, targetPage, {
			audioExportEstimate: { durationSeconds: 90, estimatedBytes: 1_084_096 },
		});

		expect((await getBackgroundState(controlPage)).session).toMatchObject({
			sessionId: session.sessionId,
			audioExportEstimate: { durationSeconds: 90, estimatedBytes: 1_084_096 },
		});
	});

	test('worker restart interrupts a persisted MP3 export without resuming it', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const { controlPage, session } = await seedCoordinatorSession(context, extensionId, targetPage, {
			audioExportEstimate: { durationSeconds: 90, estimatedBytes: 1_084_096 },
		});
		const activeJob: AudioExportJobSnapshot = {
			jobId: 'e99e8996-8372-4e0e-8224-6e3cf5d206f8',
			playbackSessionId: session.sessionId,
			title: session.source.title,
			outputFilename: 'restart.mp3',
			state: 'exporting',
			estimate: { durationSeconds: 90, estimatedBytes: 1_084_096 },
			processedDurationSeconds: 10,
			progressPercentage: 11,
			bytesWritten: 1_024,
			startedAt: 1_000,
			updatedAt: 2_000,
		};
		await controlPage.evaluate(async (job) => {
			await chrome.storage.session.set({ readit_audio_export_job: job });
		}, activeJob);
		await controlPage.evaluate(() => {
			(window as any).offscreenExportCommands = [];
			chrome.runtime.onMessage.addListener((message) => {
				if (message?.target === 'readit-offscreen-audio-export') {
					const action = message.command?.action || message.action;
					if (action) {
						(window as any).offscreenExportCommands.push(action);
					}
				}
			});
		});

		const cdp = await context.newCDPSession(controlPage);
		const { targetInfos } = await cdp.send('Target.getTargets');
		const workerTarget = targetInfos.find(
			(targetInfo) => targetInfo.type === 'service_worker' && targetInfo.url.startsWith(`chrome-extension://${extensionId}/`),
		);
		expect(workerTarget).toBeDefined();
		await cdp.send('Target.closeTarget', { targetId: workerTarget?.targetId as string });

		await expect
			.poll(() =>
				controlPage.evaluate(
					() =>
						chrome.runtime.sendMessage({ action: 'GET_AUDIO_EXPORT_STATE' }) as Promise<{ job: AudioExportJobSnapshot | null }>,
				),
			)
			.toMatchObject({ job: { jobId: activeJob.jobId, state: 'interrupted', errorCode: 'interrupted' } });
		const commands = await controlPage.evaluate(() => (window as any).offscreenExportCommands);
		expect(commands).toContain('CANCEL_AUDIO_EXPORT');
		expect(commands).not.toContain('START_AUDIO_EXPORT');
	});

	test('owner-tab close clears the active session', async ({ context, extensionId, page, openPopup }) => {
		const targetPage = await createTargetPage(context);
		const { controlPage } = await seedCoordinatorSession(context, extensionId, targetPage);
		await targetPage.close();
		await waitForBackgroundSessionClear(controlPage);
		await openPopup(page);

		await expectStoppedState(page);
	});

	test('owner reload or navigation clears the active session', async ({ context, extensionId, page, openPopup }) => {
		const targetPage = await createTargetPage(context);
		const { controlPage } = await seedCoordinatorSession(context, extensionId, targetPage);
		await targetPage.reload({ waitUntil: 'domcontentloaded' });
		await waitForBackgroundSessionClear(controlPage);
		await openPopup(page);

		await expectStoppedState(page);
	});

	test('tab B replacement changes the active session', async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, { session: activeSession, currentTabId: 22 });
		await openPopup(page);

		await expect(page.locator('.session-context')).toContainText('Đang đọc ở tab khác');
		await page.locator('.btn-read-current-page').click();
		expect(await getCoordinatorCommands(page)).toEqual(['START_CURRENT_PAGE']);

		await broadcastCoordinatorState(page, replacementSession);
		await expect(page.locator('.session-title')).toHaveText(replacementSession.source.title);
		await expect(page.locator('.status-display')).toHaveAttribute('data-status', 'loading');
		await expect(page.locator('.session-context')).toContainText('Đang đọc ở tab này');
	});

	test('popup on another tab routes controls through the playback coordinator', async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, { session: activeSession, currentTabId: 22 });
		await openPopup(page);

		const playPauseButton = page.getByRole('button', { name: 'Tạm dừng' });
		await expect(page.locator('.session-context')).toContainText('Đang đọc ở tab khác');
		await playPauseButton.click();

		await broadcastCoordinatorState(page, { ...activeSession, status: 'paused' });
		const resumeButton = page.getByRole('button', { name: 'Tiếp tục' });
		await expect(resumeButton).toHaveText('');
		await resumeButton.click();

		await page.locator('.btn-read').click();

		const commands = await getCoordinatorCommands(page);
		expect(commands).toEqual(['PAUSE_READING', 'RESUME_READING', 'STOP_READING']);
		expect(commands).not.toContain('PAUSE');
		expect(commands).not.toContain('PLAY');
		expect(commands).not.toContain('STOP');
		expect(commands).not.toContain('EXTRACT_AND_PLAY');
	});

	test('stop during loading ignores late old PLAYBACK_PROGRESS_UPDATE', async ({ context, extensionId, page, openPopup }) => {
		const targetPage = await createTargetPage(context);
		const { controlPage, session: loadingSession } = await seedCoordinatorSession(context, extensionId, targetPage, {
			status: 'loading',
			currentParagraphIndex: 0,
			totalParagraphs: 0,
			progressPercentage: 0,
		});
		await sendBackgroundMessage(controlPage, { action: 'STOP_READING' });
		await waitForBackgroundSessionClear(controlPage);
		await sendBackgroundMessage(controlPage, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId: loadingSession.sessionId,
			progress: { status: 'playing', currentParagraphIndex: 7, totalParagraphs: 8, progressPercentage: 100 },
		});
		expect((await getBackgroundState(controlPage)).session).toBeNull();
		await openPopup(page);

		await expectStoppedState(page);
	});

	test('natural completion remains stopped after popup reload', async ({ context, extensionId, page, openPopup }) => {
		const targetPage = await createTargetPage(context);
		const { controlPage, session } = await seedCoordinatorSession(context, extensionId, targetPage);
		await sendBackgroundMessage(controlPage, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId: session.sessionId,
			progress: { status: 'stopped', currentParagraphIndex: 8, totalParagraphs: 8, progressPercentage: 100 },
		});
		await waitForBackgroundSessionClear(controlPage);
		await openPopup(page);

		await expectStoppedState(page);
		await page.reload();
		await expectStoppedState(page);
	});

	test('manual text starts a tab-independent loading session without persisting content', async ({ context, extensionId }) => {
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		const sentinel = 'READIT_MANUAL_PRIVACY_SENTINEL_7F3C2A';
		const response = await sendCoordinatorCommand(controlPage, {
			action: 'START_MANUAL_TEXT',
			payload: { text: sentinel, language: 'auto', panelInstanceId: manualPanelInstanceId },
		});
		expect(response).toEqual({ success: true });
		const state = await getBackgroundState(controlPage);
		expect(state.session).toMatchObject({ contentScope: 'manual', source: { kind: 'manual' }, lang: 'en', status: 'loading' });
		const stored = await controlPage.evaluate(async () => ({
			session: await chrome.storage.session.get(),
			local: await chrome.storage.local.get(),
		}));
		expect(JSON.stringify(stored.session)).not.toContain(sentinel);
		expect(JSON.stringify(stored.local)).not.toContain(sentinel);
	});

	test('relays one manual word highlight from one canonical surface update', async ({ context, extensionId }) => {
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await controlPage.evaluate(() => {
			(window as any).manualWordHighlightEvents = [];
			chrome.runtime.onMessage.addListener((message) => {
				if (message?.action === 'MANUAL_WORD_HIGHLIGHT_UPDATE') {
					(window as any).manualWordHighlightEvents.push(message);
				}
			});
		});
		await expect(
			sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: 'The cat sleeps.', language: 'en', panelInstanceId: manualPanelInstanceId },
			}),
		).resolves.toEqual({ success: true });
		const sessionId = (await getBackgroundState(controlPage)).session?.sessionId;
		expect(sessionId).toEqual(expect.any(String));
		await controlPage.evaluate(() => {
			(window as any).manualWordHighlightEvents = [];
		});

		await sendBackgroundMessage(controlPage, {
			action: 'READABLE_SURFACE_UPDATE',
			sessionId,
			word: 'InjectedCanonicalWord',
			wordIndex: 99,
		});

		await expect
			.poll(() => controlPage.evaluate(() => (window as any).manualWordHighlightEvents))
			.toContainEqual({
				action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
				sessionId,
				word: 'InjectedCanonicalWord',
				wordIndex: 99,
			});
	});

	test('a failed manual checkpoint leaves manual playback active and does not start web reading', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		const manualSession: ManualPlaybackSessionSnapshot = {
			sessionId: 'manual-checkpoint-failure',
			contentScope: 'manual',
			readableSurface: 'manual-reader',
			source: { kind: 'manual', panelInstanceId: manualPanelInstanceId },
			lang: 'en',
			status: 'playing',
			currentParagraphIndex: 0,
			totalParagraphs: 1,
			progressPercentage: 10,
			voiceStyleId: 'M1',
			speed: 1.05,
			updatedAt: Date.now(),
		};
		await controlPage.evaluate(async (session) => {
			await chrome.storage.session.set({ readit_playback_session: session });
			chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
				if (message?.action === 'CHECKPOINT_MANUAL') {
					sendResponse({ success: false });
				}
			});
		}, manualSession);
		const cdp = await context.newCDPSession(controlPage);
		const { targetInfos } = await cdp.send('Target.getTargets');
		const workerTarget = targetInfos.find(
			(targetInfo) => targetInfo.type === 'service_worker' && targetInfo.url.startsWith(`chrome-extension://${extensionId}/`),
		);
		expect(workerTarget).toBeDefined();
		await cdp.send('Target.closeTarget', { targetId: workerTarget?.targetId as string });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(manualSession.sessionId);

		await targetPage.bringToFront();
		await expect(sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' })).resolves.toEqual({
			success: false,
			error: 'manualCheckpointFailed',
		});
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(manualSession.sessionId);
	});

	test('manual loading is checkpointed before web reading starts', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await expect(
			sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: 'Manual loading can resume later.', language: 'en', panelInstanceId: manualPanelInstanceId },
			}),
		).resolves.toEqual({ success: true });

		await targetPage.bringToFront();
		await expect(sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' })).resolves.toEqual({ success: true });
		expect((await getBackgroundState(controlPage)).session).toMatchObject({ contentScope: 'article', source: { kind: 'tab' } });
	});

	test('manual checkpoint preempts before a validated web reading starts', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		const manualSession: ManualPlaybackSessionSnapshot = {
			sessionId: 'manual-checkpoint-session',
			contentScope: 'manual',
			readableSurface: 'manual-reader',
			source: { kind: 'manual', panelInstanceId: manualPanelInstanceId },
			lang: 'en',
			status: 'playing',
			currentParagraphIndex: 0,
			totalParagraphs: 1,
			progressPercentage: 10,
			voiceStyleId: 'M1',
			speed: 1.05,
			updatedAt: Date.now(),
		};
		await controlPage.evaluate(async (session) => {
			await chrome.storage.session.set({ readit_playback_session: session });
			(window as any).checkpointCalls = 0;
			chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
				if (message?.action === 'CHECKPOINT_MANUAL') {
					(window as any).checkpointCalls += 1;
					sendResponse({
						success: true,
						checkpoint: {
							sessionId: session.sessionId,
							panelInstanceId: session.source.panelInstanceId,
							lang: session.lang,
							voiceStyleId: session.voiceStyleId,
							speed: session.speed,
						},
					});
					return true;
				}
				if (message?.action === 'RESUME_MANUAL_CHECKPOINT') {
					sendResponse({ success: true });
					return true;
				}
				return undefined;
			});
		}, manualSession);
		const cdp = await context.newCDPSession(controlPage);
		const { targetInfos } = await cdp.send('Target.getTargets');
		const workerTarget = targetInfos.find(
			(targetInfo) => targetInfo.type === 'service_worker' && targetInfo.url.startsWith(`chrome-extension://${extensionId}/`),
		);
		expect(workerTarget).toBeDefined();
		await cdp.send('Target.closeTarget', { targetId: workerTarget?.targetId as string });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(manualSession.sessionId);

		await targetPage.bringToFront();
		await expect(sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' })).resolves.toEqual({ success: true });
		expect(await controlPage.evaluate(() => (window as any).checkpointCalls)).toBe(1);
		const webSession = (await getBackgroundState(controlPage)).session;
		expect(webSession).toMatchObject({ contentScope: 'article', source: { kind: 'tab' } });
		await expect(
			sendCoordinatorCommand(controlPage, {
				action: 'STOP_SIDE_PANEL_AUDIO',
				panelInstanceId: 'c45b5fc4-7d8a-4ab6-866d-53f17b29799d',
			}),
		).resolves.toEqual({ success: true });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(webSession?.sessionId);
		await controlPage.evaluate(async () => {
			try {
				await chrome.offscreen.closeDocument();
			} catch {
				// The coordinator still holds only checkpoint metadata after the document is gone.
			}
		});
		await expect(
			sendCoordinatorCommand(controlPage, { action: 'RESUME_MANUAL_CHECKPOINT', panelInstanceId: manualPanelInstanceId }),
		).resolves.toEqual({ success: true });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(manualSession.sessionId);
	});

	test('manual playback synchronizes real extension surfaces and never highlights the open article', async ({ context, extensionId }) => {
		const articlePage = await createTargetPage(context);
		const popup = await context.newPage();
		await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		await expect(popup.locator('.status-display')).toHaveAttribute('data-status', 'stopped');
		const sidePanel = await context.newPage();
		await sidePanel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
		const textbox = sidePanel.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
		await expect(textbox).toBeVisible();
		await articlePage.bringToFront();

		await textbox.fill('Manual cross-surface playback.');
		await sidePanel.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
		const loadingState = await getBackgroundState(sidePanel);
		expect(loadingState.session).toMatchObject({ contentScope: 'manual', source: { kind: 'manual' }, status: 'loading' });
		const sessionId = loadingState.session?.sessionId;
		expect(sessionId).toEqual(expect.any(String));

		await sendBackgroundMessage(sidePanel, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId,
			progress: { status: 'playing', currentParagraphIndex: 0, totalParagraphs: 2, progressPercentage: 25 },
		});
		await expect(sidePanel.locator('.status-display')).toHaveAttribute('data-status', 'playing');
		await expect(popup.locator('.status-display')).toHaveAttribute('data-status', 'playing');
		await expect.poll(() => getBadgeText(sidePanel)).toBe('▶');
		await expect(sidePanel.locator('.session-title')).toHaveText('Văn bản đã dán');
		await expect(popup.locator('.session-title')).toHaveText('Văn bản đã dán');

		await expect.poll(() => articlePage.evaluate(() => CSS.highlights?.has('readit-dev-word-highlight') ?? false)).toBe(false);
		await sendBackgroundMessage(sidePanel, { action: 'WORD_HIGHLIGHT_UPDATE', sessionId, word: 'Lifecycle' });
		await getBackgroundState(sidePanel);
		await expect.poll(() => articlePage.evaluate(() => CSS.highlights?.has('readit-dev-word-highlight') ?? false)).toBe(false);

		await sendBackgroundMessage(sidePanel, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId,
			progress: { status: 'paused', currentParagraphIndex: 0, totalParagraphs: 2, progressPercentage: 25 },
		});
		await expect(sidePanel.locator('.status-display')).toHaveAttribute('data-status', 'paused');
		await expect(popup.locator('.status-display')).toHaveAttribute('data-status', 'paused');
		await expect.poll(() => getBadgeText(sidePanel)).toBe('Ⅱ');

		await sendBackgroundMessage(sidePanel, {
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId,
			progress: { status: 'stopped', currentParagraphIndex: 2, totalParagraphs: 2, progressPercentage: 100 },
		});
		await expect.poll(async () => (await getBackgroundState(sidePanel)).session).toBeNull();
		await expect(sidePanel.locator('.status-display')).toHaveAttribute('data-status', 'stopped');
		await expect(popup.locator('.status-display')).toHaveAttribute('data-status', 'stopped');
		await expect.poll(() => getBadgeText(sidePanel)).toBe('');
	});

	test('manual text remains available while the active page is restricted', async ({ context, extensionId }) => {
		const restrictedPage = await context.newPage();
		await restrictedPage.goto('chrome://extensions/');
		const sidePanel = await context.newPage();
		await sidePanel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
		await expect(sidePanel.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' })).toBeVisible();
		const cdp = await context.newCDPSession(sidePanel);
		const { targetInfos } = await cdp.send('Target.getTargets');
		const restrictedTarget = targetInfos.find((targetInfo) => targetInfo.type === 'page' && targetInfo.url === 'chrome://extensions/');
		expect(restrictedTarget).toBeDefined();
		await cdp.send('Target.activateTarget', { targetId: restrictedTarget?.targetId as string });

		await sidePanel.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
		await expect(sidePanel.getByRole('alert')).toHaveText(
			'Tiện ích không thể chạy trên trang này. Vui lòng sử dụng trên một trang web bài viết khác.',
		);

		await sidePanel.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' }).fill('Manual text works on restricted pages.');
		await sidePanel.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
		await expect(sidePanel.locator('.status-display')).toHaveAttribute('data-status', 'loading');
		await expect(sidePanel.locator('.session-title')).toHaveText('Văn bản đã dán');
		expect(await getBackgroundState(sidePanel)).toMatchObject({
			session: { contentScope: 'manual', source: { kind: 'manual' }, status: 'loading' },
		});
	});

	test('valid manual text replaces the active manual session', async ({ context, extensionId }) => {
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: 'First manual session', language: 'en', panelInstanceId: manualPanelInstanceId },
			}),
		).toEqual({ success: true });
		const firstSessionId = (await getBackgroundState(controlPage)).session?.sessionId;
		expect(firstSessionId).toEqual(expect.any(String));

		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: '第二个手动阅读会话。', language: 'auto', panelInstanceId: manualPanelInstanceId },
			}),
		).toEqual({ success: true });
		const replacement = (await getBackgroundState(controlPage)).session;
		expect(replacement?.sessionId).not.toBe(firstSessionId);
		expect(replacement).toMatchObject({ contentScope: 'manual', source: { kind: 'manual' }, lang: 'zh', status: 'loading' });
	});

	test('invalid manual text preserves the active session', async ({ context, extensionId }) => {
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: 'Existing manual session', language: 'en', panelInstanceId: manualPanelInstanceId },
			}),
		).toEqual({ success: true });
		const before = await getBackgroundState(controlPage);
		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: '   ', language: 'auto', panelInstanceId: manualPanelInstanceId },
			}),
		).toEqual({ success: false, error: 'invalidManualText' });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(before.session?.sessionId);
	});

	test('a denied Google Docs export preserves the active manual session', async ({ context, extensionId }) => {
		await context.route('https://docs.google.com/document/d/denied-manual-doc/edit**', (route) =>
			route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><div role="application"></div></body></html>' }),
		);
		await context.route(/\/document\/d\/denied-manual-doc\/export\?format=txt$/, (route) =>
			route.fulfill({ status: 403, contentType: 'text/plain; charset=utf-8', body: '' }),
		);

		const targetPage = await context.newPage();
		await targetPage.goto('https://docs.google.com/document/d/denied-manual-doc/edit');
		const controlPage = await context.newPage();
		await controlPage.goto('chrome-extension://' + extensionId + '/src/popup/popup.html');
		await expect(
			sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: 'Manual playback must survive.', language: 'en', panelInstanceId: manualPanelInstanceId },
			}),
		).resolves.toEqual({ success: true });
		const manualSessionId = (await getBackgroundState(controlPage)).session?.sessionId;
		expect(manualSessionId).toEqual(expect.any(String));

		await targetPage.bringToFront();
		await expect(sendCoordinatorCommand(controlPage, { action: 'START_CURRENT_PAGE' })).resolves.toEqual({
			success: false,
			error: 'googleDocsExportUnavailable',
		});
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(manualSessionId);
	});

	test('manual playback survives unrelated tab navigation and closure', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: 'Manual playback must survive.', language: 'en', panelInstanceId: manualPanelInstanceId },
			}),
		).toEqual({ success: true });
		const sessionId = (await getBackgroundState(controlPage)).session?.sessionId;
		await targetPage.reload({ waitUntil: 'domcontentloaded' });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(sessionId);
		await targetPage.close();
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(sessionId);
	});
});
