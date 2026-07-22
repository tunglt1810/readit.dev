import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, installPopupRuntimeMock, test } from './fixtures';

// package.json's version is the source of truth (see rsbuild.config.ts's manifest-version-sync
// plugin, which copies it into dist/manifest.json at build time) — read it dynamically instead of
// hardcoding a version string that goes stale on every version bump.
const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const expectedVersion = `v${(JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version: string }).version}`;

test.use({ browserLocale: 'en-US' });

test('shows privacy-safe support links and the exact extension version', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, {
		session: {
			sessionId: 'private-session',
			contentScope: 'article' as const,
			source: { kind: 'tab' as const, tabId: 7, title: 'Private page title', url: 'https://private.example.test/article' },
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

	const feedback = page.getByRole('link', { name: 'Feedback' });
	await expect(feedback).toHaveAttribute('target', '_blank');
	await expect(page.getByRole('link', { name: 'Privacy Policy', exact: true })).toHaveAttribute('target', '_blank');
	const header = page.locator('.app-header');
	const coffee = header.getByRole('link', { name: 'Buy me a coffee' });
	await expect(header.locator(':scope > .logo-group + .extension-version')).toHaveText(expectedVersion);
	await expect(header).toHaveCSS('justify-content', 'space-between');
	await expect(header).toHaveCSS('align-items', 'baseline');
	await expect(header.locator('.logo-group')).toHaveCSS('align-self', 'baseline');
	await expect(header.locator('.extension-version')).toHaveCSS('align-self', 'baseline');
	await expect(header.locator(':scope > .logo-group + .extension-version + .header-support-link')).toHaveCount(1);
	await expect(coffee).toHaveAttribute('target', '_blank');
	await expect(coffee).toHaveAttribute('rel', 'noreferrer');
	await expect(header.locator('.theme-selector-container')).toHaveCount(0);
	await expect(page.locator('.theme-setting .theme-selector-container')).toHaveCount(1);
	await expect(page.getByRole('link', { name: 'Buy me a coffee' })).toHaveCount(1);
	await expect(page.locator('.app-footer').getByRole('link', { name: 'Buy me a coffee' })).toHaveCount(0);
	await expect(page.locator('.app-footer .extension-version')).toHaveCount(0);
	const href = (await feedback.getAttribute('href')) || '';
	const feedbackBody = new URL(href).searchParams.get('body') || '';
	expect(feedbackBody).toContain(`Extension version: ${expectedVersion}`);
	expect(feedbackBody).not.toContain('private.example.test');
});
