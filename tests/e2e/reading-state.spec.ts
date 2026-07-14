import type { BrowserContext, Page } from '@playwright/test';

import type { PlaybackSessionSnapshot, PlaybackStateResponse } from '../../src/shared/types';
import { expect, installPopupRuntimeMock, test } from './fixtures';

const activeSession = {
	sessionId: 'session-1',
	tabId: 11,
	title: 'Keeping playback alive across popup reopen',
	url: 'https://example.com/articles/reopen',
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
	tabId: 22,
	title: 'Reading from tab B replaces tab A',
	url: 'https://example.com/articles/replacement',
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
	overrides: Partial<PlaybackSessionSnapshot> = {},
): Promise<{ controlPage: Page; session: PlaybackSessionSnapshot }> {
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

	const session: PlaybackSessionSnapshot = { ...activeSession, tabId, ...overrides };
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
		expect((loadingState as PlaybackStateResponse).session).toMatchObject({ status: 'loading', tabId: targetTabId });

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

		await expect(page.locator('.session-title')).toHaveText(session.title);
		await expect(page.locator('.status-text')).toHaveText('Đang đọc đoạn 3/8');
		await expect(page.locator('.progress-bar')).toHaveAttribute('style', 'width: 37.5%;');

		await page.reload();

		await expect(page.locator('.session-title')).toHaveText(session.title);
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
		await expect(page.locator('.session-title')).toHaveText(replacementSession.title);
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
});
