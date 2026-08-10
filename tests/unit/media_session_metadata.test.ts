import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMediaSessionMetadata } from '../../src/shared/media_session_metadata.ts';

const LABELS = { selection: 'Selected text', manual: 'Manual text' };

test('article uses the page title and hostname', () => {
	const metadata = buildMediaSessionMetadata({ contentScope: 'article', title: 'Bài X', url: 'https://vnexpress.net/bai-x' }, LABELS);
	assert.deepEqual(metadata, { title: 'Bài X', artist: 'vnexpress.net' });
});

test('selection uses the generic label, never the selected text', () => {
	const metadata = buildMediaSessionMetadata(
		{ contentScope: 'selection', title: 'đoạn người dùng bôi đen', url: 'https://vnexpress.net/bai-x' },
		LABELS,
	);
	assert.equal(metadata.title, 'Selected text');
	assert.equal(metadata.artist, 'vnexpress.net');
});

test('manual uses the generic label and no host', () => {
	const metadata = buildMediaSessionMetadata({ contentScope: 'manual', title: 'text người dùng dán vào', url: undefined }, LABELS);
	assert.equal(metadata.title, 'Manual text');
	assert.equal(metadata.artist, 'readit.dev');
});

test('title carrying user content never reaches metadata for selection or manual', () => {
	// The title lands on the OS Now Playing tile and can show on a lock screen.
	// Pushing pasted or selected text out of the browser is a leak, so this is a
	// negative assertion held by a test rather than a note in a doc.
	const secret = 'số tài khoản 0123456789';
	for (const contentScope of ['selection', 'manual'] as const) {
		const metadata = buildMediaSessionMetadata({ contentScope, title: secret, url: 'https://x.test/a' }, LABELS);
		assert.ok(!metadata.title.includes(secret));
		assert.ok(!metadata.artist.includes(secret));
	}
});

test('unparseable url falls back instead of throwing', () => {
	const metadata = buildMediaSessionMetadata({ contentScope: 'article', title: 'Bài X', url: 'not a url' }, LABELS);
	assert.deepEqual(metadata, { title: 'Bài X', artist: 'readit.dev' });
});

test('missing url falls back', () => {
	const metadata = buildMediaSessionMetadata({ contentScope: 'article', title: 'Bài X', url: undefined }, LABELS);
	assert.equal(metadata.artist, 'readit.dev');
});

test('blank title falls back so the tile is never empty', () => {
	const metadata = buildMediaSessionMetadata({ contentScope: 'article', title: '   ', url: 'https://vnexpress.net/bai-x' }, LABELS);
	assert.equal(metadata.title, 'readit.dev');
});

test('title is trimmed', () => {
	const metadata = buildMediaSessionMetadata({ contentScope: 'article', title: '  Bài X  ', url: 'https://vnexpress.net/bai-x' }, LABELS);
	assert.equal(metadata.title, 'Bài X');
});
