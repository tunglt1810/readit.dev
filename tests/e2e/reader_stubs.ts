import type { Page } from '@playwright/test';

/**
 * Replace the native picker with one backed by bytes injected into the page. The handle is a
 * real OPFS one so that, as in Chrome, it survives IndexedDB and answers permission queries.
 */
export async function stubFilePicker(page: Page, fileName: string, bytes: Buffer) {
	await page.addInitScript(
		({ name, data }) => {
			(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = async () => {
				const handle = await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
				const writable = await handle.createWritable();
				await writable.write(new Uint8Array(data));
				await writable.close();
				return [handle];
			};
		},
		{ name: fileName, data: Array.from(bytes) },
	);
}

/**
 * Stand in for the background coordinator. Real playback needs the TTS model, so this
 * mirrors tests/e2e/document-reader.spec.ts and answers the reader's messages directly.
 */
export async function stubPlaybackRuntime(page: Page) {
	await page.addInitScript(() => {
		const scope = window as unknown as Record<string, unknown>;
		const runtimeListeners = new Set<(message: unknown) => void>();
		const portListeners = new Set<(message: unknown) => void>();
		const sent: { action?: string; payload?: { title: string; content: string; lang: string } }[] = [];
		// Held outside the page so that, like real playback, a session survives a tab reload.
		const STATE_KEY = 'readit-e2e-stub-playback';
		const restored = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? '{}');
		let session: Record<string, unknown> | null = restored.session ?? null;
		let snapshot: Record<string, unknown> | null = restored.snapshot ?? null;
		const persist = () => sessionStorage.setItem(STATE_KEY, JSON.stringify({ session, snapshot }));
		scope.readerMessages = sent;

		const broadcast = (message: unknown) => {
			for (const listener of runtimeListeners) {
				listener(message);
			}
		};

		chrome.runtime.onMessage.addListener = ((listener: (message: unknown) => void) => {
			runtimeListeners.add(listener);
		}) as never;
		chrome.runtime.onMessage.removeListener = ((listener: (message: unknown) => void) => {
			runtimeListeners.delete(listener);
		}) as never;

		(chrome.runtime as unknown as { connect: unknown }).connect = () => ({
			name: 'document-reader',
			onMessage: {
				addListener: (listener: (message: unknown) => void) => portListeners.add(listener),
				removeListener: (listener: (message: unknown) => void) => portListeners.delete(listener),
			},
			postMessage: (message: { action?: string }) => {
				if (message.action === 'DOCUMENT_READER_ATTACH' && snapshot) {
					queueMicrotask(() => {
						for (const listener of portListeners) {
							listener({ action: 'DOCUMENT_READER_SNAPSHOT', snapshot });
						}
					});
				}
			},
			disconnect: () => undefined,
		});

		chrome.runtime.sendMessage = ((message: { action?: string; payload?: never }, callback?: (response: unknown) => void) => {
			sent.push(message);
			if (message.action === 'GET_PLAYBACK_STATE') {
				callback?.({ session });
				return true;
			}
			if (message.action === 'START_READER_CONTENT') {
				const { title, content, lang } = message.payload as unknown as { title: string; content: string; lang: string };
				const sessionId = `session-${sent.length}`;
				session = {
					sessionId,
					contentScope: 'article',
					readableSurface: 'document-reader',
					source: { kind: 'tab', tabId: 1, title, url: title },
					lang,
					status: 'playing',
					currentParagraphIndex: 0,
					totalParagraphs: 1,
					progressPercentage: 0,
					voiceStyleId: 'M1',
					speed: 1.1,
					updatedAt: 1,
				};
				snapshot = { sessionId, title, content, words: [], currentWordIndex: -1 };
				persist();
				callback?.({ success: true, sessionId });
				queueMicrotask(() => broadcast({ action: 'PLAYBACK_STATE_UPDATE', session }));
				return true;
			}
			if (message.action === 'STOP_READING') {
				// stopActiveSession clears the session outright; the reader keeps the text it was
				// handed, so the page stays on screen with nothing playing.
				session = null;
				persist();
				callback?.({ success: true });
				queueMicrotask(() => broadcast({ action: 'PLAYBACK_STATE_UPDATE', session: null }));
				return true;
			}
			callback?.({ success: true });
			return true;
		}) as never;

		scope.completeChapter = () => {
			const finished = session;
			session = null;
			snapshot = null;
			persist();
			broadcast({ action: 'PLAYBACK_STATE_UPDATE', session: null });
			broadcast({ action: 'DOCUMENT_READER_COMPLETED', sessionId: finished?.sessionId });
		};

		/** The offscreen host answers a play with an export estimate, which the background pins
		    onto the session. Until it lands there is nothing to export. */
		scope.attachExportEstimate = () => {
			if (!session) {
				return;
			}
			session = { ...session, audioExportEstimate: { durationSeconds: 120, estimatedBytes: 1_920_000 } };
			persist();
			broadcast({ action: 'PLAYBACK_STATE_UPDATE', session });
		};

		/** The background reuses this tab for a web page, so the reader can be handed one next. */
		scope.attachTabSession = () => {
			const sessionId = 'tab-session';
			session = {
				sessionId,
				contentScope: 'article',
				readableSurface: 'document-reader',
				source: { kind: 'tab', tabId: 7, title: 'A web page', url: 'https://example.com/article' },
				lang: 'en',
				status: 'playing',
				currentParagraphIndex: 0,
				totalParagraphs: 1,
				progressPercentage: 0,
				voiceStyleId: 'M1',
				speed: 1.1,
				updatedAt: 2,
			};
			snapshot = { sessionId, title: 'A web page', content: 'Web page text.', words: [], currentWordIndex: -1 };
			persist();
			broadcast({ action: 'PLAYBACK_STATE_UPDATE', session });
		};

		/** A session still playing from before this tab reloaded, which this book never started. */
		scope.completeStaleSession = () => broadcast({ action: 'DOCUMENT_READER_COMPLETED', sessionId: 'stale-session' });
	});
}
