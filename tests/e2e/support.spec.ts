import { expect, test } from './fixtures';

test('shows the Buy Me a Coffee support link', async ({ page, openPopup }) => {
	await openPopup(page);

	const supportLink = page.locator('.support-link');
	await expect(supportLink).toHaveAttribute('href', 'https://buymeacoffee.com/bbeeezzzzz');
	await expect(supportLink).toHaveAttribute('target', '_blank');
});
