import { normalizeVietnameseText } from '../../src/offscreen/vietnamese/normalizer';
import type { NormalizationDependencies } from '../../src/offscreen/vietnamese/types';
import type { PlaybackSessionSnapshot, ThemeName } from '../../src/shared/types';
import { expect, installExtensionUiRuntimeMock, test } from './fixtures';

const pageInfo = {
	available: true as const,
	title: 'Bài viết thử nghiệm',
	url: 'https://example.com/articles/readit',
	lang: 'vi',
};

const DRAFT_SENTINEL = 'READIT_PRIVATE_DRAFT_7f9b16c2_DO_NOT_PERSIST';
const MIXED_MARKDOWN_TEXT =
	'**Channel Activity Analysis (4.6.6):** Phân tích hoạt động kênh để hỗ trợ phát triển quan hệ. **Ví dụ sử dụng trong tài liệu khớp hoàn toàn với yêu cầu này**: Khách hàng đăng ký online thất bại/gián đoạn sẽ được ghi nhận để chuyển thông tin cho RM liên hệ hỗ trợ kịp thời';

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
	readableSurface: 'manual-reader',
	source: { kind: 'manual', panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' },
	lang: 'vi',
	status: 'playing',
	currentParagraphIndex: 0,
	totalParagraphs: 2,
	progressPercentage: 25,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

const documentSession: PlaybackSessionSnapshot = {
	sessionId: 'document-session',
	contentScope: 'article',
	readableSurface: 'document-reader',
	source: { kind: 'tab', tabId: 42, title: 'Tài liệu thử nghiệm', url: 'https://docs.google.com/document/d/test/edit' },
	lang: 'vi',
	status: 'playing',
	currentParagraphIndex: 0,
	totalParagraphs: 2,
	progressPercentage: 25,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

test('offers the full Document Reader for a document session', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: documentSession }, pageInfo);
	await openSidePanel(page);

	await page.getByRole('button', { name: 'Mở trình đọc toàn màn hình' }).click();
	expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({ action: 'OPEN_DOCUMENT_READER' });
});

test('hides the full Reader outside document sessions and localizes open failures', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await expect(page.getByRole('button', { name: 'Mở trình đọc toàn màn hình' })).toHaveCount(0);

	await page.evaluate((nextSession) => {
		(window as any).commandResponses = { OPEN_DOCUMENT_READER: { success: false, error: 'documentReaderOpenFailed' } };
		(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
	}, documentSession);
	await page.getByRole('button', { name: 'Mở trình đọc toàn màn hình' }).click();
	await expect(page.getByRole('alert')).toHaveText('Không thể mở trình đọc toàn màn hình. Âm thanh vẫn tiếp tục.');
});

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
		payload: { text: draft, language: 'auto', panelInstanceId: expect.any(String) },
	});
	await expect(page.getByRole('textbox', { name: 'Văn bản đang đọc' })).toHaveText(draft);
	await expect(textbox).toHaveCount(0);
});

test('locks the reader and highlights manual words without the webpage highlight setting', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	await page.evaluate(async () => {
		await chrome.storage.local.set({ readit_word_highlight_enabled: false });
	});
	await page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' }).fill('The cat saw the cat.');
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	const startPayload = await page.evaluate(() => (window as any).sentMessages.at(-1).payload);
	await page.evaluate(
		({ panelInstanceId, session }) => {
			(window as any).mockReceiveMessage({
				action: 'PLAYBACK_STATE_UPDATE',
				session: { ...session, source: { kind: 'manual', panelInstanceId } },
			});
			const event = { action: 'MANUAL_WORD_HIGHLIGHT_UPDATE', sessionId: session.sessionId, word: 'cat', wordIndex: 1 };
			(window as any).mockReceiveMessage(event);
			(window as any).mockReceiveMessage(event);
		},
		{ panelInstanceId: startPayload.panelInstanceId, session: manualSession },
	);

	const reader = page.getByRole('textbox', { name: 'Văn bản đang đọc' });
	await expect(reader).toHaveAttribute('aria-readonly', 'true');
	await expect(reader.locator('.manual-reader-active-word')).toHaveText('cat');

	await page.evaluate((sessionId) => {
		(window as any).mockReceiveMessage({ action: 'MANUAL_WORD_HIGHLIGHT_CLEAR', sessionId });
	}, manualSession.sessionId);
	await expect(reader.locator('mark')).toHaveCount(0);

	await page.evaluate((session) => {
		(window as any).mockReceiveMessage({
			action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
			sessionId: session.sessionId,
			word: 'cat',
			wordIndex: 1,
		});
	}, manualSession);
	await expect(reader.locator('.manual-reader-active-word')).toHaveText('cat');
});

