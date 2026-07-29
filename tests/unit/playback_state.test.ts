import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyAudioExportEstimate,
	applyPlaybackProgress,
	createPlaybackErrorSession,
	createPlaybackSession,
	isPlaybackSessionSnapshot,
	isSameDocumentUrl,
	ownsTab,
} from '../../src/background/playback_state.ts';
import { createAudioExportEstimate } from '../../src/shared/audio_export.ts';

const tabInput = {
	sessionId: 'session-1',
	contentScope: 'article' as const,
	source: { kind: 'tab' as const, tabId: 42, title: 'An article', url: 'https://example.com/article' },
	readableSurface: 'website-dom' as const,
	lang: 'en',
	voiceStyleId: 'M1',
	speed: 1.05,
	now: 1000,
};

const manualSource = { kind: 'manual' as const, panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd' };

test('creates a tab-owned loading session', () => {
	assert.deepEqual(createPlaybackSession(tabInput), {
		sessionId: 'session-1',
		contentScope: 'article',
		source: { kind: 'tab', tabId: 42, title: 'An article', url: 'https://example.com/article' },
		readableSurface: 'website-dom',
		lang: 'en',
		status: 'loading',
		currentParagraphIndex: 0,
		totalParagraphs: 0,
		progressPercentage: 0,
		voiceStyleId: 'M1',
		speed: 1.05,
		updatedAt: 1000,
	});
});

test('creates a manual loading session without tab metadata', () => {
	const session = createPlaybackSession({
		sessionId: 'manual-1',
		contentScope: 'manual',
		source: manualSource,
		readableSurface: 'manual-reader',
		lang: 'vi',
		voiceStyleId: 'F1',
		speed: 1.1,
		now: 2000,
	});
	assert.deepEqual(session.source, manualSource);
	assert.equal('tabId' in session.source, false);
	assert.equal(isPlaybackSessionSnapshot(session), true);
	assert.equal(isPlaybackSessionSnapshot({ ...session, error: 'Expected manual error' }), true);
});

test('rejects forbidden top-level fields on manual sessions', () => {
	const manual = createPlaybackSession({
		sessionId: 'manual-1',
		contentScope: 'manual',
		source: manualSource,
		readableSurface: 'manual-reader',
		lang: 'en',
		voiceStyleId: 'M1',
		speed: 1.05,
		now: 1000,
	});

	for (const field of ['text', 'content', 'tabId', 'title', 'url', 'unexpected']) {
		assert.equal(isPlaybackSessionSnapshot({ ...manual, [field]: 'forbidden' }), false, field);
	}
});

test('persists valid surfaces and rejects invalid source-surface combinations', () => {
	const website = createPlaybackSession(tabInput);
	assert.equal(website.readableSurface, 'website-dom');

	const textOnly = createPlaybackSession({ ...tabInput, readableSurface: 'none' });
	assert.equal(textOnly.readableSurface, 'none');

	const document = createPlaybackSession({ ...tabInput, readableSurface: 'document-reader' });
	assert.equal(document.readableSurface, 'document-reader');

	const manual = createPlaybackSession({
		sessionId: 'manual-surface',
		contentScope: 'manual',
		source: manualSource,
		readableSurface: 'manual-reader',
		lang: 'en',
		voiceStyleId: 'M1',
		speed: 1.05,
		now: 1000,
	});
	assert.equal(manual.readableSurface, 'manual-reader');

	assert.equal(isPlaybackSessionSnapshot(website), true);
	assert.equal(isPlaybackSessionSnapshot(document), true);
	assert.equal(
		isPlaybackSessionSnapshot(createPlaybackSession({ ...tabInput, sessionId: 'selection', contentScope: 'selection' })),
		true,
	);
	assert.equal(isPlaybackSessionSnapshot({ ...website, readableSurface: 'manual-reader' }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...document, contentScope: 'selection' }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...manual, readableSurface: 'website-dom' }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...website, readableSurface: undefined }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...website, contentScope: 'manual' }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...website, source: manualSource }), false);
});

