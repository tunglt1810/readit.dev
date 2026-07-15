import { expect, installPopupRuntimeMock, test } from './fixtures';

const playingSession = {
	sessionId: 'theme-session',
	tabId: 7,
	title: 'Theme article',
	url: 'https://example.com/theme-article',
	lang: 'en',
	status: 'playing' as const,
	currentParagraphIndex: 0,
	totalParagraphs: 5,
	progressPercentage: 20,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

test('theme selector supports keyboard interaction and persists the selected theme', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
	await openPopup(page);

	const selector = page.getByRole('button', { name: 'Chọn giao diện' });
	const winampOption = page.getByRole('button', { name: '🕹️ Classic (1998)' });

	await expect(selector).toHaveAttribute('aria-expanded', 'false');
	await selector.focus();
	await page.keyboard.press('Enter');
	await expect(selector).toHaveAttribute('aria-expanded', 'true');
	await expect(winampOption).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(selector).toHaveAttribute('aria-expanded', 'false');
	await expect(winampOption).toBeHidden();

	await selector.press('Enter');
	await winampOption.click();
	await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'winamp');
	await expect(selector).toHaveAttribute('aria-expanded', 'false');

	const savedTheme = await page.evaluate(async () => {
		const result = await chrome.storage.local.get('readit_active_theme');
		return result.readit_active_theme;
	});
	expect(savedTheme).toBe('winamp');

	await page.reload();
	await expect(page.locator('.app-container')).toHaveAttribute('data-theme', 'winamp');
});

test('classic themes apply their backgrounds and WMP12 emphasizes Play/Pause', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: playingSession, currentTabId: 7 });
	await openPopup(page);

	const selector = page.getByRole('button', { name: 'Chọn giao diện' });
	await selector.hover();
	await page.getByRole('button', { name: '🕹️ Classic (1998)' }).click();
	await expect(page.locator('.app-container')).toHaveCSS('background-color', 'rgb(40, 40, 43)');

	await selector.hover();
	await page.getByRole('button', { name: '💿 Vista Aero (2006)' }).click();
	await expect(page.locator('.app-container')).toHaveCSS('background-image', /radial-gradient/);

	const pauseButton = page.getByRole('button', { name: 'Tạm dừng' });
	const stopButton = page.getByRole('button', { name: 'Dừng đọc bài' });
	await expect(pauseButton).toHaveCSS('background-image', /radial-gradient/);
	await expect(stopButton).toHaveCSS('width', '34px');
	await expect(stopButton).toHaveCSS('height', '34px');
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
		await expect(page.locator('.status-text')).toHaveText('Preparing voice...');
		await expect(page.locator('.session-context')).toContainText('Paragraph 1/5 • 20%');
		await expect(page.locator('.session-context')).toContainText('Reading in this tab');
		await expect(page.getByRole('note')).toContainText('Content is processed on your device and is not sent to a server.');
		await expect(page.getByRole('link', { name: 'Learn more' })).toBeVisible();
		await expect(page.locator('.form-select option').first()).toHaveText('♂️ Male 1 (Deep)');
		await expect(page.getByRole('link', { name: 'Buy me a coffee' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Feedback' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();

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
