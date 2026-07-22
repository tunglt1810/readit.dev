import type { PlaybackSessionSnapshot, ThemeName } from '../../src/shared/types';
import { expect, installExtensionUiRuntimeMock, test } from './fixtures';

const pageInfo = {
	available: true as const,
	title: 'Bài viết thử nghiệm',
	url: 'https://example.com/articles/readit',
	lang: 'vi',
};

const DRAFT_SENTINEL = 'READIT_PRIVATE_DRAFT_7f9b16c2_DO_NOT_PERSIST';

test('matches the popup support header with identity, version, and Coffee', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	const header = page.locator('.side-panel-header');
	const expectedVersion = await page.evaluate(() => `v${chrome.runtime.getManifest().version}`);
	const coffee = header.getByRole('link', { name: 'Ủng hộ tôi một ly cà phê' });

	await expect(header.locator(':scope > h1 + .extension-version + .header-support-link')).toHaveCount(1);
	await expect(header.locator('h1')).toHaveText('readit.dev');
	await expect(header.locator('.extension-version')).toHaveText(expectedVersion);
	await expect(coffee).toHaveAttribute('href', 'https://buymeacoffee.com/bbeeezzzzz');
	await expect(coffee).toHaveAttribute('target', '_blank');
	await expect(coffee).toHaveAttribute('rel', 'noreferrer');
});

const manualSession: PlaybackSessionSnapshot = {
	sessionId: 'manual-session',
	contentScope: 'manual',
	source: { kind: 'manual' },
	lang: 'vi',
	status: 'playing',
	currentParagraphIndex: 0,
	totalParagraphs: 2,
	progressPercentage: 25,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

test('orders current-page reading before a document-local manual draft', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	const currentPageButton = page.getByRole('button', { name: 'Đọc trang hiện tại' });
	const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
	const currentPageBox = await currentPageButton.boundingBox();
	const textboxBox = await textbox.boundingBox();
	expect(currentPageBox?.y).toBeLessThan(textboxBox?.y ?? 0);

	const language = page.getByRole('combobox', { name: 'Ngôn ngữ văn bản' });
	await expect(language).toHaveValue('auto');
	expect(await language.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(
		['auto', 'en', 'vi', 'zh'],
	);
	await expect(page.getByRole('button', { name: 'Đọc văn bản đã dán' })).toBeDisabled();

	const draft = 'Xin chào\n\nĐây là đoạn thứ hai.';
	await textbox.fill(draft);
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({
		action: 'START_MANUAL_TEXT',
		payload: { text: draft, language: 'auto' },
	});
	await expect(textbox).toHaveValue(draft);
});

test('clear affects only the draft and reload discards it while playback hydrates', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
	await textbox.fill('Nội dung riêng tư chỉ ở document hiện tại.');
	await page.getByRole('button', { name: 'Xóa' }).click();
	await expect(textbox).toHaveValue('');
	expect(await page.evaluate(() => (window as any).sentMessages.some((message: any) => message.action === 'STOP_READING'))).toBe(false);

	await textbox.fill(DRAFT_SENTINEL);
	await page.evaluate((session) => {
		(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session });
	}, manualSession);
	await expect(page.locator('.session-title')).toHaveText('Văn bản đã dán');
	await expect(page.locator('.session-host')).toHaveCount(0);

	await page.reload();
	await expect(textbox).toHaveValue('');
	await expect(page.locator('.session-title')).toHaveText('Văn bản đã dán');
	await expect(page.locator('.status-display')).toContainText('Đang đọc đoạn 1/2');

	const stored = await page.evaluate(async () => {
		const readWebStorage = (storage: Storage) =>
			Array.from({ length: storage.length }, (_, index) => {
				const key = storage.key(index) ?? '';
				return [key, storage.getItem(key)];
			});
		return {
			chromeLocal: await chrome.storage.local.get(null),
			chromeSession: await chrome.storage.session.get(null),
			windowLocal: readWebStorage(window.localStorage),
			windowSession: readWebStorage(window.sessionStorage),
		};
	});
	expect(JSON.stringify(stored)).not.toContain(DRAFT_SENTINEL);
});

test('shows advisory page metadata and resolves reading through START_CURRENT_PAGE', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	await expect(page.locator('.page-info strong')).toHaveText('Bài viết thử nghiệm');
	await expect(page.locator('.page-info')).toContainText('example.com · vi');
	await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
	expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({ action: 'START_CURRENT_PAGE' });
});

test('sends pause, resume, and stop through the shared playback coordinator', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: manualSession }, pageInfo);
	await openSidePanel(page);

	await page.getByRole('button', { name: 'Tạm dừng' }).click();
	await page.evaluate((session) => {
		(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: { ...session, status: 'paused' } });
	}, manualSession);
	await page.getByRole('button', { name: 'Tiếp tục' }).click();
	await page.getByRole('button', { name: 'Dừng đọc bài' }).click();

	const actions = await page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action));
	expect(actions).toEqual(expect.arrayContaining(['PAUSE_READING', 'RESUME_READING', 'STOP_READING']));
});

