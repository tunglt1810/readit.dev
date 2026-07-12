import { expect, test } from './fixtures';

test('hides unavailable Pro UI and does not request license status', async ({ page, openPopup }) => {
	await page.addInitScript(() => {
		(window as any).sentMessages = [] as { action: string }[];
		chrome.runtime.sendMessage = (message: { action: string }, callback?: (response: unknown) => void) => {
			(window as any).sentMessages.push(message);
			callback?.({ success: true });
			return true;
		};
	});

	await openPopup(page);

	await expect(page.locator('.tier-badge-container')).not.toBeVisible();
	await expect(page.locator('.license-section')).not.toBeAttached();
	await expect(page.getByText('Kích hoạt bản quyền Pro')).not.toBeAttached();
	await expect(page.locator('.privacy-disclosure')).toContainText('không gửi lên server');

	const sentActions = await page.evaluate(() => (window as any).sentMessages.map((message: { action: string }) => message.action));
	expect(sentActions).not.toContain('CHECK_LICENSE');
	expect(sentActions).not.toContain('ACTIVATE_LICENSE');
});
