import type { Page } from '@playwright/test';

import { buildDocxFixture } from './docx_fixture';
import { expect, test } from './fixtures';
import { stubFilePicker, stubPlaybackRuntime } from './reader_stubs';

/** Long enough that the virtual paginator produces several pages. */
const PARAGRAPHS = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${'sample text '.repeat(30)}`);

async function openReaderWithDocument(page: Page, extensionId: string) {
	await stubFilePicker(page, 'fixture.docx', await buildDocxFixture(PARAGRAPHS));
	await stubPlaybackRuntime(page);
	await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
}

test('opens a local DOCX and reads it from the first page', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);

	await reader.locator('.btn-open-book').click();

	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');
	await expect(reader.locator('.document-reader-progress')).toContainText('1/');
});

test.describe('reading measure', () => {
	// Wide enough that the frame stops growing but the window does not, which is where a type
	// scale tied to the window instead of the frame runs the line long.
	for (const width of [1480, 1100, 780]) {
		test(`holds a readable line length at ${width}px`, async ({ context, extensionId }) => {
			const reader = await context.newPage();
			await reader.setViewportSize({ width, height: 900 });
			await openReaderWithDocument(reader, extensionId);
			await reader.locator('.btn-open-book').click();
			await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');

			// Georgia is installed on macOS and Windows but not on Linux, where the stack falls
			// through to a Times-metric serif that sets a whole word more per line. Only one of the
			// two is on the machine running this, so the other has to be asked for by name.
			for (const family of ['', 'Times New Roman, serif']) {
				const lineLengths = await reader.evaluate((forcedFamily) => {
					const content = document.querySelector('.document-reader-content');
					if (!(content instanceof HTMLElement)) throw new Error('Reader content is missing');
					content.style.fontFamily = forcedFamily;
					const node = content.firstChild;
					if (!(node instanceof Text)) throw new Error('Reader content is not a single text node');
					const lines: number[] = [];
					let run = 0;
					let previousTop: number | null = null;
					for (let index = 0; index < node.data.indexOf('\n\n'); index++) {
						const range = document.createRange();
						range.setStart(node, index);
						range.setEnd(node, index + 1);
						const top = Math.round(range.getBoundingClientRect().top);
						if (previousTop !== null && top !== previousTop) {
							lines.push(run);
							run = 0;
						}
						previousTop = top;
						run++;
					}
					return lines; // The trailing partial line is dropped: it says nothing about the measure.
				}, family);

				expect(lineLengths.length).toBeGreaterThan(2);
				expect(Math.min(...lineLengths)).toBeGreaterThanOrEqual(55);
				expect(Math.max(...lineLengths)).toBeLessThanOrEqual(80);
			}
		});
	}
});

test('keeps the toolbar columns inside the card once the page controls appear', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.btn-next-chapter')).toBeVisible();

	// A grid track never shrinks past its own minimum. Once paging adds two more buttons the
	// playback column widens, and minimums that no longer fit push the progress column out over
	// the card's right edge rather than wrapping.
	const overflow = await reader.evaluate(() => {
		const toolbar = document.querySelector('.document-reader-toolbar') as HTMLElement;
		const style = getComputedStyle(toolbar);
		const inner =
			toolbar.getBoundingClientRect().right - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderRightWidth);
		return Math.max(...[...toolbar.children].map((child) => child.getBoundingClientRect().right)) - inner;
	});

	expect(overflow).toBeLessThanOrEqual(1);
});

test('jumps forward a page and back again', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');

	await reader.locator('.btn-next-chapter').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('2/');
	await expect(reader.locator('.document-reader-content')).not.toContainText('Paragraph 0');

	await reader.locator('.btn-previous-chapter').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('1/');
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');
});

test('resumes a document at the page it was left on', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');
	await reader.locator('.btn-next-chapter').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('2/');

	// Drop the playing session so the tab comes back to the picker, as a fresh tab would.
	await reader.evaluate(() => sessionStorage.removeItem('readit-e2e-stub-playback'));
	await reader.reload();

	await expect(reader.locator('.btn-resume-book')).toContainText('Fixture Document');
	await expect(reader.locator('.btn-resume-book')).toContainText('%');
	await reader.locator('.btn-resume-book').click();

	await expect(reader.locator('.document-reader-progress')).toContainText('2/');
});

test('a legacy .doc is turned down with advice rather than a generic failure', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	// The bytes are irrelevant: the extension refuses on the extension alone, before reading anything.
	await stubFilePicker(reader, 'legacy.doc', await buildDocxFixture(['Never read.']));
	await stubPlaybackRuntime(reader);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await reader.locator('.btn-open-book').click();

	await expect(reader.locator('.alert-danger')).toContainText('.docx');
	await expect(reader.locator('.document-reader-content')).toHaveCount(0);
});

test('offers no way back to a source tab once the book came from this one', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(reader, 'short.docx', await buildDocxFixture(['One short paragraph.']));
	await stubPlaybackRuntime(reader);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('One short paragraph.');
	await expect(reader.locator('.btn-back-source')).toHaveCount(0);

	// Stopping clears the playback session, but the book on screen still came from a file picked
	// in this tab, so there is still no source tab behind it.
	await reader.locator('.btn-stop-reading').click();

	await expect(reader.locator('.document-reader-content')).toContainText('One short paragraph.');
	await expect(reader.locator('.btn-back-source')).toHaveCount(0);
});

test('keeps the same transport buttons after playback stops', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');

	const transport = reader.locator('.document-reader-toolbar .playback-controls button');
	const playPause = reader.locator('.document-reader-toolbar .btn-primary.btn-icon-only');
	await expect(transport).toHaveCount(5);
	await expect(playPause).toBeEnabled();

	await reader.locator('.btn-stop-reading').click();

	// Same five buttons in the same order; only their state changes.
	await expect(transport).toHaveCount(5);
	await expect(playPause).toBeDisabled();
});

test('exports the audio of the book it is reading', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithDocument(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('Paragraph 0');

	const exportButton = reader.locator('.document-reader-toolbar .audio-export-button');
	// Nothing has been synthesized yet, so there is no audio to write out.
	await expect(exportButton).toBeDisabled();

	await reader.evaluate(() => (window as unknown as { attachExportEstimate: () => void }).attachExportEstimate());

	await expect(exportButton).toBeEnabled();
	await expect(exportButton).toHaveAttribute('aria-label', /MP3/i);
});

test('brings the way back once this tab is reused for a web page', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(reader, 'short.docx', await buildDocxFixture(['One short paragraph.']));
	await stubPlaybackRuntime(reader);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await reader.locator('.btn-open-book').click();
	// Wait for the book's own session to land: an absent button is the starting state too, so
	// asserting on it alone would let the page arrive before the book it is supposed to replace.
	await expect(reader.locator('.document-reader-content')).toContainText('One short paragraph.');
	await expect(reader.locator('.btn-back-source')).toHaveCount(0);

	// The background hands a new page to the reader tab it already opened, rather than a new tab.
	await reader.evaluate(() => (window as unknown as { attachTabSession: () => void }).attachTabSession());

	await expect(reader.locator('.document-reader-content')).toContainText('Web page text.');
	await expect(reader.locator('.btn-back-source')).toBeEnabled();
});

test('a single-page document shows no page buttons', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(reader, 'short.docx', await buildDocxFixture(['One short paragraph.']));
	await stubPlaybackRuntime(reader);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('One short paragraph.');

	await expect(reader.locator('.btn-next-chapter')).toHaveCount(0);
	await expect(reader.locator('.btn-previous-chapter')).toHaveCount(0);
});