test('highlights the first word when the normalizer rejects a multi-word abbreviation span', async ({ page, openSidePanel }) => {
	const dependencies: NormalizationDependencies = {
		assets: {
			detector: {
				detect(tokens) {
					const start = tokens.findIndex((token) => token.text === 'Channel');
					const end = tokens.findIndex((token) => token.text === '4.6');
					return tokens.map((_token, index) => (index === start ? 'B-LABB' : index > start && index < end ? 'I-LABB' : 'O'));
				},
			},
			vietnameseSyllables: new Set(),
			abbreviations: new Map(),
			abbreviationScorer: null,
			confidenceThreshold: 0.54,
			confidenceMargin: 0.08,
		},
		now: () => 0,
	};
	const normalized = await normalizeVietnameseText(MIXED_MARKDOWN_TEXT, dependencies);
	const firstWord = normalized.wordMap[0]?.originalText;
	expect(firstWord).toBe('Channel');

	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' }).fill(MIXED_MARKDOWN_TEXT);
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	const startPayload = await page.evaluate(() => (window as any).sentMessages.at(-1).payload);
	await page.evaluate(
		({ panelInstanceId, session, word }) => {
			(window as any).mockReceiveMessage({
				action: 'PLAYBACK_STATE_UPDATE',
				session: { ...session, source: { kind: 'manual', panelInstanceId } },
			});
			(window as any).mockReceiveMessage({
				action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
				sessionId: session.sessionId,
				word,
				wordIndex: 0,
			});
		},
		{ panelInstanceId: startPayload.panelInstanceId, session: manualSession, word: firstWord },
	);

	await expect(page.getByRole('textbox', { name: 'Văn bản đang đọc' }).locator('.manual-reader-active-word')).toHaveText('Channel');
});

test('pagehide stops owned audio and reload restores an empty draft', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
	await textbox.fill(DRAFT_SENTINEL);
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	const panelInstanceId = await page.evaluate(() => (window as any).sentMessages.at(-1).payload.panelInstanceId);
	await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
	expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({
		action: 'STOP_SIDE_PANEL_AUDIO',
		panelInstanceId,
	});

	await page.reload();
	await expect(page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' })).toHaveValue('');
	await expect(page.getByRole('textbox', { name: 'Văn bản đang đọc' })).toHaveCount(0);
});

test('keeps the reader locked with explicit editor resume and discard controls while web audio is active', async ({
	page,
	openSidePanel,
}) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	const textbox = page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' });
	await textbox.fill('Resume this editor text.');
	await page.getByRole('button', { name: 'Đọc văn bản đã dán' }).click();
	const panelInstanceId = await page.evaluate(() => (window as any).sentMessages.at(-1).payload.panelInstanceId);
	await page.evaluate((owner) => {
		(window as any).mockReceiveMessage({ action: 'MANUAL_CHECKPOINT_STATE_UPDATE', panelInstanceId: owner, state: 'suspended' });
	}, panelInstanceId);

	await expect(page.getByText('Đọc trong editor đã tạm dừng để đọc web.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Tiếp tục đọc trong editor' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Dừng đọc trong editor' })).toBeVisible();
	await page.getByRole('button', { name: 'Tiếp tục đọc trong editor' }).click();
	expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({
		action: 'RESUME_MANUAL_CHECKPOINT',
		panelInstanceId,
	});
	await page.getByRole('button', { name: 'Dừng đọc trong editor' }).click();
	expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({
		action: 'DISCARD_MANUAL_CHECKPOINT',
		panelInstanceId,
	});
	await expect(page.getByRole('textbox', { name: 'Dán hoặc nhập nội dung cần đọc' })).toHaveValue('Resume this editor text.');
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

	const player = page.locator('.manual-text-card');
	await player.getByRole('button', { name: 'Tạm dừng' }).click();
	await page.evaluate((session) => {
		(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: { ...session, status: 'paused' } });
	}, manualSession);
	await player.getByRole('button', { name: 'Tiếp tục' }).click();
	await player.getByRole('button', { name: 'Dừng đọc bài' }).click();

	const actions = await page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action));
	expect(actions).toEqual(expect.arrayContaining(['PAUSE_READING', 'RESUME_READING', 'STOP_READING']));
});

