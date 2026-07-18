import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPlaybackProgress, createPlaybackErrorSession, createPlaybackSession, ownsTab } from '../../src/background/playback_state.ts';

const input = {
	sessionId: 'session-1',
	tabId: 42,
	title: 'An article',
	url: 'https://example.com/article',
	lang: 'en',
	voiceStyleId: 'M1',
	speed: 1.05,
	now: 1000,
};

test('creates a loading session with default progress', () => {
	assert.deepEqual(createPlaybackSession(input), {
		sessionId: 'session-1',
		tabId: 42,
		contentScope: 'article',
		title: 'An article',
		url: 'https://example.com/article',
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

test('creates a transient extraction error session from tab metadata only', () => {
	assert.deepEqual(
		createPlaybackErrorSession({
			sessionId: 'session-2',
			tabId: 42,
			title: 'Unreadable page',
			url: 'https://example.com/unreadable',
			voiceStyleId: 'M1',
			speed: 1.05,
			error: 'Unable to extract this page.',
			now: 2000,
		}),
		{
			sessionId: 'session-2',
			tabId: 42,
			contentScope: 'article',
			title: 'Unreadable page',
			url: 'https://example.com/unreadable',
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
	const session = createPlaybackSession(input);
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
	const session = createPlaybackSession({ ...input, contentScope: 'selection' });
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
	const session = createPlaybackSession(input);
	const progress = {
		status: 'paused' as const,
		currentParagraphIndex: 1,
		totalParagraphs: 10,
		progressPercentage: 10,
	};

	assert.equal(applyPlaybackProgress(session, 'session-2', progress, 2000), null);
});

test('matches only the owning tab', () => {
	const session = createPlaybackSession(input);

	assert.equal(ownsTab(session, 42), true);
	assert.equal(ownsTab(session, 7), false);
	assert.equal(ownsTab(null, 42), false);
});

test('does not apply stale progress after the active session has been cleared', () => {
	const clearedSession = createPlaybackSession(input);
	const progress = {
		status: 'playing' as const,
		currentParagraphIndex: 4,
		totalParagraphs: 10,
		progressPercentage: 40,
	};

	const updatedAfterClear = applyPlaybackProgress(null, clearedSession.sessionId, progress, 2000);
	assert.equal(updatedAfterClear, null);

	const replacementSession = createPlaybackSession({ ...input, sessionId: 'session-2' });
	const updatedReplacement = applyPlaybackProgress(replacementSession, clearedSession.sessionId, progress, 2000);

	assert.equal(updatedReplacement, null);
});

test('does not mutate input snapshots', () => {
	const session = createPlaybackSession(input);
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
