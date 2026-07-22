import type { BrowserContext, Page } from '@playwright/test';

import type { PlaybackStateResponse, TabPlaybackSessionSnapshot } from '../../src/shared/types';
import { expect, installPopupRuntimeMock, test } from './fixtures';

const activeSession = {
	sessionId: 'session-1',
	contentScope: 'article' as const,
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
			.filter((action: string) => action !== 'GET_PLAYBACK_STATE'),
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

test('manual session popup shows localized metadata without tab actions', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, {
		session: {
			sessionId: 'manual-session',
			contentScope: 'manual',
			source: { kind: 'manual' },
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
			expect(response).toEqual({ success: true });
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
			payload: { text: sentinel, language: 'auto' },
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
				payload: { text: 'First manual session', language: 'en' },
			}),
		).toEqual({ success: true });
		const firstSessionId = (await getBackgroundState(controlPage)).session?.sessionId;
		expect(firstSessionId).toEqual(expect.any(String));

		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: '第二个手动阅读会话。', language: 'auto' },
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
				payload: { text: 'Existing manual session', language: 'en' },
			}),
		).toEqual({ success: true });
		const before = await getBackgroundState(controlPage);
		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: '   ', language: 'auto' },
			}),
		).toEqual({ success: false, error: 'invalidManualText' });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(before.session?.sessionId);
	});

	test('manual playback survives unrelated tab navigation and closure', async ({ context, extensionId }) => {
		const targetPage = await createTargetPage(context);
		const controlPage = await context.newPage();
		await controlPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
		expect(
			await sendCoordinatorCommand(controlPage, {
				action: 'START_MANUAL_TEXT',
				payload: { text: 'Manual playback must survive.', language: 'en' },
			}),
		).toEqual({ success: true });
		const sessionId = (await getBackgroundState(controlPage)).session?.sessionId;
		await targetPage.reload({ waitUntil: 'domcontentloaded' });
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(sessionId);
		await targetPage.close();
		expect((await getBackgroundState(controlPage)).session?.sessionId).toBe(sessionId);
	});
});
