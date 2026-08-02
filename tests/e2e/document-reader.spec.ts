import type { DocumentReaderSnapshot } from '../../src/shared/document_reader';
import type { PlaybackSessionSnapshot } from '../../src/shared/types';
import { expect, test } from './fixtures';

test('loads the bundled Document Reader with an empty state', async ({ context, extensionId }) => {
	const reader = await context.newPage();
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await expect(reader.locator('main[aria-label="readit.dev Document Reader"]')).toBeVisible();
	await expect(reader.locator('.document-reader-empty')).toBeVisible();
});

test('attaches once, renders source text, and highlights the current repeated word without persisting content', async ({
	context,
	extensionId,
}) => {
	const session: PlaybackSessionSnapshot = {
		sessionId: 'reader-session',
		contentScope: 'article',
		readableSurface: 'document-reader',
		source: { kind: 'tab', tabId: 42, title: 'Repeated words', url: 'https://docs.google.com/document/d/test/edit' },
		lang: 'en',
		status: 'playing',
		currentParagraphIndex: 0,
		totalParagraphs: 1,
		progressPercentage: 50,
		voiceStyleId: 'M1',
		speed: 1.05,
		updatedAt: 1000,
	};
	const snapshot: DocumentReaderSnapshot = {
		sessionId: session.sessionId,
		title: session.source.kind === 'tab' ? session.source.title : '',
		content: 'cat saw cat',
		words: [
			{ text: 'cat', globalIndex: 0 },
			{ text: 'cat', globalIndex: 1 },
		],
		currentWordIndex: 1,
	};
	const reader = await context.newPage();
	await reader.addInitScript(
		({ initialSession, initialSnapshot }) => {
			const runtimeListeners = new Set<Function>();
			const portListeners = new Set<Function>();
			(window as any).readerMessages = [];
			chrome.runtime.onMessage.addListener = (listener) => runtimeListeners.add(listener);
			chrome.runtime.onMessage.removeListener = (listener) => runtimeListeners.delete(listener);
			(chrome.runtime as any).connect = () => ({
				name: 'document-reader',
				onMessage: {
					addListener: (listener: Function) => portListeners.add(listener),
					removeListener: (listener: Function) => portListeners.delete(listener),
				},
				postMessage: (message: { action?: string }) => {
					(window as any).readerMessages.push(message);
					if (message.action === 'DOCUMENT_READER_ATTACH') {
						queueMicrotask(() => {
							for (const listener of portListeners) {
								listener({ action: 'DOCUMENT_READER_SNAPSHOT', snapshot: initialSnapshot });
							}
						});
					}
				},
				disconnect: () => {},
			});
			chrome.runtime.sendMessage = (message: { action?: string }, callback?: (response: unknown) => void) => {
				(window as any).readerMessages.push(message);
				callback?.(message.action === 'GET_PLAYBACK_STATE' ? { session: initialSession } : { success: true });
				return true;
			};
		},
		{ initialSession: session, initialSnapshot: snapshot },
	);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await expect(reader.locator('.document-reader-content')).toHaveText(snapshot.content);
	await expect
		.poll(() =>
			reader.evaluate(() => {
				const highlight = CSS.highlights.get('readit-document-reader-word');
				return highlight ? Array.from(highlight).map((range) => range.toString()) : [];
			}),
		)
		.toEqual(['cat']);
	const attachMessages = await reader.evaluate(() =>
		(window as any).readerMessages.filter((message: { action?: string }) => message.action === 'DOCUMENT_READER_ATTACH'),
	);
	expect(attachMessages).toEqual([{ action: 'DOCUMENT_READER_ATTACH', sessionId: session.sessionId }]);

	const stored = await reader.evaluate(async () =>
		JSON.stringify({
			local: await chrome.storage.local.get(null),
			session: await chrome.storage.session.get(null),
		}),
	);
	expect(stored).not.toContain(snapshot.content);
});