test('renders SVG playback icons for page action and player controls', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: manualSession }, pageInfo);
	await openSidePanel(page);

	await expect(page.locator('.current-page-card .btn-read svg')).toBeVisible();
	await expect(page.locator('.manual-text-card .playback-controls svg')).toHaveCount(2);
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
	await page.locator('.settings-card-header').click();

	const voice = page.getByRole('combobox', { name: 'Giọng đọc' });
	const speed = page.getByRole('slider', { name: 'Tốc độ' });
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
	await page.locator('.settings-card-header').click();

	const sidePanelVoice = page.getByRole('combobox', { name: 'Giọng đọc' });
	const sidePanelSpeed = page.getByRole('slider', { name: 'Tốc độ' });
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
	});
}

test('auto-focuses the primary action button when side panel opens', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	const currentPageButton = page.getByRole('button', { name: 'Đọc trang hiện tại' });
	await expect(currentPageButton).toBeFocused();
});

test('localizes Google Docs current-page export failures', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);
	await page.evaluate(() => {
		(window as any).commandResponses = {
			START_CURRENT_PAGE: { success: false, error: 'googleDocsExportUnavailable' },
		};
	});

	await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
	await expect(
		page.getByText('Không thể đọc Google Docs này. Hãy kiểm tra quyền xem hoặc tải xuống, hoặc đọc văn bản đã chọn/dán.'),
	).toBeVisible();
});

test('verifies keyboard navigation and hover states for page card and bottom player controls', async ({ page, openSidePanel }) => {
	await installExtensionUiRuntimeMock(page, { session: manualSession }, pageInfo);
	await openSidePanel(page);

	// Nút Đọc trang hiện tại: hover và keyboard focus
	const readPageBtn = page.locator('.current-page-card .btn-read');
	await expect(readPageBtn).toBeVisible();
	await readPageBtn.hover();
	await expect(readPageBtn).toHaveCSS('cursor', 'pointer');
	await expect(readPageBtn.locator('svg')).toBeVisible();

	// Player controls nút Tạm dừng: focus, hover và nhấn phím Space
	const playerSection = page.locator('.manual-text-card');
	const pauseBtn = playerSection.getByRole('button', { name: 'Tạm dừng' });
	await expect(pauseBtn).toBeVisible();
	await expect(pauseBtn).toHaveAttribute('title', 'Tạm dừng');
	await expect(pauseBtn.locator('svg')).toBeVisible();
	await pauseBtn.hover();
	await expect(pauseBtn).toHaveCSS('cursor', 'pointer');
	await pauseBtn.focus();
	await expect(pauseBtn).toBeFocused();

	// Dừng đọc bài button
	const stopBtn = playerSection.getByRole('button', { name: 'Dừng đọc bài' });
	await expect(stopBtn).toBeVisible();
	await expect(stopBtn).toHaveAttribute('title', 'Dừng đọc bài');
	await expect(stopBtn.locator('svg')).toBeVisible();
	await stopBtn.hover();
	await expect(stopBtn).toHaveCSS('cursor', 'pointer');

	// Kích hoạt Tạm dừng bằng phím Space
	await page.keyboard.press('Space');
	const actions = await page.evaluate(() => (window as any).sentMessages.map((m: any) => m.action));
	expect(actions).toContain('PAUSE_READING');
});