test('maps invalid manual text errors to the localized message', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await page.evaluate(() => {
		(window as any).commandResponses = { START_MANUAL_TEXT: { success: false, error: 'invalidManualText' } };
	});

	await page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' }).fill('Nội dung');
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	await expect(page.getByRole('alert')).toHaveText('Hãy nhập văn bản cần đọc.');
});

test('prioritizes a manual-start transport error over an invalid-text response code', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await page.evaluate(() => {
		(window as any).commandResponses = {
			START_MANUAL_TEXT: { success: false, transportError: true, error: 'invalidManualText' },
		};
	});

	const draft = 'Bản nháp còn nguyên khi transport thất bại.';
	const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
	await textbox.fill(draft);
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	await expect(page.getByRole('alert')).toHaveText('Không thể bắt đầu đọc trang này. Vui lòng thử lại.');
	await expect(textbox).toHaveValue(draft);
});

test('shows a localized start failure without clearing the draft when the runtime returns no response', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await page.evaluate(() => {
		(window as any).missingResponseActions = ['START_MANUAL_TEXT'];
	});

	const draft = 'Bản nháp vẫn còn sau lỗi transport.';
	const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
	await textbox.fill(draft);
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	await expect(page.getByRole('alert')).toHaveText('Không thể bắt đầu đọc trang này. Vui lòng thử lại.');
	await expect(textbox).toHaveValue(draft);
});

test('shows unavailable current-page metadata when the runtime returns no response', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null });
	await openSidePanel(page);

	await expect(page.getByText('Không thể đọc trang hiện tại')).toBeVisible();
	await expect(page.locator('.page-info')).toHaveCount(0);
});

test('hydrates and persists shared voice and speed preferences', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await page.evaluate(async () => {
		await chrome.storage.local.set({ readit_active_voice: 'F2', readit_speed: 1.3 });
	});
	await page.reload();

	const voice = page.getByRole('combobox', { name: 'Chọn giọng (Supertonic 3)' });
	const speed = page.getByRole('slider', { name: 'Tốc độ đọc' });
	await expect(voice).toHaveValue('F2');
	await expect(speed).toHaveValue('1.3');
	await voice.selectOption('F1');
	await speed.fill('1.4');

	await expect
		.poll(() => page.evaluate(async () => (await chrome.storage.local.get('readit_active_voice')).readit_active_voice))
		.toBe('F1');
	await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('readit_speed')).readit_speed)).toBe(1.4);
	expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({
		action: 'CHANGE_SPEED',
		payload: { speed: 1.4 },
	});
});

test('live-syncs voice and speed when the popup updates shared preferences', async ({ context, openPopup, openSidePanel, page }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	const sidePanelVoice = page.getByRole('combobox', { name: 'Chọn giọng (Supertonic 3)' });
	const sidePanelSpeed = page.getByRole('slider', { name: 'Tốc độ đọc' });
	const popup = await context.newPage();
	try {
		await installExtensionUiRuntimeMock(popup, { session: null, currentTabId: 7 });
		await openPopup(popup);

		await popup.locator('.form-select').selectOption('F2');
		await popup.locator('.form-slider').fill('1.3');

		await expect(sidePanelVoice).toHaveValue('F2');
		await expect(sidePanelSpeed).toHaveValue('1.3');
	} finally {
		await popup.close();
	}
});

for (const theme of ['default', 'winamp', 'wmp12'] as ThemeName[]) {
	test(`keeps the Side Panel readable, focused, and ordered in the ${theme} theme`, async ({ page, openSidePanel }) => {
		await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
		await openSidePanel(page);
		await page.evaluate(async (selectedTheme) => {
			await chrome.storage.local.set({ readit_active_theme: selectedTheme });
		}, theme);
		await page.reload();

		const panel = page.getByRole('main', { name: 'readit.dev Side Panel' });
		const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
		await expect(panel).toHaveAttribute('data-theme', theme);
		await textbox.focus();
		await expect(textbox).toHaveCSS('outline-style', 'solid');
		expect(
			await textbox.evaluate((element) => {
				const style = getComputedStyle(element);
				return style.color !== style.backgroundColor;
			}),
		).toBe(true);
		const currentPageBox = await page.getByRole('button', { name: 'Đọc trang hiện tại' }).boundingBox();
		const textboxBox = await textbox.boundingBox();
		expect(currentPageBox?.y).toBeLessThan(textboxBox?.y ?? 0);
		await expect(page.locator('.side-panel-player')).toHaveCSS('position', 'sticky');
	});
}
