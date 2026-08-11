import { expect, test } from './fixtures';

test.use({ browserLocale: 'en-US' });

test.describe('Pronunciation Dictionary Settings Page', () => {
	test('settings page loads and shows empty state', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html`;
		await page.goto(settingsUrl);

		// Header renders
		await expect(page.locator('.settings-header h1')).toBeVisible();

		// Empty state message is shown
		await expect(page.locator('.empty-state')).toBeVisible();

		// Add Rule button is visible
		await expect(page.locator('.btn-add')).toBeVisible();
		await expect(page.locator('.btn-add')).toBeEnabled();
	});

	test('can add, edit, and save a pronunciation rule', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html`;
		await page.goto(settingsUrl);

		// Click Add Rule
		await page.locator('.btn-add').click();

		// Edit form appears
		await expect(page.locator('.rule-edit')).toBeVisible();

		// Fill in match and replacement
		const matchInput = page.locator('.rule-edit-field input').first();
		const replacementInput = page.locator('.rule-edit-field input').nth(1);
		await matchInput.fill('HTML');
		await replacementInput.fill('aitch tee em el');

		// Save
		await page.locator('.btn-save').click();

		// Edit form closes, rule row appears
		await expect(page.locator('.rule-edit')).not.toBeVisible();
		await expect(page.locator('.rule-match')).toHaveText('HTML');
		await expect(page.locator('.rule-replacement')).toHaveText('aitch tee em el');
	});

	test('can toggle a rule on and off', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html`;
		await page.goto(settingsUrl);

		// Add a rule first
		await page.locator('.btn-add').click();
		await page.locator('.rule-edit-field input').first().fill('CSS');
		await page.locator('.rule-edit-field input').nth(1).fill('see ess ess');
		await page.locator('.btn-save').click();

		// Rule should be enabled (checked)
		const toggle = page.locator('.rule-enabled-toggle');
		await expect(toggle).toBeChecked();

		// Click to disable
		await toggle.click();
		await expect(toggle).not.toBeChecked();
		await expect(page.locator('.rule-row')).toHaveClass(/rule-disabled/);

		// Click to re-enable
		await toggle.click();
		await expect(toggle).toBeChecked();
		await expect(page.locator('.rule-row')).not.toHaveClass(/rule-disabled/);
	});

	test('can delete a rule', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html`;
		await page.goto(settingsUrl);

		// Add a rule
		await page.locator('.btn-add').click();
		await page.locator('.rule-edit-field input').first().fill('USB');
		await page.locator('.rule-edit-field input').nth(1).fill('universal serial bus');
		await page.locator('.btn-save').click();
		await expect(page.locator('.rule-row')).toHaveCount(1);

		// Delete it
		await page.locator('.btn-delete').click();
		await expect(page.locator('.rule-row')).toHaveCount(0);

		// Empty state returns
		await expect(page.locator('.empty-state')).toBeVisible();
	});

	test('pre-fills match from query parameter', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html?match=JavaScript`;
		await page.goto(settingsUrl);

		// Edit form should appear with pre-filled match
		await expect(page.locator('.rule-edit')).toBeVisible();
		const matchInput = page.locator('.rule-edit-field input').first();
		await expect(matchInput).toHaveValue('JavaScript');
	});

	test('language filter narrows visible rules', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html`;
		await page.goto(settingsUrl);

		// Add an English-only rule
		await page.locator('.btn-add').click();
		await page.locator('.rule-edit-field input').first().fill('HTML');
		await page.locator('.rule-edit-field input').nth(1).fill('aitch tee em el');
		await page.locator('.rule-lang-select select').selectOption('en');
		await page.locator('.btn-save').click();

		// Add an all-languages rule
		await page.locator('.btn-add').click();
		await page.locator('.rule-edit-field input').first().fill('OK');
		await page.locator('.rule-edit-field input').nth(1).fill('okay');
		await page.locator('.btn-save').click();

		// Both visible with All filter
		await expect(page.locator('.rule-row')).toHaveCount(2);

		// Filter to English — should show only the EN rule
		await page.locator('.filter-label select').selectOption('en');
		await expect(page.locator('.rule-row')).toHaveCount(1);
		await expect(page.locator('.rule-match')).toHaveText('HTML');

		// Filter back to All
		await page.locator('.filter-label select').selectOption('all');
		await expect(page.locator('.rule-row')).toHaveCount(2);
	});

	test('cancel discards unsaved new rule', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html`;
		await page.goto(settingsUrl);

		// Add and immediately cancel (match is empty)
		await page.locator('.btn-add').click();
		await expect(page.locator('.rule-edit')).toBeVisible();
		await page.locator('.btn-cancel').click();

		// No rule saved, empty state returns
		await expect(page.locator('.rule-edit')).not.toBeVisible();
		await expect(page.locator('.rule-row')).toHaveCount(0);
		await expect(page.locator('.empty-state')).toBeVisible();
	});

	test('rule counter updates as rules are added', async ({ page, extensionId }) => {
		const settingsUrl = `chrome-extension://${extensionId}/src/settings/settings.html`;
		await page.goto(settingsUrl);

		await expect(page.locator('.rule-counter')).toHaveText('0/200');

		// Add a rule
		await page.locator('.btn-add').click();
		await page.locator('.rule-edit-field input').first().fill('Test');
		await page.locator('.rule-edit-field input').nth(1).fill('tee ee ess tee');
		await page.locator('.btn-save').click();

		await expect(page.locator('.rule-counter')).toHaveText('1/200');
	});
});

test.describe('Popup Pronunciation Dictionary Link', () => {
	test('popup footer has Pronunciation Dictionary link', async ({ page, extensionId }) => {
		const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
		await page.goto(popupUrl);

		const link = page.locator('.pronunciation-link');
		await expect(link).toBeVisible();
	});
});
