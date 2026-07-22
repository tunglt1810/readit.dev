import { expect, installPopupRuntimeMock, test } from './fixtures';

const playingSession = {
	sessionId: 'theme-session',
	contentScope: 'article' as const,
	source: { kind: 'tab' as const, tabId: 7, title: 'Theme article', url: 'https://example.com/theme-article' },
	lang: 'en',
	status: 'playing' as const,
	currentParagraphIndex: 0,
	totalParagraphs: 5,
	progressPercentage: 20,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

async function selectTheme(page: import('@playwright/test').Page, label: string) {
	await page.getByRole('button', { name: 'Chọn giao diện' }).click();
	await page.getByRole('button', { name: label }).click();
}

for (const [label, theme] of [
	['🕹️ Classic (1998)', 'winamp'],
	['💿 Vista Aero (2006)', 'wmp12'],
] as const) {
	test(`classic theme ${theme} preserves status affordances across the playback state matrix`, async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
		await openPopup(page);
		await selectTheme(page, label);
		await expect(page.locator('.app-container')).toHaveAttribute('data-theme', theme);
		await expect(page.getByRole('button', { name: 'Đọc trang hiện tại' })).toBeEnabled();
		await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
		await expect.poll(() => page.evaluate(() => (window as any).sentMessages.at(-1)?.action)).toBe('START_CURRENT_PAGE');

		await page.evaluate(
			(nextSession) => {
				(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
			},
			{ ...playingSession, status: 'loading' },
		);
		await expect(page.getByRole('button', { name: 'Đọc trang hiện tại' })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Dừng đọc bài' })).toBeEnabled();

		await page.evaluate(
			(nextSession) => {
				(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
			},
			{ ...playingSession, status: 'paused' },
		);
		await expect(page.getByRole('button', { name: 'Tiếp tục' })).toBeEnabled();
		await page.getByRole('button', { name: 'Tiếp tục' }).click();
		await expect.poll(() => page.evaluate(() => (window as any).sentMessages.at(-1)?.action)).toBe('RESUME_READING');

		const speedControl = page.getByRole('slider', { name: 'Tốc độ đọc' });
		for (let step = 0; step < 5; step += 1) {
			await speedControl.press('ArrowRight');
		}
		await expect(speedControl).toHaveValue('1.3');
		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as any).sentMessages.some(
						(message: { action: string; payload?: { speed?: number } }) =>
							message.action === 'CHANGE_SPEED' && message.payload?.speed === 1.3,
					),
				),
			)
			.toBe(true);

		await page.evaluate(
			(nextSession) => {
				(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
			},
			{ ...playingSession, status: 'error' },
		);
		await expect(page.getByRole('button', { name: 'Đọc trang hiện tại' })).toBeEnabled();
		await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
		await expect.poll(() => page.evaluate(() => (window as any).sentMessages.at(-1)?.action)).toBe('START_CURRENT_PAGE');
	});
}

test('classic theme transport maps primary and stop actions without exposing fake controls', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: playingSession, currentTabId: 7 });
	await openPopup(page);
	await selectTheme(page, '💿 Vista Aero (2006)');

	const primary = page.getByRole('button', { name: 'Tạm dừng' });
	await primary.click();
	await expect
		.poll(() => page.evaluate(() => (window as any).sentMessages.map((message: { action: string }) => message.action)))
		.toContain('PAUSE_READING');

	await page.getByRole('button', { name: 'Dừng đọc bài' }).click();
	await expect
		.poll(() => page.evaluate(() => (window as any).sentMessages.map((message: { action: string }) => message.action)))
		.toContain('STOP_READING');

	await expect(page.locator('.wmp-artwork')).toHaveAttribute('aria-hidden', 'true');
	await expect(page.getByRole('button', { name: /Previous|Next|Shuffle|Repeat|Fullscreen/i })).toHaveCount(0);
});