for (const theme of ['default', 'winamp', 'wmp12'] as ThemeName[]) {
	test(`renders SVG playback icons and supports keyboard navigation for player controls in ${theme} theme`, async ({
		page,
		openSidePanel,
	}) => {
		await installExtensionUiRuntimeMock(page, { session: manualSession }, pageInfo);
		await openSidePanel(page);
		await page.evaluate(async (selectedTheme) => {
			await chrome.storage.local.set({ readit_active_theme: selectedTheme });
		}, theme);
		await page.reload();

		// Player section inside manual-text-card
		const playerSection = page.locator('.manual-text-card');
		await expect(playerSection).toBeVisible();
		await expect(playerSection.locator('.playback-controls svg')).toHaveCount(2);

		const pauseBtn = playerSection.getByRole('button', { name: 'Tạm dừng' });
		const stopBtn = playerSection.getByRole('button', { name: 'Dừng đọc bài' });

		await expect(pauseBtn).toBeVisible();
		await expect(stopBtn).toBeVisible();

		// Thử kích hoạt nút Dừng đọc bài bằng phím Enter trong giao diện theme
		await stopBtn.focus();
		await page.keyboard.press('Enter');
		const actions = await page.evaluate(() => (window as any).sentMessages.map((m: any) => m.action));
		expect(actions).toContain('STOP_READING');
	});
}

