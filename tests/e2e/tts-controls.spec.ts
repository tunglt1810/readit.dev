import { expect, installPopupRuntimeMock, test } from './fixtures';

const session = {
	sessionId: 'session-1',
	tabId: 7,
	title: 'An article',
	url: 'https://example.com/article',
	lang: 'en',
	status: 'loading' as const,
	currentParagraphIndex: 0,
	totalParagraphs: 5,
	progressPercentage: 0,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
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
		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({
				action: 'PLAYBACK_STATE_UPDATE',
				session: nextSession,
			});
		}, { ...session, status: 'playing', progressPercentage: 20 });
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
		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({
				action: 'PLAYBACK_STATE_UPDATE',
				session: nextSession,
			});
		}, { ...session, status: 'paused', progressPercentage: 20 });
		await expect(statusText).toHaveText('Tạm dừng');
		const resumeButton = page.getByRole('button', { name: 'Tiếp tục' });
		await expect(resumeButton).toHaveText('');
		await expect(resumeButton.locator('svg[aria-hidden="true"]')).toHaveCount(1);

		// 4. Click nút "Tiếp tục"
		await resumeButton.click();
		const sentActionsAfterResume = await page.evaluate(() => (window as any).sentMessages.map((m: any) => m.action));
		expect(sentActionsAfterResume).toContain('RESUME_READING');

		await page.evaluate((nextSession) => {
			(window as any).mockReceiveMessage({
				action: 'PLAYBACK_STATE_UPDATE',
				session: nextSession,
			});
		}, { ...session, status: 'playing', progressPercentage: 20 });

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
});