test('creates a transient extraction error session from tab metadata only', () => {
	assert.deepEqual(
		createPlaybackErrorSession({
			sessionId: 'session-2',
			source: { kind: 'tab', tabId: 42, title: 'Unreadable page', url: 'https://example.com/unreadable' },
			voiceStyleId: 'M1',
			speed: 1.05,
			error: 'Unable to extract this page.',
			now: 2000,
		}),
		{
			sessionId: 'session-2',
			contentScope: 'article',
			source: { kind: 'tab', tabId: 42, title: 'Unreadable page', url: 'https://example.com/unreadable' },
			readableSurface: 'none',
			lang: 'und',
			status: 'error',
			currentParagraphIndex: 0,
			totalParagraphs: 0,
			progressPercentage: 0,
			voiceStyleId: 'M1',
			speed: 1.05,
			error: 'Unable to extract this page.',
			updatedAt: 2000,
		},
	);
});

test('applies progress while preserving session metadata', () => {
	const session = createPlaybackSession(tabInput);
	const progress = {
		status: 'playing' as const,
		currentParagraphIndex: 3,
		totalParagraphs: 10,
		progressPercentage: 30,
		error: undefined,
	};

	assert.deepEqual(applyPlaybackProgress(session, 'session-1', progress, 2000), {
		...session,
		status: 'playing',
		currentParagraphIndex: 3,
		totalParagraphs: 10,
		progressPercentage: 30,
		error: undefined,
		updatedAt: 2000,
	});
});

test('creates and preserves a selected-text content scope', () => {
	const session = createPlaybackSession({ ...tabInput, contentScope: 'selection' });
	assert.equal(session.contentScope, 'selection');

	const updated = applyPlaybackProgress(
		session,
		session.sessionId,
		{ status: 'playing', currentParagraphIndex: 1, totalParagraphs: 2, progressPercentage: 50 },
		2000,
	);

	assert.equal(updated?.contentScope, 'selection');
});

test('rejects progress for another session', () => {
	const session = createPlaybackSession(tabInput);
	const progress = {
		status: 'paused' as const,
		currentParagraphIndex: 1,
		totalParagraphs: 10,
		progressPercentage: 10,
	};

	assert.equal(applyPlaybackProgress(session, 'session-2', progress, 2000), null);
});

test('matches only the owning tab', () => {
	const session = createPlaybackSession(tabInput);

	assert.equal(ownsTab(session, 42), true);
	assert.equal(ownsTab(session, 7), false);
	assert.equal(ownsTab(null, 42), false);
});

const doc = 'https://docs.google.com/document/d/abc/edit';

test('treats a fragment-only change as the same document', () => {
	// Google Docs rewrites `#heading=…` whenever the caret moves, and Chrome reports that as an
	// ordinary `status: "loading"` update — indistinguishable from a real navigation without
	// comparing the URLs themselves.
	assert.equal(isSameDocumentUrl(`${doc}?tab=t.0`, `${doc}?tab=t.0#heading=h.7v`), true);
	assert.equal(isSameDocumentUrl(`${doc}#heading=h.1`, `${doc}#heading=h.9`), true);
	assert.equal(isSameDocumentUrl('https://example.com/article', 'https://example.com/article'), true);
});

test('treats path, query, and origin changes as leaving the document', () => {
	assert.equal(isSameDocumentUrl(doc, 'https://docs.google.com/document/d/xyz/edit'), false);
	assert.equal(isSameDocumentUrl('https://example.com/article', 'https://example.com/article?page=2'), false);
	assert.equal(isSameDocumentUrl('https://example.com/article', 'https://other.example.com/article'), false);
	// An unparsable URL is not evidence that the reader stayed put, so it must not suppress a stop.
	assert.equal(isSameDocumentUrl('https://example.com/article', 'not a url'), false);
});