test('uses shared playback controls with toolbar and content aligned', async ({ context, extensionId }) => {
	const session: PlaybackSessionSnapshot = {
		sessionId: 'reader-ui-session',
		contentScope: 'article',
		readableSurface: 'document-reader',
		source: { kind: 'tab', tabId: 42, title: 'Reader UI', url: 'https://docs.google.com/document/d/test/edit' },
		lang: 'en',
		status: 'playing',
		currentParagraphIndex: 0,
		totalParagraphs: 1,
		progressPercentage: 50,
		voiceStyleId: 'M1',
		speed: 1.05,
		updatedAt: 1000,
	};
	const snapshot: DocumentReaderSnapshot = {
		sessionId: session.sessionId,
		title: 'Reader UI',
		content: 'Reader content',
		words: [],
		currentWordIndex: -1,
	};
	const reader = await context.newPage();
	await reader.addInitScript(
		({ initialSession, initialSnapshot }) => {
			const portListeners = new Set<Function>();
			chrome.runtime.onMessage.addListener = () => {};
			chrome.runtime.onMessage.removeListener = () => {};
			(chrome.runtime as any).connect = () => ({
				name: 'document-reader',
				onMessage: {
					addListener: (listener: Function) => portListeners.add(listener),
					removeListener: (listener: Function) => portListeners.delete(listener),
				},
				postMessage: (message: { action?: string }) => {
					if (message.action === 'DOCUMENT_READER_ATTACH') {
						queueMicrotask(() => {
							for (const listener of portListeners)
								listener({ action: 'DOCUMENT_READER_SNAPSHOT', snapshot: initialSnapshot });
						});
					}
				},
				disconnect: () => {},
			});
			chrome.runtime.sendMessage = (message: { action?: string }, callback?: (response: unknown) => void) => {
				callback?.(message.action === 'GET_PLAYBACK_STATE' ? { session: initialSession } : { success: true });
				return true;
			};
		},
		{ initialSession: session, initialSnapshot: snapshot },
	);
	await reader.goto(`chrome-extension://${extensionId}/src/reader/reader.html`);

	await expect(reader.locator('.document-reader-toolbar .btn-primary.btn-icon-only')).toBeVisible();
	await expect(reader.locator('.document-reader-toolbar .btn-secondary.btn-icon-only')).toBeVisible();
	await expect(reader.locator('#reader-voice-select.form-select')).toBeVisible();
	await expect(reader.locator('.form-group .form-slider')).toBeVisible();
	await expect(reader.locator('.document-reader-progress .progress-bar-container')).toBeVisible();
	await expect(reader.locator('.document-reader-progress .progress-bar')).toHaveAttribute('style', 'width: 50%;');

	const layout = await reader.evaluate(() => {
		const toolbar = document.querySelector('.document-reader-toolbar')?.getBoundingClientRect();
		const content = document.querySelector('.document-reader-content')?.getBoundingClientRect();
		const speedHeader = document.querySelectorAll('.slider-label-group')[0]?.getBoundingClientRect();
		const speedSlider = document.querySelector('.form-slider')?.getBoundingClientRect();
		const progressHeader = document.querySelectorAll('.slider-label-group')[1]?.getBoundingClientRect();
		const progressBar = document.querySelector('.progress-bar-container')?.getBoundingClientRect();
		if (!toolbar || !content || !speedHeader || !speedSlider || !progressHeader || !progressBar) {
			throw new Error('Reader controls missing');
		}
		return { toolbar, content, speedHeader, speedSlider, progressHeader, progressBar };
	});

	expect(Math.abs(layout.toolbar.left - layout.content.left)).toBeLessThan(1);
	expect(Math.abs(layout.toolbar.right - layout.content.right)).toBeLessThan(1);
	expect(layout.speedSlider.top).toBeGreaterThanOrEqual(layout.speedHeader.bottom);
	expect(layout.progressBar.top).toBeGreaterThanOrEqual(layout.progressHeader.bottom);
});
