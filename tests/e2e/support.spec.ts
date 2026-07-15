import { expect, installPopupRuntimeMock, test } from './fixtures';

test.use({ browserLocale: 'en-US' });

test('shows privacy-safe support links and the exact extension version', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, {
		session: {
			sessionId: 'private-session',
			tabId: 7,
			title: 'Private page title',
			url: 'https://private.example.test/article',
			lang: 'en',
			status: 'paused',
			currentParagraphIndex: 1,
			totalParagraphs: 3,
			progressPercentage: 33,
			voiceStyleId: 'M1',
			speed: 1.05,
			updatedAt: 1000,
		},
		currentTabId: 7,
	});
	await openPopup(page);

	await expect(page.getByRole('link', { name: 'Buy me a coffee' })).toHaveAttribute('target', '_blank');
	const feedback = page.getByRole('link', { name: 'Feedback' });
	await expect(feedback).toHaveAttribute('target', '_blank');
	await expect(page.getByRole('link', { name: 'Privacy Policy', exact: true })).toHaveAttribute('target', '_blank');
	const header = page.locator('.app-header');
	await expect(header.locator(':scope > .logo-group + .extension-version')).toHaveText('v1.0.0');
	await expect(header).toHaveCSS('justify-content', 'space-between');
	await expect(page.locator('.app-footer .extension-version')).toHaveCount(0);
	const href = (await feedback.getAttribute('href')) || '';
	const feedbackBody = new URL(href).searchParams.get('body') || '';
	expect(feedbackBody).toContain('Extension version: v1.0.0');
	expect(feedbackBody).not.toContain('private.example.test');
});
