import assert from 'node:assert/strict';
import test from 'node:test';
import * as constants from '../../src/shared/constants.ts';

const { STORAGE_KEYS, THEME_TRANSLATIONS } = constants;

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

	assert.strictEqual(vi.loadingModel, 'Đang tải model');
	assert.strictEqual(vi.modelLoadFailed, 'Không thể tải model');
	assert.strictEqual(vi.unknownError, 'Lỗi không xác định');
	assert.strictEqual(vi.startReadingFailed, 'Không thể bắt đầu đọc trang này. Vui lòng thử lại.');
	assert.strictEqual(vi.paragraphLabel, 'Đoạn');
	assert.strictEqual(vi.preparingContent, 'Đang chuẩn bị nội dung');
	assert.strictEqual(vi.readingOtherTab, 'Đang đọc ở tab khác');
	assert.strictEqual(vi.readingThisTab, 'Đang đọc ở tab này');
	assert.strictEqual(vi.privacyDisclosure, 'Nội dung được xử lý trên thiết bị, không gửi lên server.');
	assert.strictEqual(vi.learnMore, 'Tìm hiểu thêm');
	assert.strictEqual(vi.buyMeCoffee, 'Ủng hộ tôi một ly cà phê');
	assert.strictEqual(vi.feedback, 'Phản hồi');
	assert.strictEqual(vi.privacyPolicy, 'Chính sách quyền riêng tư');

	assert.strictEqual(en.loadingModel, 'Loading model');
	assert.strictEqual(en.modelLoadFailed, 'Unable to load model');
	assert.strictEqual(en.unknownError, 'Unknown error');
	assert.strictEqual(en.startReadingFailed, 'Unable to start reading this page. Please try again.');
	assert.strictEqual(en.paragraphLabel, 'Paragraph');
	assert.strictEqual(en.preparingContent, 'Preparing content');
	assert.strictEqual(en.readingOtherTab, 'Reading in another tab');
	assert.strictEqual(en.readingThisTab, 'Reading in this tab');
	assert.strictEqual(en.privacyDisclosure, 'Content is processed on your device and is not sent to a server.');
	assert.strictEqual(en.learnMore, 'Learn more');
	assert.strictEqual(en.buyMeCoffee, 'Buy me a coffee');
	assert.strictEqual(en.feedback, 'Feedback');
	assert.strictEqual(en.privacyPolicy, 'Privacy Policy');
});

test('VOICE_STYLE_TRANSLATIONS provides localized names for every stable voice ID', () => {
	const voiceStyleTranslations = Reflect.get(constants, 'VOICE_STYLE_TRANSLATIONS') as
		| Record<'vi' | 'en', Record<string, string>>
		| undefined;

	assert.deepStrictEqual(Object.keys(voiceStyleTranslations?.vi ?? {}), ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5']);
	assert.deepStrictEqual(Object.keys(voiceStyleTranslations?.en ?? {}), ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5']);
	assert.strictEqual(voiceStyleTranslations?.vi.M1, 'Nam 1 (Trầm)');
	assert.strictEqual(voiceStyleTranslations?.vi.F5, 'Nữ 5 (Vang)');
	assert.strictEqual(voiceStyleTranslations?.en.M1, 'Male 1 (Deep)');
	assert.strictEqual(voiceStyleTranslations?.en.F5, 'Female 5 (Resonant)');
});
