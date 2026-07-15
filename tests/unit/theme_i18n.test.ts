import assert from 'node:assert/strict';
import test from 'node:test';
import { STORAGE_KEYS, THEME_TRANSLATIONS } from '../../src/shared/constants.ts';

test('STORAGE_KEYS.THEME có giá trị chính xác', () => {
	// @ts-expect-error STORAGE_KEYS.THEME will be added in implementation
	assert.strictEqual(STORAGE_KEYS.THEME, 'readit_active_theme');
});

test('THEME_TRANSLATIONS dịch ngôn ngữ vi và en hoạt động chính xác', () => {
	// @ts-expect-error THEME_TRANSLATIONS will be added in implementation
	const vi = THEME_TRANSLATIONS.vi;
	// @ts-expect-error THEME_TRANSLATIONS will be added in implementation
	const en = THEME_TRANSLATIONS.en;

	assert.strictEqual(vi.selectTheme, 'Chọn giao diện');
	assert.strictEqual(vi.themeWinamp, '🕹️ Classic (1998)');
	assert.strictEqual(vi.themeDefault, '📱 Hiện đại');
	assert.strictEqual(vi.themeWmp12, '💿 Vista Aero (2006)');
	assert.strictEqual(vi.winampTitle, 'WINAMP CỔ ĐIỂN');
	assert.strictEqual(vi.voiceConfig, 'CẤU HÌNH GIỌNG ĐỌC');
	assert.strictEqual(vi.readCurrentPage, 'Đọc trang này thay thế');
	assert.strictEqual(vi.readPage, 'Đọc trang hiện tại');
	assert.strictEqual(vi.stopReading, 'Dừng đọc bài');
	assert.strictEqual(vi.playingStatus, 'Đang đọc đoạn');
	assert.strictEqual(vi.readyStatus, 'Sẵn sàng đọc trang web');

	assert.strictEqual(en.selectTheme, 'Select Theme');
	assert.strictEqual(en.themeWinamp, '🕹️ Classic (1998)');
	assert.strictEqual(en.themeDefault, '📱 Modern');
	assert.strictEqual(en.themeWmp12, '💿 Vista Aero (2006)');
	assert.strictEqual(en.winampTitle, 'WINAMP CLASSIC');
	assert.strictEqual(en.voiceConfig, 'VOICE CONFIGURATION');
	assert.strictEqual(en.readCurrentPage, 'Read this page instead');
	assert.strictEqual(en.readPage, 'Read current page');
	assert.strictEqual(en.stopReading, 'Stop reading');
	assert.strictEqual(en.playingStatus, 'Reading paragraph');
	assert.strictEqual(en.readyStatus, 'Ready to read page');
});