test('WMP uses the approved dark Now Playing shell and chrome-blue primary button', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: playingSession, currentTabId: 7 });
	await openPopup(page);
	await selectTheme(page, '💿 Vista Aero (2006)');

	await expect(page.locator('.wmp-titlebar')).toHaveCount(0);
	await expect(page.locator('.wmp-artwork')).toBeVisible();
	await expect(page.locator('.wmp-transport')).toHaveCSS('background-image', /linear-gradient/);
	await expect(page.locator('.wmp-transport .theme-primary')).toHaveCSS('background-image', /radial-gradient/);
	await expect(page.locator('.wmp-transport .theme-primary')).toHaveCSS('border-radius', '50%');
	await expect(page.locator('.wmp-speed-control .form-slider')).toBeVisible();

	const wmpZoneOrder = await page.locator('.app-main').evaluate((main) =>
		Array.from(main.querySelectorAll('.wmp-voice-control, .progress-bar-container, .wmp-transport')).map((element) => ({
			zone: element.matches('.wmp-voice-control') ? 'voice' : element.matches('.progress-bar-container') ? 'progress' : 'transport',
			top: element.getBoundingClientRect().top,
		})),
	);
	expect(wmpZoneOrder.map((zone) => zone.zone)).toEqual(['voice', 'progress', 'transport']);
	expect(wmpZoneOrder[0].top).toBeLessThan(wmpZoneOrder[1].top);
	expect(wmpZoneOrder[1].top).toBeLessThan(wmpZoneOrder[2].top);

	const dimensions = await page
		.locator('body')
		.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test('WMP disables its inherited status-dot animation under reduced motion', async ({ page, openPopup }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await installPopupRuntimeMock(page, { session: playingSession, currentTabId: 7 });
	await openPopup(page);
	await selectTheme(page, '💿 Vista Aero (2006)');

	await expect(page.locator('.app-container[data-theme="wmp12"] .status-dot-pulse')).toHaveCSS('animation-name', 'none');
});

test('theme selector supports keyboard interaction and persists the selected theme', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
	await openPopup(page);

	const selector = page.getByRole('button', { name: 'Chọn giao diện' });
	const winampOption = page.getByRole('button', { name: '🕹️ Classic (1998)' });
	const wmpOption = page.getByRole('button', { name: '💿 Vista Aero (2006)' });

	await expect(page.locator('.app-header .theme-selector-container')).toHaveCount(0);
	await expect(page.locator('.theme-setting .theme-selector-container')).toHaveCount(1);
	await expect(page.locator('.app-section.theme-setting')).toHaveCount(0);
	await expect(page.locator('.selection-button-setting.theme-setting')).toHaveCount(1);
	await expect(page.locator('.selection-button-setting + .theme-setting')).toHaveCount(1);
	await expect(selector).toHaveText('Hiện đại');
	await expect(selector).not.toContainText('🎨');
	await expect(selector).toHaveAttribute('aria-expanded', 'false');
	await selector.hover();
	await expect(selector).toHaveAttribute('aria-expanded', 'false');
	await selector.focus();
	await page.keyboard.press('Enter');
	await expect(selector).toHaveAttribute('aria-expanded', 'true');
	await expect(winampOption).toBeVisible();
	await expect(page.locator('.theme-dropdown')).toHaveCSS('background-color', 'rgb(24, 24, 28)');

	await page.keyboard.press('Escape');
	await expect(selector).toHaveAttribute('aria-expanded', 'false');
	await expect(winampOption).toBeHidden();

	await selector.press('Enter');
	await winampOption.click();
	await expect(selector).toHaveText('Classic (1998)');

	await selector.press('Enter');
	await wmpOption.click();
	await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'wmp12');
	await expect(selector).toBeVisible();
	await expect(selector).toHaveText('Vista Aero (2006)');
	await expect(selector).toHaveAttribute('aria-expanded', 'false');

	const savedTheme = await page.evaluate(async () => {
		const result = await chrome.storage.local.get('readit_active_theme');
		return result.readit_active_theme;
	});
	expect(savedTheme).toBe('wmp12');

	await page.reload();
	await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'wmp12');
});