test.describe('Side Panel Localization - English (en-US)', () => {
	test.use({ browserLocale: 'en-US' });

	test('renders all Side Panel UI elements accurately in English locale', async ({ page, openSidePanel }) => {
		await installExtensionUiRuntimeMock(page, { session: manualSession }, pageInfo);
		await openSidePanel(page);

		// Header
		await expect(page.locator('.header-support-link')).toContainText('Buy me a coffee');

		// Current Page Card
		await expect(page.getByRole('heading', { name: 'Current page' })).toBeVisible();
		await expect(page.locator('.current-page-card .btn-read')).toBeVisible();

		// Paste text section
		await expect(page.getByRole('heading', { name: 'Or paste text' })).toBeVisible();
		await expect(page.locator('.paste-divider')).toHaveText('Or paste text');
		await expect(page.locator('.manual-meta')).toContainText('Text is processed only on this device.');
		await expect(page.locator('.manual-meta')).toContainText('characters');
		await expect(page.locator('.field-label')).toContainText('Text language');
		await expect(page.getByRole('button', { name: 'Clear' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Read pasted text' })).toBeVisible();

		// Player Section inside manual-text-card
		await expect(page.locator('.manual-text-card').getByRole('button', { name: 'Pause' })).toBeVisible();
		await expect(page.locator('.manual-text-card').getByRole('button', { name: 'Stop reading' })).toBeVisible();

		// Verify no raw key fallbacks
		const rawFallbackKeys = [
			'currentPage',
			'readPage',
			'orPasteText',
			'pasteTextPlaceholder',
			'readPastedText',
			'clearText',
			'manualLanguage',
			'textProcessedLocally',
			'nowPlaying',
			'stopReading',
			'pauseState',
		];
		for (const key of rawFallbackKeys) {
			await expect(page.locator(`text="${key}"`)).toHaveCount(0);
		}
	});
});

test.describe('Side Panel Localization - Vietnamese (vi-VN)', () => {
	test.use({ browserLocale: 'vi-VN' });

	test('renders all Side Panel UI elements accurately in Vietnamese locale', async ({ page, openSidePanel }) => {
		await installExtensionUiRuntimeMock(page, { session: manualSession }, pageInfo);
		await openSidePanel(page);

		// Header
		await expect(page.locator('.header-support-link')).toContainText('Ủng hộ tôi một ly cà phê');

		// Current Page Card
		await expect(page.getByRole('heading', { name: 'Trang hiện tại' })).toBeVisible();
		await expect(page.locator('.current-page-card .btn-read')).toBeVisible();

		// Paste text section
		await expect(page.getByRole('heading', { name: 'Hoặc dán văn bản' })).toBeVisible();
		await expect(page.locator('.paste-divider')).toHaveText('Hoặc dán văn bản');
		await expect(page.locator('.manual-meta')).toContainText('Nội dung chỉ được xử lý trên thiết bị.');
		await expect(page.locator('.manual-meta')).toContainText('ký tự');
		await expect(page.locator('.field-label')).toContainText('Ngôn ngữ văn bản');
		await expect(page.getByRole('button', { name: 'Xóa' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Đọc văn bản đã dán' })).toBeVisible();

		// Player Section inside manual-text-card
		await expect(page.locator('.manual-text-card').getByRole('button', { name: 'Tạm dừng' })).toBeVisible();
		await expect(page.locator('.manual-text-card').getByRole('button', { name: 'Dừng đọc bài' })).toBeVisible();

		// Verify no raw key fallbacks
		const rawFallbackKeys = [
			'currentPage',
			'readPage',
			'orPasteText',
			'pasteTextPlaceholder',
			'readPastedText',
			'clearText',
			'manualLanguage',
			'textProcessedLocally',
			'nowPlaying',
			'stopReading',
			'pauseState',
		];
		for (const key of rawFallbackKeys) {
			await expect(page.locator(`text="${key}"`)).toHaveCount(0);
		}
	});
});

test('verifies UI layout fixes: compact status display pill, standard read-page primary button, and consistent theme background', async ({
	page,
	openSidePanel,
}) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	// 1. Status display in Side Panel is a compact fit-content pill without full-width stretching
	const statusDisplay = page.locator('.current-page-card .status-display');
	await expect(statusDisplay).toBeVisible();
	const statusBox = await statusDisplay.boundingBox();
	const cardBox = await page.locator('.current-page-card').boundingBox();
	expect(statusBox && cardBox && statusBox.width < cardBox.width * 0.8).toBe(true);

	// 2. Button at Current Page is a compact circular button (.btn-icon-only.btn-read) without text label
	const readPageBtn = page.getByRole('button', { name: 'Đọc trang hiện tại' });
	await expect(readPageBtn).toBeVisible();
	await expect(readPageBtn).toHaveClass(/btn-icon-only/);
	await expect(readPageBtn).toHaveClass(/btn-read/);
	await expect(readPageBtn).not.toHaveClass(/btn-read-page/);
	await expect(readPageBtn).toHaveText('');

	const btnBox = await readPageBtn.boundingBox();
	expect(btnBox && Math.abs(btnBox.width - btnBox.height) < 2).toBe(true);

	const btnSvg = readPageBtn.locator('svg');
	await expect(btnSvg).toBeVisible();

	// 3. Theme color consistency: side panel background has radial-gradient
	const sidePanel = page.locator('.side-panel');
	await expect(sidePanel).toHaveCSS('background-image', /radial-gradient/);
});

for (const [theme, expectedColor] of [
	['default', 'rgb(9, 159, 181)'],
	['winamp', 'rgb(143, 223, 83)'],
	['wmp12', 'rgb(86, 198, 251)'],
] as const) {
	test(`synchronizes title logo span (.dev) color in Side Panel header for ${theme} theme`, async ({ page, openSidePanel }) => {
		await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
		await openSidePanel(page);
		await page.evaluate(async (selectedTheme) => {
			await chrome.storage.local.set({ readit_active_theme: selectedTheme });
		}, theme);
		await page.reload();

		const logoSpan = page.locator('.side-panel-header h1 span');
		await expect(logoSpan).toBeVisible();
		await expect(logoSpan).toHaveCSS('color', expectedColor);
	});
}

test('shows session meta and playback controls in current-page-card during an active tab session, and page info when stopped', async ({
	page,
	openSidePanel,
}) => {
	// 1. Tab session active: session-meta and playback-controls in current-page-card should be visible, page-info hidden
	const tabSession: PlaybackSessionSnapshot = {
		...manualSession,
		source: { kind: 'tab', tabId: 7, title: 'Web Article', url: 'https://example.com/article' },
	};
	await installExtensionUiRuntimeMock(page, { session: tabSession }, pageInfo);
	await openSidePanel(page);

	await expect(page.locator('.current-page-card .session-meta')).toBeVisible();
	await expect(page.locator('.current-page-card .playback-controls')).toBeVisible();
	await expect(page.locator('.current-page-card .page-info')).not.toBeVisible();

	// 2. Stopped session: page-info and read button in current-page-card should be visible, session-meta hidden
	await page.evaluate(() => {
		(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: null });
	});
	await expect(page.locator('.current-page-card .page-info')).toBeVisible();
	await expect(page.locator('.current-page-card .btn-read')).toBeVisible();
	await expect(page.locator('.current-page-card .session-meta')).not.toBeVisible();
});

test('popup toggle button syncs active state and self-heals by opening side panel when close fails', async ({ page, openPopup }) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openPopup(page);
	await page.evaluate(async () => {
		await chrome.storage.local.set({ readit_open_sidepanel_windows: [7] });
		(window as any).commandResponses = { CLOSE_SIDEPANEL: { success: false, reason: 'NOT_FOUND' } };
	});

	const sidePanelButton = page.locator('.btn-icon-sidepanel');
	await expect(sidePanelButton).toHaveClass(/active/);
	await expect(sidePanelButton).toHaveAttribute('aria-pressed', 'true');

	// Click toggle button: CLOSE_SIDEPANEL returns success: false -> fallback opens side panel directly
	await sidePanelButton.click();
	expect(await page.evaluate(() => (window as any).sidePanelOpenCalls)).toEqual([{ windowId: 7 }]);
});

test('registers sidepanel window ID when sidepanel mounts and syncs active status to popup toggle button', async ({
	context,
	openPopup,
	openSidePanel,
	page,
}) => {
	await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
	await openSidePanel(page);

	const popup = await context.newPage();
	try {
		await installExtensionUiRuntimeMock(popup, { session: null, currentTabId: 7 });
		await openPopup(popup);

		// Evaluate storage update as executed by background when sidepanel is open for window 7
		await popup.evaluate(async () => {
			await chrome.storage.local.set({ readit_open_sidepanel_windows: [7] });
		});

		const popupSidePanelBtn = popup.locator('.btn-icon-sidepanel');
		await expect(popupSidePanelBtn).toHaveClass(/active/);
		await expect(popupSidePanelBtn).toHaveAttribute('aria-pressed', 'true');
	} finally {
		await popup.close();
	}
});

test('multi-window isolation: popup shows active sidepanel button in window A (open) and inactive in window B (closed)', async ({
	context,
	openPopup,
}) => {
	// Window A (windowId: 7) where Side Panel IS open
	const popupWinA = await context.newPage();
	await installExtensionUiRuntimeMock(popupWinA, { session: null, currentTabId: 7 });
	await openPopup(popupWinA);
	await popupWinA.evaluate(async () => {
		await chrome.storage.local.set({ readit_open_sidepanel_windows: [7] });
	});

	const btnWinA = popupWinA.locator('.btn-icon-sidepanel');
	await expect(btnWinA).toHaveClass(/active/);
	await expect(btnWinA).toHaveAttribute('aria-pressed', 'true');

	// Window B (windowId: 20) where Side Panel is NOT open (only window 7 has open sidepanel)
	const popupWinB = await context.newPage();
	await popupWinB.addInitScript(() => {
		(window as any).mockWindowId = 20;
	});
	await installExtensionUiRuntimeMock(popupWinB, { session: null, currentTabId: 20 });
	await openPopup(popupWinB);
	await popupWinB.evaluate(async () => {
		await chrome.storage.local.set({ readit_open_sidepanel_windows: [7] });
	});

	const btnWinB = popupWinB.locator('.btn-icon-sidepanel');
	await expect(btnWinB).not.toHaveClass(/active/);
	await expect(btnWinB).toHaveAttribute('aria-pressed', 'false');

	await popupWinA.close();
	await popupWinB.close();
});
