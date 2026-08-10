import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadableSurfaceCoordinator } from '../../src/background/readable_surface.ts';
import type { DocumentReaderPortMessage, DocumentReaderSnapshot } from '../../src/shared/document_reader.ts';
import type { ReadableSurfaceInitMessage, ReadableSurfaceUpdateMessage, ReadableSurfaceWord } from '../../src/shared/readable_surface.ts';
import type { PlaybackSessionSnapshot } from '../../src/shared/types.ts';

const words: readonly ReadableSurfaceWord[] = [
	{ text: 'First', globalIndex: 0 },
	{ text: 'Second', globalIndex: 1 },
];

const websiteSession: PlaybackSessionSnapshot = {
	sessionId: 'website-session',
	contentScope: 'article',
	readableSurface: 'website-dom',
	source: { kind: 'tab', tabId: 42, title: 'Article', url: 'https://example.com/article' },
	lang: 'en',
	status: 'loading',
	currentParagraphIndex: 0,
	totalParagraphs: 0,
	progressPercentage: 0,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

const manualSession: PlaybackSessionSnapshot = {
	sessionId: 'manual-session',
	contentScope: 'manual',
	readableSurface: 'manual-reader',
	source: { kind: 'manual', panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' },
	lang: 'en',
	status: 'loading',
	currentParagraphIndex: 0,
	totalParagraphs: 0,
	progressPercentage: 0,
	voiceStyleId: 'M1',
	speed: 1.05,
	updatedAt: 1000,
};

const noSurfaceSession: PlaybackSessionSnapshot = {
	...websiteSession,
	sessionId: 'text-only-session',
	readableSurface: 'none',
};

const documentSession: PlaybackSessionSnapshot = {
	...websiteSession,
	sessionId: 'document-session',
	readableSurface: 'document-reader',
};

const documentSnapshot: DocumentReaderSnapshot = {
	sessionId: documentSession.sessionId,
	title: 'Document',
	content: 'First Second',
	words,
	currentWordIndex: 0,
};

function initMessage(
	contentScope: ReadableSurfaceInitMessage['contentScope'],
	sessionId = websiteSession.sessionId,
): ReadableSurfaceInitMessage {
	return { action: 'READABLE_SURFACE_INIT', sessionId, contentScope, words };
}

function updateMessage(wordIndex: number, word: string, sessionId = websiteSession.sessionId): ReadableSurfaceUpdateMessage {
	return { action: 'READABLE_SURFACE_UPDATE', sessionId, wordIndex, word };
}

function createHarness(options: { rejectTab?: boolean; rejectRuntime?: boolean } = {}) {
	const sentToTab: { tabId: number; message: unknown }[] = [];
	const sentToRuntime: unknown[] = [];
	const queued: (() => Promise<void>)[] = [];
	const detachedDocumentSessions: string[] = [];
	const coordinator = createReadableSurfaceCoordinator({
		sendTabMessage: async (tabId, message) => {
			sentToTab.push({ tabId, message });
			if (options.rejectTab) {
				throw new Error('Tab unavailable');
			}
			return { success: true };
		},
		sendRuntimeMessage: async (message) => {
			sentToRuntime.push(message);
			if (options.rejectRuntime) {
				throw new Error('Runtime unavailable');
			}
			return undefined;
		},
		requestDocumentReaderSnapshot: async (sessionId) => (sessionId === documentSession.sessionId ? documentSnapshot : null),
		detachDocumentReader: async (sessionId) => {
			detachedDocumentSessions.push(sessionId);
		},
		enqueue: (operation) => queued.push(operation),
	});
	return { coordinator, detachedDocumentSessions, queued, sentToRuntime, sentToTab };
}

test('initializes Website DOM before coalesced index updates', async () => {
	const { coordinator, queued, sentToTab } = createHarness();
	coordinator.activate(websiteSession);

	assert.deepEqual(await coordinator.initialize(initMessage('article')), { success: true });
	coordinator.advance(updateMessage(0, 'First'));
	coordinator.advance(updateMessage(1, 'Second'));
	await queued.shift()?.();

	assert.deepEqual(sentToTab, [
		{
			tabId: 42,
			message: {
				action: 'WORD_HIGHLIGHT_INIT',
				sessionId: websiteSession.sessionId,
				contentScope: 'article',
				words,
			},
		},
		{
			tabId: 42,
			message: {
				action: 'WORD_HIGHLIGHT_UPDATE',
				sessionId: websiteSession.sessionId,
				wordIndex: 1,
			},
		},
	]);
});

test('ignores Website updates until initialization succeeds', async () => {
	const { coordinator, queued, sentToTab } = createHarness();
	coordinator.activate(websiteSession);

	coordinator.advance(updateMessage(0, 'First'));
	await queued.shift()?.();

	assert.deepEqual(sentToTab, []);
});

test('a session restored after a worker restart keeps projecting without a second handshake', async () => {
	// Chrome evicts an idle MV3 worker after ~30s, so any pause longer than that revives a
	// cold worker holding none of the READABLE_SURFACE_INIT handshake. The content script
	// still has its word list and offscreen never sends INIT again, so demanding the
	// handshake here drops every remaining update and freezes the highlight for good.
	const { coordinator, queued, sentToTab } = createHarness();
	coordinator.restore(websiteSession);

	coordinator.advance(updateMessage(1, 'Second'));
	await queued.shift()?.();

	assert.deepEqual(sentToTab, [
		{ tabId: 42, message: { action: 'WORD_HIGHLIGHT_UPDATE', sessionId: websiteSession.sessionId, wordIndex: 1 } },
	]);
});

test('a restored session stops projecting once the tab turns out to be gone', async () => {
	// Assuming the projection survived is only safe because a vanished tab corrects it:
	// the page may have been reloaded while the worker was asleep.
	const { coordinator, queued, sentToTab } = createHarness({ rejectTab: true });
	coordinator.restore(websiteSession);

	coordinator.advance(updateMessage(1, 'Second'));
	await queued.shift()?.();
	coordinator.advance(updateMessage(2, 'Third'));
	await queued.shift()?.();

	assert.equal(sentToTab.length, 1);
});

test('rejects Website initialization when the message scope differs from the active session', async () => {
	const { coordinator, sentToTab } = createHarness();
	const selectionSession: PlaybackSessionSnapshot = {
		...websiteSession,
		sessionId: 'selection-session',
		contentScope: 'selection',
	};
	coordinator.activate(selectionSession);

	assert.deepEqual(await coordinator.initialize(initMessage('article', selectionSession.sessionId)), { success: false });
	assert.deepEqual(sentToTab, []);
});

test('does not make a replacement Website session ready when an older initialization resolves', async () => {
	const queued: (() => Promise<void>)[] = [];
	const sentToTab: unknown[] = [];
	let resolveInitialization: ((value: unknown) => void) | undefined;
	const pendingInitialization = new Promise<unknown>((resolve) => {
		resolveInitialization = resolve;
	});
	const coordinator = createReadableSurfaceCoordinator({
		sendTabMessage: async (_tabId, message) => {
			sentToTab.push(message);
			if ((message as { action?: unknown }).action === 'WORD_HIGHLIGHT_INIT') {
				return pendingInitialization;
			}
			return { success: true };
		},
		sendRuntimeMessage: async () => undefined,
		requestDocumentReaderSnapshot: async () => null,
		detachDocumentReader: async () => undefined,
		enqueue: (operation) => queued.push(operation),
	});
	const replacementSession: PlaybackSessionSnapshot = {
		...websiteSession,
		sessionId: 'replacement-session',
	};

	coordinator.activate(websiteSession);
	const initialization = coordinator.initialize(initMessage('article'));
	coordinator.activate(replacementSession);
	resolveInitialization?.({ success: true });

	assert.deepEqual(await initialization, { success: false });
	coordinator.advance(updateMessage(0, 'First', replacementSession.sessionId));
	await queued.shift()?.();
	assert.equal(
		sentToTab.some((message) => (message as { action?: unknown }).action === 'WORD_HIGHLIGHT_UPDATE'),
		false,
	);
});

test('accepts Manual Reader initialization and broadcasts every update', async () => {
	const { coordinator, sentToRuntime } = createHarness();
	coordinator.activate(manualSession);

	assert.deepEqual(await coordinator.initialize(initMessage('manual', manualSession.sessionId)), { success: true });
	coordinator.advance(updateMessage(0, 'First', manualSession.sessionId));
	coordinator.advance(updateMessage(1, 'Second', manualSession.sessionId));

	assert.deepEqual(sentToRuntime, [
		{
			action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
			sessionId: manualSession.sessionId,
			word: 'First',
			wordIndex: 0,
		},
		{
			action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
			sessionId: manualSession.sessionId,
			word: 'Second',
			wordIndex: 1,
		},
	]);
});

test('attaches one Document Reader owner and routes snapshot, update, and clear', async () => {
	const { coordinator } = createHarness();
	const delivered: DocumentReaderPortMessage[] = [];
	coordinator.activate(documentSession);

	assert.deepEqual(await coordinator.initialize(initMessage('article', documentSession.sessionId)), { success: false });
	assert.equal(
		await coordinator.attachDocumentReader({
			tabId: 77,
			sessionId: documentSession.sessionId,
			deliver: (message) => delivered.push(message),
		}),
		true,
	);
	assert.deepEqual(await coordinator.initialize(initMessage('article', documentSession.sessionId)), { success: true });
	coordinator.advance(updateMessage(1, 'Second', documentSession.sessionId));
	await coordinator.clear(documentSession.sessionId);

	assert.deepEqual(delivered, [
		{ action: 'DOCUMENT_READER_SNAPSHOT', snapshot: documentSnapshot },
		{ action: 'DOCUMENT_READER_SNAPSHOT', snapshot: documentSnapshot },
		{ action: 'DOCUMENT_READER_UPDATE', sessionId: documentSession.sessionId, wordIndex: 1 },
		{ action: 'DOCUMENT_READER_CLEAR', sessionId: documentSession.sessionId },
	]);
	assert.equal(coordinator.documentReaderTabId(), 77);
});

test('detaches a Document Reader without affecting playback', async () => {
	const { coordinator, detachedDocumentSessions } = createHarness();
	const delivered: DocumentReaderPortMessage[] = [];
	coordinator.activate(documentSession);
	await coordinator.attachDocumentReader({
		tabId: 77,
		sessionId: documentSession.sessionId,
		deliver: (message) => delivered.push(message),
	});

	await coordinator.detachDocumentReader(77);
	coordinator.advance(updateMessage(1, 'Second', documentSession.sessionId));

	assert.deepEqual(detachedDocumentSessions, [documentSession.sessionId]);
	assert.deepEqual(delivered, [{ action: 'DOCUMENT_READER_SNAPSHOT', snapshot: documentSnapshot }]);
	assert.equal(coordinator.documentReaderTabId(), null);
});

test('rejects initialization when the active session has no readable surface', async () => {
	const { coordinator, sentToRuntime, sentToTab } = createHarness();
	coordinator.activate(noSurfaceSession);

	assert.deepEqual(await coordinator.initialize(initMessage('article', noSurfaceSession.sessionId)), { success: false });
	assert.deepEqual(sentToTab, []);
	assert.deepEqual(sentToRuntime, []);
});

test('stale lifecycle messages cannot affect a replacement session', async () => {
	const { coordinator, sentToRuntime, sentToTab } = createHarness();
	coordinator.activate(websiteSession);
	coordinator.activate(manualSession);

	assert.deepEqual(await coordinator.initialize(initMessage('article')), { success: false });
	coordinator.advance(updateMessage(0, 'Stale'));
	await coordinator.clear(websiteSession.sessionId);

	assert.deepEqual(await coordinator.initialize(initMessage('manual', manualSession.sessionId)), { success: true });
	coordinator.advance(updateMessage(1, 'Current', manualSession.sessionId));

	assert.deepEqual(sentToTab, []);
	assert.deepEqual(sentToRuntime, [
		{
			action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
			sessionId: manualSession.sessionId,
			word: 'Current',
			wordIndex: 1,
		},
	]);
});

test('clears Website DOM and discards its queued update', async () => {
	const { coordinator, queued, sentToTab } = createHarness();
	coordinator.activate(websiteSession);
	await coordinator.initialize(initMessage('article'));
	coordinator.advance(updateMessage(0, 'First'));

	await coordinator.clear(websiteSession.sessionId);
	await queued.shift()?.();

	assert.deepEqual(sentToTab.at(-1), {
		tabId: 42,
		message: { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: websiteSession.sessionId },
	});
	assert.equal(
		sentToTab.some(({ message }) => (message as { action?: unknown }).action === 'WORD_HIGHLIGHT_UPDATE'),
		false,
	);
});

test('clears Manual Reader through the runtime channel', async () => {
	const { coordinator, sentToRuntime } = createHarness();
	coordinator.activate(manualSession);

	await coordinator.clear(manualSession.sessionId);

	assert.deepEqual(sentToRuntime, [{ action: 'MANUAL_WORD_HIGHLIGHT_CLEAR', sessionId: manualSession.sessionId }]);
});

test('contains tab and runtime delivery failures inside the surface boundary', async () => {
	const tabHarness = createHarness({ rejectTab: true });
	tabHarness.coordinator.activate(websiteSession);
	assert.deepEqual(await tabHarness.coordinator.initialize(initMessage('article')), { success: false });
	await tabHarness.coordinator.clear(websiteSession.sessionId);

	const runtimeHarness = createHarness({ rejectRuntime: true });
	runtimeHarness.coordinator.activate(manualSession);
	runtimeHarness.coordinator.advance(updateMessage(0, 'First', manualSession.sessionId));
	await runtimeHarness.coordinator.clear(manualSession.sessionId);
});