test('Winamp applies its mechanical chassis background', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: playingSession, currentTabId: 7 });
	await openPopup(page);

	await selectTheme(page, '🕹️ Classic (1998)');
	await expect(page.locator('.app-container')).toHaveCSS('background-image', /repeating-linear-gradient/);
});

test('Winamp uses a mechanical LCD deck and disables meter animation under reduced motion', async ({ page, openPopup }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await installPopupRuntimeMock(page, { session: playingSession, currentTabId: 7 });
	await openPopup(page);
	await selectTheme(page, '🕹️ Classic (1998)');

	await expect(page.locator('.winamp-titlebar')).toHaveCount(0);
	await expect(page.locator('.winamp-visualizer')).toBeVisible();
	await expect(page.locator('.winamp-visualizer')).toHaveAttribute('aria-hidden', 'true');
	await expect(page.locator('.winamp-visualizer .v-bar').first()).toHaveCSS('animation-name', 'none');
	await expect(page.locator('.app-container[data-theme="winamp"] .status-dot-pulse')).toHaveCSS('animation-name', 'none');
	await expect(page.locator('.winamp-deck')).toHaveCSS('background-color', 'rgb(30, 30, 32)');
	await expect(page.locator('.winamp-deck .theme-primary')).toHaveCSS('border-radius', '0px');
	await expect(page.locator('.app-container[data-theme="winamp"] .status-display')).toHaveCSS('background-color', 'rgb(2, 3, 3)');
});

test('selection button setting defaults on, persists, and stays before the footer in every theme', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
	await openPopup(page);

	const toggle = page.getByRole('checkbox', { name: 'Hiện nút đọc cạnh văn bản đã chọn' });
	await expect(toggle).toBeChecked();
	await expect(page.locator('.selection-button-setting + .app-footer')).toHaveCount(1);

	for (const label of ['🕹️ Classic (1998)', '💿 Vista Aero (2006)', '📱 Hiện đại']) {
		await selectTheme(page, label);
		await expect(toggle).toBeVisible();
		await expect(page.locator('.selection-button-setting + .app-footer')).toHaveCount(1);
	}

	await toggle.uncheck();
	expect(
		await page.evaluate(
			async () => (await chrome.storage.local.get('readit_selection_button_enabled')).readit_selection_button_enabled,
		),
	).toBe(false);
	await page.reload();
	await expect(page.getByRole('checkbox', { name: 'Hiện nút đọc cạnh văn bản đã chọn' })).not.toBeChecked();
});

test.describe('English popup locale', () => {
	test.use({ browserLocale: 'en-US' });

	test('translates visible popup content and accessibility labels', async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, {
			session: { ...playingSession, status: 'loading' },
			currentTabId: 7,
		});
		await openPopup(page);

		await expect(page.getByRole('button', { name: 'Select Theme' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Open Side Panel' })).toBeVisible();
		await expect(page.locator('.status-text')).toHaveText('Preparing voice...');
		await expect(page.locator('.session-context')).toContainText('Paragraph 1/5 • 20%');
		await expect(page.locator('.session-context')).toContainText('Reading in this tab');
		await expect(page.getByRole('note')).toContainText('Content is processed on your device and is not sent to a server.');
		await expect(page.getByRole('link', { name: 'Learn more' })).toBeVisible();
		await expect(page.locator('.form-select option').first()).toHaveText('♂️ Male 1 (Deep)');
		await expect(page.getByRole('link', { name: 'Buy me a coffee' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Feedback' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
		await expect(page.getByRole('checkbox', { name: 'Show read button for selected text' })).toBeChecked();

		await page.evaluate(() => {
			(window as any).mockReceiveMessage({
				action: 'MODEL_LOADING_PROGRESS',
				progress: { loaded: 50, total: 100, modelName: 'Duration Predictor' },
			});
		});
		await expect(page.locator('.status-text')).toHaveText('Loading model: Duration Predictor (50%)');

		await page.evaluate(() => {
			(window as any).mockReceiveMessage({ action: 'MODEL_LOAD_FAILED' });
		});
		await expect(page.locator('.alert-danger')).toHaveText('Unable to load model: Unknown error');
	});
});