test('manual sessions never own browser tabs', () => {
	const manual = createPlaybackSession({
		sessionId: 'manual-1',
		contentScope: 'manual',
		source: manualSource,
		readableSurface: 'manual-reader',
		lang: 'en',
		voiceStyleId: 'M1',
		speed: 1.05,
		now: 1000,
	});
	assert.equal(ownsTab(manual, 42), false);
});

test('rejects manual snapshots with invalid owners or extra source fields', () => {
	const manual = createPlaybackSession({
		sessionId: 'manual-1',
		contentScope: 'manual',
		source: manualSource,
		readableSurface: 'manual-reader',
		lang: 'en',
		voiceStyleId: 'M1',
		speed: 1.05,
		now: 1000,
	});

	assert.equal(isPlaybackSessionSnapshot({ ...manual, source: { kind: 'manual', panelInstanceId: '' } }), false);
	assert.equal(
		isPlaybackSessionSnapshot({ ...manual, source: { ...manualSource, text: 'forbidden' } }),
		false,
	);
});

test('does not apply stale progress after the active session has been cleared', () => {
	const clearedSession = createPlaybackSession(tabInput);
	const progress = {
		status: 'playing' as const,
		currentParagraphIndex: 4,
		totalParagraphs: 10,
		progressPercentage: 40,
	};

	const updatedAfterClear = applyPlaybackProgress(null, clearedSession.sessionId, progress, 2000);
	assert.equal(updatedAfterClear, null);

	const replacementSession = createPlaybackSession({ ...tabInput, sessionId: 'session-2' });
	const updatedReplacement = applyPlaybackProgress(replacementSession, clearedSession.sessionId, progress, 2000);

	assert.equal(updatedReplacement, null);
});

test('does not mutate input snapshots', () => {
	const session = createPlaybackSession(tabInput);
	const original = structuredClone(session);
	const progress = {
		status: 'error' as const,
		currentParagraphIndex: 2,
		totalParagraphs: 10,
		progressPercentage: 20,
		error: 'TTS failed',
	};

	const updated = applyPlaybackProgress(session, 'session-1', progress, 3000);

	assert.deepEqual(session, original);
	assert.notEqual(updated, session);
});

test('hydrates a valid audio export estimate and preserves session metadata', () => {
	const session = createPlaybackSession(tabInput);
	const estimate = createAudioExportEstimate(120);

	assert.deepEqual(applyAudioExportEstimate(session, session.sessionId, estimate, 2_000), {
		...session,
		audioExportEstimate: estimate,
		updatedAt: 2_000,
	});
});

test('ignores stale or malformed audio export estimates during hydration', () => {
	const session = createPlaybackSession(tabInput);
	const estimate = createAudioExportEstimate(120);

	assert.equal(applyAudioExportEstimate(session, 'stale-session', estimate, 2_000), null);
	assert.equal(isPlaybackSessionSnapshot({ ...session, audioExportEstimate: estimate }), true);
	assert.equal(isPlaybackSessionSnapshot({ ...session, audioExportEstimate: { durationSeconds: 1, estimatedBytes: -1 } }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...session, audioExportEstimate: { durationSeconds: Number.NaN, estimatedBytes: 1 } }), false);
});

test('does not attach a late PLAY estimate to a replacement session', () => {
	const replacement = createPlaybackSession({ ...tabInput, sessionId: 'replacement-session' });
	assert.equal(applyAudioExportEstimate(replacement, tabInput.sessionId, createAudioExportEstimate(120), 2_000), null);
	assert.equal(replacement.audioExportEstimate, undefined);
});

test('replaces the current snapshot estimate after a speed change', () => {
	const session = createPlaybackSession(tabInput);
	const original = applyAudioExportEstimate(session, session.sessionId, createAudioExportEstimate(120), 1_000);
	assert.ok(original);
	const recalculated = applyAudioExportEstimate(original, original.sessionId, createAudioExportEstimate(60), 2_000);
	assert.deepEqual(recalculated?.audioExportEstimate, createAudioExportEstimate(60));
});
