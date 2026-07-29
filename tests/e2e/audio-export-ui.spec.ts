import type { PlaybackSessionSnapshot } from '../../src/shared/types.ts';
import { expect, installOpfsAudioExportPicker, installPopupRuntimeMock, test } from './fixtures';

const estimate = { durationSeconds: 90, estimatedBytes: 1_084_096 };

const articleSession: PlaybackSessionSnapshot = {
	sessionId: 'article-session',
	contentScope: 'article',
	readableSurface: 'website-dom',
	source: { kind: 'tab', tabId: 7, title: 'Article title', url: 'https://readit.test/article' },
	lang: 'en',
	status: 'playing',
	currentParagraphIndex: 0,
	totalParagraphs: 1,
	progressPercentage: 0,
	voiceStyleId: 'M1',
	speed: 1,
	audioExportEstimate: estimate,
	updatedAt: 1,
};

const variants: Array<{ name: string; session: PlaybackSessionSnapshot; suggestedName: string | RegExp }> = [
	{ name: 'article', session: articleSession, suggestedName: 'Article title.mp3' },
	{
		name: 'selection',
		session: {
			...articleSession,
			sessionId: 'selection-session',
			contentScope: 'selection',
			source: { ...articleSession.source, title: 'Selected title' },
		},
		suggestedName: 'Selected title-selection.mp3',
	},
	{
		name: 'manual',
		session: {
			...articleSession,
			sessionId: 'manual-session',
			contentScope: 'manual',
			readableSurface: 'manual-reader',
			source: { kind: 'manual', panelInstanceId: '6a9bf5db-7bd6-4fb9-9f58-0e2e6f0a1c72' },
		},
		suggestedName: /^readit-pasted-text-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.mp3$/u,
	},
	{
		name: 'Google Docs document reader',
		session: {
			...articleSession,
			sessionId: 'docs-session',
			readableSurface: 'document-reader',
			source: { ...articleSession.source, title: 'Google Doc title' },
		},
		suggestedName: 'Google Doc title.mp3',
	},
	{
		name: 'PDF document reader',
		session: {
			...articleSession,
			sessionId: 'pdf-session',
			readableSurface: 'document-reader',
			source: { ...articleSession.source, title: 'PDF title' },
		},
		suggestedName: 'PDF title.mp3',
	},
];

for (const variant of variants) {
	test(`enables OPFS MP3 export with the ${variant.name} snapshot filename`, async ({ page, openPopup }) => {
		await installPopupRuntimeMock(page, { session: variant.session, currentTabId: 7 });
		await installOpfsAudioExportPicker(page, `ui-${variant.name.replaceAll(' ', '-')}.mp3`);
		await openPopup(page);

		const button = page.getByRole('button', { name: 'Xuất MP3' });
		await expect(button).toBeEnabled();
		await button.click();
		await expect
			.poll(() => page.evaluate(() => (window as any).__readitOpfsPickerOptions))
			.toMatchObject({
				id: 'readit-mp3-export',
				startIn: 'music',
				types: [{ description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } }],
			});
		const suggestedName = await page.evaluate(() => (window as any).__readitOpfsPickerOptions.suggestedName);
		if (typeof variant.suggestedName === 'string') {
			expect(suggestedName).toBe(variant.suggestedName);
		} else {
			expect(suggestedName).toMatch(variant.suggestedName);
		}
	});
}

test('requires the 120-minute warning but permits continuation without an export cap', async ({ page, openPopup }) => {
	const longSession = { ...articleSession, audioExportEstimate: { durationSeconds: 7_201, estimatedBytes: 86_416_096 } };
	await installPopupRuntimeMock(page, { session: longSession, currentTabId: 7 });
	await installOpfsAudioExportPicker(page, 'long-export.mp3');
	await openPopup(page);

	await page.getByRole('button', { name: 'Xuất MP3' }).click();
	await expect(page.getByRole('alertdialog', { name: 'Xuất MP3 dài' })).toBeVisible();
	await page.getByRole('button', { name: 'Tiếp tục' }).click();
	await expect.poll(() => page.evaluate(() => (window as any).__readitOpfsPickerOptions?.suggestedName)).toBe('Article title.mp3');
});
