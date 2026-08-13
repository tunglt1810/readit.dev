import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalBookSession } from '../../src/shared/local_book_session.ts';
import type { PlaybackSessionSnapshot } from '../../src/shared/types.ts';

function documentSession(url: string, title: string): PlaybackSessionSnapshot {
	return {
		sessionId: 'session-1',
		contentScope: 'article',
		readableSurface: 'document-reader',
		source: { kind: 'tab', tabId: 7, title, url },
		lang: 'en',
		status: 'playing',
		currentParagraphIndex: 0,
		totalParagraphs: 3,
		progressPercentage: 0,
		voiceStyleId: 'M1',
		speed: 1.1,
		updatedAt: 0,
	};
}

test('a locally opened book is recognized', () => {
	assert.equal(isLocalBookSession(documentSession('novel.epub', 'novel.epub')), true);
	assert.equal(isLocalBookSession(documentSession('report.pdf', 'report.pdf')), true);
});

test('a tab-attached PDF or Google Doc is not a local book', () => {
	assert.equal(isLocalBookSession(documentSession('https://example.com/q2.pdf', 'Q2 report')), false);
	assert.equal(isLocalBookSession(documentSession('file:///Users/me/q2.pdf', 'Q2 report')), false);
});

test('non-document surfaces and empty sessions are not local books', () => {
	const website = documentSession('novel.epub', 'novel.epub');
	assert.equal(isLocalBookSession({ ...website, readableSurface: 'website-dom' }), false);
	assert.equal(isLocalBookSession(null), false);
});
