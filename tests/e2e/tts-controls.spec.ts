import { expect, installPopupRuntimeMock, test } from './fixtures';

const session = {
	sessionId: 'session-1',
	contentScope: 'article' as const,
	source: { kind: 'tab' as const, tabId: 7, title: 'An article', url: 'https://example.com/article' },
	lang: 'en',
	status: 'loading' as const,
	currentParagraphIndex: 0,
	totalParagraphs: 5,
	progressPercentage: 0,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

const exportSession = {
	...session,
	status: 'playing' as const,
	audioExportEstimate: { durationSeconds: 120, estimatedBytes: 1_444_096 },
};

const exportJob = {
	jobId: 'job-1',
	playbackSessionId: exportSession.sessionId,
	title: exportSession.source.title,
	outputFilename: 'an-article.mp3',
	state: 'exporting' as const,
	estimate: exportSession.audioExportEstimate,
	processedDurationSeconds: 30,
	progressPercentage: 25,
	bytesWritten: 1_000,
	startedAt: 1_000,
	updatedAt: 2_000,
};

test.describe('Kịch bản 3: Điều khiển TTS (TTS Controls)', () => {
	test.beforeEach(async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });

		// Mở popup sau khi cài mock để bắt listener lúc App mount.
		await openPopup(page);
	});

	test('Thay đổi tốc độ đọc và giọng đọc lưu vào storage cục bộ', async ({ page }) => {
		// 1. Tương tác với thanh trượt tốc độ đọc (speed slider)
		const speedSlider = page.locator('.form-slider');
		await expect(speedSlider).toBeVisible();

		// Thay đổi tốc độ sang 1.3
		await speedSlider.fill('1.3');

		// Đợi một khoảng ngắn để state cập nhật và lưu vào storage
		await page.waitForTimeout(500);

		// Xác thực text hiển thị tốc độ trên giao diện
		const speedValueText = page.locator('.slider-value');
		await expect(speedValueText).toHaveText('1.30x');

		// Kiểm tra giá trị lưu trữ trong chrome.storage.local
		const savedSpeed = await page.evaluate(async () => {
			return new Promise((resolve) => {
				chrome.storage.local.get('readit_speed', (res) => {
					resolve(res.readit_speed);
				});
			});
		});
		expect(savedSpeed).toBe(1.3);
		const speedActions = await page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action));
		expect(speedActions).toContain('CHANGE_SPEED');

		// 2. Tương tác với dropdown chọn giọng đọc (voice styles)
		const voiceSelect = page.locator('.form-select');
		await expect(voiceSelect).toBeVisible();

		// Thay đổi giọng đọc sang F1 (Nữ 1 - Nhẹ)
		await voiceSelect.selectOption('F1');

		// Đợi state cập nhật
		await page.waitForTimeout(500);

		// Kiểm tra giá trị lưu trữ trong chrome.storage.local
		const savedVoice = await page.evaluate(async () => {
			return new Promise((resolve) => {
				chrome.storage.local.get('readit_active_voice', (res) => {
					resolve(res.readit_active_voice);
				});
			});
		});
		expect(savedVoice).toBe('F1');
	});

	test('opens the Side Panel from a labeled secondary action', async ({ page }) => {
		const button = page.getByRole('button', { name: 'Mở Side Panel' });
		await expect(button).toBeVisible();
		await expect(page.locator('.status-row .btn-icon-sidepanel')).toHaveCount(1);
		await expect.poll(() => page.evaluate(() => (window as any).tabsQueryCalls)).toBe(1);
		await button.click();
		expect(await page.evaluate(() => (window as any).sidePanelOpenCalls)).toEqual([{ windowId: 7 }]);
		expect(await page.evaluate(() => (window as any).tabsQueryCalls)).toBe(1);
	});

	test('renders status-row container with compact status display pill and side panel icon button', async ({ page }) => {
		const statusRow = page.locator('.status-row');
		const statusDisplay = statusRow.locator('.status-display');
		const sidePanelBtn = statusRow.locator('.btn-icon-sidepanel');

		await expect(statusRow).toBeVisible();
		await expect(statusRow).toHaveCSS('display', 'flex');
		await expect(statusRow).toHaveCSS('justify-content', 'space-between');
		await expect(statusRow).toHaveCSS('align-items', 'center');

		await expect(statusDisplay).toBeVisible();
		await expect(statusDisplay).toHaveAttribute('role', 'status');
		await expect(sidePanelBtn).toBeVisible();
		await expect(sidePanelBtn).toHaveAttribute('title', 'Mở Side Panel');
		await expect(sidePanelBtn).toHaveAttribute('aria-label', 'Mở Side Panel');
		await expect(sidePanelBtn).toHaveAttribute('type', 'button');

		const svg = sidePanelBtn.locator('svg');
		await expect(svg).toBeVisible();
		await expect(svg).toHaveAttribute('aria-hidden', 'true');
		await expect(svg.locator('rect, line, path, polygon')).toHaveCount(2);

		// Kiểm tra trạng thái hover/tooltip
		await sidePanelBtn.hover();
		await expect(sidePanelBtn).toHaveCSS('cursor', 'pointer');
	});

	test('supports keyboard navigation and activation (Enter and Space) on Side Panel toggle button', async ({ page }) => {
		const sidePanelBtn = page.locator('.status-row .btn-icon-sidepanel');

		// Focus nút Side Panel qua bàn phím
		await sidePanelBtn.focus();
		await expect(sidePanelBtn).toBeFocused();

		// Nhấn phím Enter để kích hoạt mở Side Panel
		await page.keyboard.press('Enter');
		expect(await page.evaluate(() => (window as any).sidePanelOpenCalls)).toEqual([{ windowId: 7 }]);

		// Clear mock calls và thử kích hoạt bằng phím Space (Spacebar)
		await page.evaluate(() => {
			(window as any).sidePanelOpenCalls = [];
		});
		await sidePanelBtn.focus();
		await page.keyboard.press('Space');
		expect(await page.evaluate(() => (window as any).sidePanelOpenCalls)).toEqual([{ windowId: 7 }]);
	});

	test('shows a localized error when the Side Panel cannot be opened', async ({ page }) => {
		await page.evaluate(() => {
			chrome.sidePanel.open = async () => {
				throw new Error('Side Panel unavailable');
			};
		});

		await page.getByRole('button', { name: 'Mở Side Panel' }).click();
		await expect(page.locator('.alert-danger')).toHaveText('Không thể mở Side Panel. Vui lòng thử lại.');
	});

	test('renders the accessible shared MP3 picker handshake without an exportable session', async ({ page }) => {
		const exportButton = page.getByRole('button', { name: 'Xuất MP3' });
		await expect(exportButton).toBeDisabled();

		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
			(window as any).showSaveFilePicker = (options: unknown) => {
				(window as any).pickerOptions = options;
				(window as any).actionsAtPicker = (window as any).sentMessages.map((message: any) => message.action);
				return new Promise(() => {});
			};
		}, exportSession);

		await expect(exportButton).toBeEnabled();
		await expect(exportButton).toHaveAttribute('title', 'Xuất MP3');
		await exportButton.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => (window as any).pickerOptions)).toEqual({
			id: 'readit-mp3-export',
			startIn: 'music',
			suggestedName: 'An article.mp3',
			types: [{ description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } }],
		});
		expect(await page.evaluate(() => (window as any).actionsAtPicker)).toContain('PREPARE_AUDIO_EXPORT');
		await expect(page.locator('.audio-export-status[role="status"]')).toBeVisible();
	});

	test('hydrates progress states and requires confirmation before cancellation', async ({ page }) => {
		await page.evaluate((job) => {
			(window as any).mockReceiveMessage({ action: 'AUDIO_EXPORT_STATE_UPDATE', job });
		}, exportJob);
		const exportButton = page.getByRole('button', { name: 'Hủy xuất MP3' });
		await expect(exportButton).toHaveAttribute('data-state', 'exporting');
		await exportButton.click();
		await expect(page.getByRole('alertdialog', { name: 'Hủy xuất MP3?' })).toBeVisible();
		await page.getByRole('button', { name: 'Giữ xuất MP3' }).click();

		for (const state of ['waiting-for-playback', 'cancelling', 'completed', 'failed', 'interrupted']) {
			await page.evaluate(({ job, state }) => {
				(window as any).mockReceiveMessage({ action: 'AUDIO_EXPORT_STATE_UPDATE', job: { ...job, state } });
			}, { job: exportJob, state });
			await expect(page.locator('.audio-export-button')).toHaveAttribute('data-state', state);
		}
	});

	test('activates MP3 export with Space', async ({ page }) => {
		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
			(window as any).showSaveFilePicker = () => new Promise(() => {});
		}, exportSession);
		const exportButton = page.getByRole('button', { name: 'Xuất MP3' });
		await exportButton.focus();
		await page.keyboard.press('Space');
		await expect.poll(() => page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action))).toContain(
			'PREPARE_AUDIO_EXPORT',
		);
	});

	test('requires a long-export confirmation and silently cleans up picker cancellation', async ({ page }) => {
		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({
				action: 'PLAYBACK_STATE_UPDATE',
				session: { ...nextSession, audioExportEstimate: { durationSeconds: 3600, estimatedBytes: 43_204_096 } },
			});
			(window as any).showSaveFilePicker = () => Promise.reject(new DOMException('Cancelled', 'AbortError'));
		}, exportSession);
		await page.getByRole('button', { name: 'Xuất MP3' }).click();
		await expect(page.getByRole('alertdialog', { name: 'Xuất MP3 dài' })).toBeVisible();
		await page.getByRole('button', { name: 'Tiếp tục' }).click();
		await expect.poll(() => page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action))).toContain(
			'PREPARE_AUDIO_EXPORT',
		);
		await expect(page.getByRole('alert')).toHaveCount(0);
	});

	test('waits for a delayed prepare before discarding an immediately cancelled picker', async ({ page }) => {
		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
			(window as any).deferredRuntimeActions = ['PREPARE_AUDIO_EXPORT'];
			(window as any).showSaveFilePicker = () => Promise.reject(new DOMException('Cancelled', 'AbortError'));
		}, exportSession);

		await page.getByRole('button', { name: 'Xuất MP3' }).click();
		await expect.poll(() => page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action))).toContain(
			'PREPARE_AUDIO_EXPORT',
		);
		await page.waitForTimeout(250);
		expect(await page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action))).not.toContain('DISCARD_AUDIO_EXPORT');

		await page.evaluate(() => {
			(window as any).resolveDeferredRuntimeResponse('PREPARE_AUDIO_EXPORT', { success: true });
		});
		await expect.poll(() => page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action))).toContain(
			'DISCARD_AUDIO_EXPORT',
		);
		await expect(page.getByRole('alert')).toHaveCount(0);
	});

	test('Điều khiển Play/Pause/Stop và hiển thị trạng thái UI tương ứng', async ({ page }) => {
		// 1. Kiểm tra trạng thái Sẵn sàng ban đầu
		const statusText = page.locator('.status-text');
		await expect(statusText).toHaveText('Sẵn sàng đọc trang web');

		// 2. Click nút "Đọc trang hiện tại"
		const readBtn = page.getByRole('button', { name: 'Đọc trang hiện tại' });
		await expect(readBtn).toHaveText('');
		await expect(readBtn.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		await readBtn.click();

		// Kiểm tra xem message START_CURRENT_PAGE đã được gửi đi chưa
		const sentActions = await page.evaluate(() => (window as any).sentMessages.map((m: any) => m.action));
		expect(sentActions).toContain('START_CURRENT_PAGE');

		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: nextSession });
		}, session);
		const loadingStopButton = page.getByRole('button', { name: 'Dừng đọc bài' });
		await expect(loadingStopButton).toBeEnabled();
		await expect(loadingStopButton).toHaveText('');
		await expect(loadingStopButton.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		await loadingStopButton.click();
		expect(await page.evaluate(() => (window as any).sentMessages.map((message: any) => message.action))).toContain('STOP_READING');

		// Giả lập trạng thái Model Loading gửi về popup
		await page.evaluate(() => {
			(window as any).mockReceiveMessage({
				action: 'MODEL_LOADING_PROGRESS',
				progress: { loaded: 50, total: 100, modelName: 'Duration Predictor' },
			});
		});
		await expect(statusText).toContainText('Đang tải model: Duration Predictor (50%)');

		// Giả lập trạng thái Model Loaded gửi về popup
		await page.evaluate(() => {
			(window as any).mockReceiveMessage({
				action: 'MODEL_LOADED',
			});
		});
		await expect(statusText).toHaveText('Đang chuẩn bị giọng đọc...');

		// Giả lập đang phát âm thanh (Playing) qua background coordinator
		await page.evaluate(
			(nextSession) => {
				(window as any).mockReceiveMessage({
					action: 'PLAYBACK_STATE_UPDATE',
					session: nextSession,
				});
			},
			{ ...session, status: 'playing', progressPercentage: 20 },
		);
		await expect(statusText).toHaveText('Đang đọc đoạn 1/5');

		// Kiểm tra thanh tiến trình và nút Tạm dừng hiển thị
		const progressBar = page.locator('.progress-bar');
		await expect(progressBar).toBeVisible();
		await expect(progressBar).toHaveAttribute('style', 'width: 20%;');

		const pauseButton = page.getByRole('button', { name: 'Tạm dừng' });
		await expect(pauseButton).toBeVisible();
		await expect(pauseButton).toHaveText('');
		await expect(pauseButton.locator('svg[aria-hidden="true"]')).toHaveCount(1);

		// 3. Click nút "Tạm dừng"
		await pauseButton.click();

		// Kiểm tra xem message PAUSE_READING đã được gửi đi chưa
		const sentActionsAfterPause = await page.evaluate(() => (window as any).sentMessages.map((m: any) => m.action));
		expect(sentActionsAfterPause).toContain('PAUSE_READING');

		// Giả lập trạng thái Tạm dừng từ background gửi về popup
		await page.evaluate(
			(nextSession) => {
				(window as any).mockReceiveMessage({
					action: 'PLAYBACK_STATE_UPDATE',
					session: nextSession,
				});
			},
			{ ...session, status: 'paused', progressPercentage: 20 },
		);
		await expect(statusText).toHaveText('Tạm dừng');
		const resumeButton = page.getByRole('button', { name: 'Tiếp tục' });
		await expect(resumeButton).toHaveText('');
		await expect(resumeButton.locator('svg[aria-hidden="true"]')).toHaveCount(1);

		// 4. Click nút "Tiếp tục"
		await resumeButton.click();
		const sentActionsAfterResume = await page.evaluate(() => (window as any).sentMessages.map((m: any) => m.action));
		expect(sentActionsAfterResume).toContain('RESUME_READING');

		await page.evaluate(
			(nextSession) => {
				(window as any).mockReceiveMessage({
					action: 'PLAYBACK_STATE_UPDATE',
					session: nextSession,
				});
			},
			{ ...session, status: 'playing', progressPercentage: 20 },
		);

		// 5. Click nút "Dừng đọc bài" (Stop)
		await page.getByRole('button', { name: 'Dừng đọc bài' }).click();

		// Kiểm tra xem message STOP_READING đã được gửi đi chưa
		const sentActionsAfterStop = await page.evaluate(() => (window as any).sentMessages.map((m: any) => m.action));
		expect(sentActionsAfterStop).toContain('STOP_READING');
		await page.evaluate(() => {
			(window as any).mockReceiveMessage({ action: 'PLAYBACK_STATE_UPDATE', session: null });
		});

		// Khi dừng đọc, trạng thái quay về sẵn sàng, ẩn progress bar và ẩn nút play/pause
		await expect(statusText).toHaveText('Sẵn sàng đọc trang web');
		await expect(progressBar).not.toBeVisible();
		await expect(page.locator('.btn-playpause')).not.toBeVisible();
	});

	test('tự động focus vào nút đọc trang khi mở popup', async ({ page }) => {
		const readButton = page.locator('.btn-read');
		await expect(readButton).toBeFocused();
	});
});

