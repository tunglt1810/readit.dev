import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyPlaybackProgress,
	createPlaybackErrorSession,
	createPlaybackSession,
	isPlaybackSessionSnapshot,
	ownsTab,
} from '../../src/background/playback_state.ts';

const tabInput = {
	sessionId: 'session-1',
	contentScope: 'article' as const,
	source: { kind: 'tab' as const, tabId: 42, title: 'An article', url: 'https://example.com/article' },
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
		lang: 'en',
		voiceStyleId: 'M1',
		speed: 1.05,
		now: 1000,
	});

	for (const field of ['text', 'content', 'tabId', 'title', 'url', 'unexpected']) {
		assert.equal(isPlaybackSessionSnapshot({ ...manual, [field]: 'forbidden' }), false, field);
	}
});

test('validates only legal source and scope combinations', () => {
	assert.equal(isPlaybackSessionSnapshot(createPlaybackSession(tabInput)), true);
	assert.equal(
		isPlaybackSessionSnapshot(createPlaybackSession({ ...tabInput, sessionId: 'selection', contentScope: 'selection' })),
		true,
	);
	assert.equal(isPlaybackSessionSnapshot({ ...createPlaybackSession(tabInput), contentScope: 'manual' }), false);
	assert.equal(isPlaybackSessionSnapshot({ ...createPlaybackSession(tabInput), source: manualSource }), false);
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

test('manual sessions never own browser tabs', () => {
	const manual = createPlaybackSession({
		sessionId: 'manual-1',
		contentScope: 'manual',
		source: manualSource,
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
