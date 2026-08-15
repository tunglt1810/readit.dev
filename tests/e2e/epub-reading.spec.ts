import type { Page } from '@playwright/test';

import { buildEpubFixture } from './epub_fixture';
import { expect, test } from './fixtures';
import { stubFilePicker, stubPlaybackRuntime } from './reader_stubs';

const CHAPTERS = [
	{ title: 'Chapter One', body: 'The first chapter has a short body.' },
	{ title: 'Chapter Two', body: 'The second chapter follows the first.' },
];

async function openReaderWithBook(page: Page, extensionId: string) {
	await stubFilePicker(page, 'fixture.epub', await buildEpubFixture(CHAPTERS));
	await stubPlaybackRuntime(page);
	await page.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
}

test('opens a local EPUB and reads its first chapter', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);

	await reader.locator('.btn-open-book').click();

	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter has a short body.');
	await expect(reader.locator('.document-reader-progress')).toContainText('1/2');
});

test('renders the chapter opened through the real background and offscreen handshake', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	// No playback stub: the Reader publishes its session and attaches long before offscreen
	// holds the document, so the chapter only appears if the late handshake delivers it.
	await stubFilePicker(reader, 'fixture.epub', await buildEpubFixture(CHAPTERS));
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await reader.locator('.btn-open-book').click();

	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter has a short body.', { timeout: 20_000 });
});

test('advances to the next chapter only on natural completion', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	await reader.evaluate(() => (window as unknown as { completeChapter: () => void }).completeChapter());

	await expect(reader.locator('.document-reader-content')).toContainText('The second chapter follows the first.');
	await expect(reader.locator('.document-reader-progress')).toContainText('2/2');
});

test('jumps to the next chapter and back to the one already read', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	await reader.locator('.btn-next-chapter').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The second chapter follows the first.');
	await expect(reader.locator('.document-reader-progress')).toContainText('2/2');
	await expect(reader.locator('.btn-next-chapter')).toBeDisabled();

	await reader.locator('.btn-previous-chapter').click();

	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter has a short body.');
	await expect(reader.locator('.document-reader-progress')).toContainText('1/2');
});

test('a book resumed at a later chapter can still go back to the one before it', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');
	await reader.locator('.btn-next-chapter').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('2/2');

	// Drop the playing session so the tab comes back to the picker, as a fresh tab would.
	await reader.evaluate(() => sessionStorage.removeItem('readit-e2e-stub-playback'));
	await reader.reload();
	await reader.locator('.btn-resume-book').click();
	await expect(reader.locator('.document-reader-progress')).toContainText('2/2');

	await reader.locator('.btn-previous-chapter').click();

	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter has a short body.');
	await expect(reader.locator('.document-reader-progress')).toContainText('1/2');
});

test('a session left playing from before the reload cannot skip the chapter being opened', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	await reader.evaluate(() => (window as unknown as { completeStaleSession: () => void }).completeStaleSession());

	await expect(reader.locator('.document-reader-progress')).toContainText('1/2');
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter has a short body.');
});

test('keeps chaining chapters after the tab reloads while a chapter plays on', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	// The audio outlives the tab, so the reloaded Reader has a chapter but no book object.
	await reader.reload();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');
	await expect(reader.locator('.document-reader-progress')).toContainText('1/2');

	await reader.evaluate(() => (window as unknown as { completeChapter: () => void }).completeChapter());

	await expect(reader.locator('.document-reader-content')).toContainText('The second chapter follows the first.');
	await expect(reader.locator('.document-reader-progress')).toContainText('2/2');
});

test('front matter the navigation skips is not counted as a chapter', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	// An untitled fixture entry is front matter: it holds a spine slot but the nav never links it.
	await stubFilePicker(reader, 'cover.epub', await buildEpubFixture([{ title: '', body: 'Cover art credit.' }, ...CHAPTERS]));
	await stubPlaybackRuntime(reader);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
	await reader.locator('.btn-open-book').click();

	// Three spine slots, but the book navigates to two of them.
	await expect(reader.locator('.document-reader-progress')).toContainText('1/2');
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter has a short body.');
	await expect(reader.locator('.document-reader-content')).not.toContainText('Cover art credit.');
	await expect(reader.locator('.btn-previous-chapter')).toBeDisabled();
});

test('a spine slot the navigation never names is read as part of the chapter before it', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubFilePicker(
		reader,
		'split.epub',
		await buildEpubFixture([
			{ title: 'Chapter One', body: 'The first chapter has a short body.' },
			{ title: '', body: 'The first chapter continues here.' },
			{ title: 'Chapter Two', body: 'The second chapter follows the first.' },
		]),
	);
	await stubPlaybackRuntime(reader);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);
	await reader.locator('.btn-open-book').click();

	// Dropping the unnamed slot would lose text, so it belongs to the chapter that opened it.
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter continues here.');
	await expect(reader.locator('.document-reader-progress')).toContainText('1/2');
});

test('returns to the picker after the last chapter finishes', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	const complete = () => reader.evaluate(() => (window as unknown as { completeChapter: () => void }).completeChapter());
	await complete();
	await expect(reader.locator('.document-reader-content')).toContainText('The second chapter');
	await complete();

	await expect(reader.locator('.document-reader-empty')).toBeVisible();
});

test('hides the entry point when the File System Access API is unavailable', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await reader.addInitScript(() => {
		delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
	});
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await expect(reader.locator('.document-reader-empty')).toBeVisible();
	await expect(reader.locator('.btn-open-book')).toHaveCount(0);
});

test('stores reading progress without storing chapter text', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await openReaderWithBook(reader, extensionId);
	await reader.locator('.btn-open-book').click();
	await expect(reader.locator('.document-reader-content')).toContainText('The first chapter');

	const stored = await reader.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
	expect(stored).toContain('readit_epub_progress');
	expect(stored).not.toContain('The first chapter has a short body.');
});

test('reports denied file access when resuming a saved book', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await stubPlaybackRuntime(reader);
	// A retained handle with no permission API stands in for a revoked grant.
	await reader.addInitScript(() => {
		(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = async () => [];
		void chrome.storage.local.set({
			readit_epub_progress: {
				title: 'Fixture Book',
				chapterIndex: 1,
				charOffset: 0,
				totalChapters: 2,
				fileSize: 10,
				fileLastModified: 20,
				updatedAt: 30,
			},
		});
		const open = indexedDB.open('readit-epub-library', 1);
		open.onupgradeneeded = () => open.result.createObjectStore('handles');
		open.onsuccess = () => {
			open.result
				.transaction('handles', 'readwrite')
				.objectStore('handles')
				.put({ handle: { name: 'fixture.epub' }, fileName: 'fixture.epub', fileSize: 10, fileLastModified: 20 }, 'current-book');
		};
	});
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await expect(reader.locator('.btn-resume-book')).toBeVisible();
	await reader.locator('.btn-resume-book').click();

	await expect(reader.locator('.document-reader-empty .alert-danger')).toBeVisible();
	await expect(reader.locator('.document-reader-content')).toHaveCount(0);
});