test('keeps a newer export-state broadcast when initial hydration resolves late', async ({ page, openPopup }) => {
	const staleJob = { ...exportJob, state: 'waiting-for-playback' as const };
	await installPopupRuntimeMock(
		page,
		{ session: exportSession, currentTabId: 7 },
		undefined,
		{ job: staleJob },
		{ deferInitialAudioExportStateResponse: true },
	);
	await openPopup(page);
	await expect.poll(() => page.evaluate(() => (window as any).deferredRuntimeCallbacks.GET_AUDIO_EXPORT_STATE !== undefined)).toBe(true);

	await page.evaluate((job) => {
		(window as any).mockReceiveMessage({ action: 'AUDIO_EXPORT_STATE_UPDATE', job });
	}, exportJob);
	await expect(page.locator('.audio-export-button')).toHaveAttribute('data-state', 'exporting');

	await page.evaluate(() => {
		(window as any).resolveDeferredRuntimeResponse('GET_AUDIO_EXPORT_STATE');
	});
	await expect(page.locator('.audio-export-button')).toHaveAttribute('data-state', 'exporting');
});

test.describe('Popup Layout & Localization - English (en-US)', () => {
	test.use({ browserLocale: 'en-US' });

	test.beforeEach(async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
		await openPopup(page);
	});

	test('renders Popup status display and side panel toggle button in English locale', async ({ page }) => {
		const statusRow = page.locator('.status-row');
		const sidePanelBtn = statusRow.locator('.btn-icon-sidepanel');
		const statusText = page.locator('.status-text');

		await expect(statusText).toHaveText('Ready to read page');
		await expect(sidePanelBtn).toBeVisible();
		await expect(sidePanelBtn).toHaveAttribute('title', 'Open Side Panel');
		await expect(sidePanelBtn).toHaveAttribute('aria-label', 'Open Side Panel');
		await expect(sidePanelBtn).toHaveAttribute('data-tooltip', 'Open Side Panel');
		await expect(sidePanelBtn).toHaveAttribute('aria-pressed', 'false');
		await expect(sidePanelBtn).not.toHaveClass(/active/);
		await expect(sidePanelBtn.locator('svg')).toBeVisible();

		// Update open sidepanel storage state
		await page.evaluate(async () => {
			await chrome.storage.local.set({ readit_open_sidepanel_windows: [7] });
		});

		await expect(sidePanelBtn).toHaveAttribute('aria-pressed', 'true');
		await expect(sidePanelBtn).toHaveClass(/active/);
		await expect(sidePanelBtn).toHaveAttribute('title', 'Close side panel');
		await expect(sidePanelBtn).toHaveAttribute('aria-label', 'Close side panel');
		await expect(sidePanelBtn).toHaveAttribute('data-tooltip', 'Close side panel');

		// Keyboard focus and interaction in English locale
		await sidePanelBtn.focus();
		await expect(sidePanelBtn).toBeFocused();
		await page.keyboard.press('Enter');
		expect(await page.evaluate(() => (window as any).sentMessages.at(-1))).toEqual({
			action: 'CLOSE_SIDEPANEL',
			payload: { windowId: 7 },
		});
	});

	test('verifies JSON localization in English without broken fallback keys', async ({ page }) => {
		// Header links & titles
		await expect(page.locator('.header-support-link')).toContainText('Buy me a coffee');

		// Settings Card labels
		await expect(page.getByRole('button', { name: 'Theme' })).toBeVisible();
		await expect(page.getByRole('combobox', { name: 'Voice' })).toBeVisible();
		await expect(page.getByRole('slider', { name: 'Speed' })).toBeVisible();
		await expect(page.getByRole('checkbox', { name: 'Selection button' })).toBeVisible();
		await expect(page.getByRole('checkbox', { name: 'Word highlight' })).toBeVisible();

		// Footer links
		await expect(page.getByRole('link', { name: 'Feedback' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();

		// Primary playback action tooltip & aria-label
		await expect(page.getByRole('button', { name: 'Read current page' })).toBeVisible();

		// Ensure no raw untranslated i18n keys are visible on the page
		const rawFallbackKeys = [
			'appName',
			'readPage',
			'stopReading',
			'openSidePanel',
			'selectTheme',
			'voiceConfig',
			'readingSpeed',
			'showSelectionButton',
			'showWordHighlight',
			'buyMeCoffee',
			'feedback',
			'privacyPolicy',
			'readyStatus',
		];
		for (const key of rawFallbackKeys) {
			await expect(page.locator(`text="${key}"`)).toHaveCount(0);
		}
	});
});

test.describe('Popup Layout & Localization - Vietnamese (vi-VN)', () => {
	test.use({ browserLocale: 'vi-VN' });

	test.beforeEach(async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
		await openPopup(page);
	});

	test('verifies JSON localization in Vietnamese without broken fallback keys', async ({ page }) => {
		// Header links & titles
		await expect(page.locator('.header-support-link')).toContainText('Ủng hộ tôi một ly cà phê');

		// Settings Card labels
		await expect(page.getByRole('button', { name: 'Giao diện' })).toBeVisible();
		await expect(page.getByRole('combobox', { name: 'Giọng đọc' })).toBeVisible();
		await expect(page.getByRole('slider', { name: 'Tốc độ' })).toBeVisible();
		await expect(page.getByRole('checkbox', { name: 'Nút chọn nhanh' })).toBeVisible();
		await expect(page.getByRole('checkbox', { name: 'Tô sáng từ' })).toBeVisible();

		// Footer links
		await expect(page.getByRole('link', { name: 'Phản hồi' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Chính sách quyền riêng tư' })).toBeVisible();

		// Primary playback action tooltip & aria-label
		await expect(page.getByRole('button', { name: 'Đọc trang hiện tại' })).toBeVisible();

		// Ensure no raw untranslated i18n keys are visible on the page
		const rawFallbackKeys = [
			'appName',
			'readPage',
			'stopReading',
			'openSidePanel',
			'selectTheme',
			'voiceConfig',
			'readingSpeed',
			'showSelectionButton',
			'showWordHighlight',
			'buyMeCoffee',
			'feedback',
			'privacyPolicy',
			'readyStatus',
		];
		for (const key of rawFallbackKeys) {
			await expect(page.locator(`text="${key}"`)).toHaveCount(0);
		}
	});
});
