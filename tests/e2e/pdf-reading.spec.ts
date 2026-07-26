import { expect, installExtensionUiRuntimeMock, test } from './fixtures';

const pageInfo = { available: true as const, title: 'PDF fixture', url: 'https://example.com/text-layer.pdf', lang: 'en' };
const vietnameseErrors = [
	['pdfFileAccessRequired', 'Để đọc file PDF trên máy, hãy bật “Cho phép truy cập URL tệp” trong trang chi tiết tiện ích của Chrome.'],
	['pdfPasswordProtected', 'PDF này được bảo vệ bằng mật khẩu và chưa được hỗ trợ.'],
	['pdfTextUnavailable', 'Không tìm thấy văn bản có thể đọc trong PDF này. PDF scan chưa được hỗ trợ.'],
	['pdfExtractionFailed', 'Không thể đọc PDF này. Hãy thử lại hoặc dán văn bản để đọc.'],
] as const;

for (const [code, copy] of vietnameseErrors) {
	test(`Popup renders ${code}`, async ({ page, openPopup }) => {
		await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
		await page.addInitScript((nextCode) => {
			(window as any).commandResponses = { START_CURRENT_PAGE: { success: false, error: nextCode } };
		}, code);
		await openPopup(page);
		await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
		await expect(page.locator('.alert.alert-danger')).toHaveText(copy);
	});

	test(`Side Panel renders ${code}`, async ({ page, openSidePanel }) => {
		await installExtensionUiRuntimeMock(page, { session: null }, pageInfo);
		await page.addInitScript((nextCode) => {
			(window as any).commandResponses = { START_CURRENT_PAGE: { success: false, error: nextCode } };
		}, code);
		await openSidePanel(page);
		await page.getByRole('button', { name: 'Đọc trang hiện tại' }).click();
		await expect(page.getByRole('alert')).toHaveText(copy);
	});
}
