import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookSession } from '../../src/reader/book_session.ts';
import type { BookProgressRecord } from '../../src/shared/book_progress_store.ts';
import type { BookSource } from '../../src/shared/book_source.ts';

function fakeBook(chapters: string[]): BookSource {
	return {
		title: 'Test Book',
		lang: 'en',
		chapterCount: chapters.length,
		getChapterText: async (index) => chapters[index] ?? '',
	};
}

function harness(chapters: string[]) {
	const started: { title: string; content: string; lang: string }[] = [];
	const saved: BookProgressRecord[] = [];
	const session = createBookSession({
		book: fakeBook(chapters),
		file: { name: 'book.epub', size: 1234, lastModified: 999 },
		startChapter: async (payload) => {
			started.push(payload);
			return { success: true, sessionId: `session-${started.length}` };
		},
		saveProgress: async (record) => {
			saved.push(record);
		},
		now: () => 1_700_000_000_000,
	});
	return { session, started, saved };
}

test('starting plays the requested chapter from the requested offset', async () => {
	const { session, started } = harness(['First chapter text.', 'Second chapter text.']);
	assert.equal(await session.start({ chapterIndex: 1, charOffset: 'Second '.length }), true);
	assert.equal(started.length, 1);
	assert.equal(started[0].content, 'chapter text.');
	assert.equal(session.state().index, 1);
});

test('advancing moves to the next chapter from its beginning', async () => {
	const { session, started } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.advance(), true);
	assert.equal(started[1].content, 'Second chapter.');
	assert.equal(session.state().index, 1);
});

test('advancing skips chapters with no extractable text', async () => {
	const { session, started } = harness(['First chapter.', '', '   ', 'Fourth chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.advance(), true);
	assert.equal(started[1].content, 'Fourth chapter.');
	assert.equal(session.state().index, 3);
});

test('going back plays the preceding chapter from its beginning', async () => {
	const { session, started } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 1, charOffset: 0 });
	assert.equal(await session.previous(), true);
	assert.equal(started[1].content, 'First chapter.');
	assert.equal(session.state().index, 0);
});

test('going back skips chapters with no extractable text', async () => {
	const { session, started } = harness(['First chapter.', '', '   ', 'Fourth chapter.']);
	await session.start({ chapterIndex: 3, charOffset: 0 });
	assert.equal(await session.previous(), true);
	assert.equal(started[1].content, 'First chapter.');
	assert.equal(session.state().index, 0);
});

test('going back from the first chapter leaves the playing chapter alone', async () => {
	const { session, started } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 'First '.length });

	assert.equal(await session.previous(), false);
	assert.equal(started.length, 1);
	assert.equal(session.state().index, 0);
	// The chapter that is still playing must keep chaining once it finishes.
	assert.equal(session.isPlaying('session-1'), true);
});

test('advancing past the last chapter reports the book is finished', async () => {
	const { session } = harness(['Only chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.advance(), false);
});

test('recorded positions are rebased onto the resumed slice', async () => {
	const { session, saved } = harness(['First chapter text here.']);
	await session.start({ chapterIndex: 0, charOffset: 'First '.length });
	session.recordPosition('chapter '.length);
	await session.flush();

	assert.equal(saved.at(-1)?.charOffset, 'First chapter '.length);
	assert.equal(saved.at(-1)?.chapterIndex, 0);
	assert.equal(saved.at(-1)?.totalChapters, 1);
	assert.equal(saved.at(-1)?.fileSize, 1234);
	assert.equal(saved.at(-1)?.fileLastModified, 999);
});

test('only the playback session that is actually playing a chapter can advance the book', async () => {
	const { session, started } = harness(['First chapter.', 'Second chapter.']);
	assert.equal(session.isPlaying('session-1'), false);

	await session.start({ chapterIndex: 0, charOffset: 0 });

	// A session left over from before this book was opened must not chain the next chapter.
	assert.equal(session.isPlaying('stale-session'), false);
	assert.equal(session.isPlaying('session-1'), true);

	await session.advance();
	assert.equal(session.isPlaying('session-1'), false);
	assert.equal(session.isPlaying('session-2'), true);
	assert.equal(started.length, 2);
});

test('a chapter the background refused to start never claims the session', async () => {
	const started: string[] = [];
	const session = createBookSession({
		book: fakeBook(['First chapter.', 'Second chapter.']),
		file: { name: 'book.epub', size: 1, lastModified: 2 },
		startChapter: async (payload) => {
			started.push(payload.content);
			return { success: false };
		},
		saveProgress: async () => undefined,
		now: () => 1,
	});

	assert.equal(await session.start({ chapterIndex: 0, charOffset: 0 }), false);
	assert.equal(session.isPlaying('session-1'), false);
	assert.equal(started.length, 2);
});

test('adopting a chapter that is already playing chains from it without restarting it', async () => {
	const { session, started, saved } = harness(['First chapter text here.', 'Second chapter.']);

	// The tab reloaded mid-chapter: the audio never stopped, so there is nothing to start.
	await session.adopt({ chapterIndex: 0, sessionId: 'surviving-session', playingText: 'chapter text here.' });

	assert.deepEqual(started, []);
	assert.equal(session.isPlaying('surviving-session'), true);
	assert.equal(session.state().index, 0);

	// Offsets reported against the playing slice still resolve to the whole chapter.
	session.recordPosition('chapter '.length);
	await session.flush();
	assert.equal(saved.at(-1)?.charOffset, 'First chapter '.length);

	assert.equal(await session.advance(), true);
	assert.equal(started[0].content, 'Second chapter.');
});

test('adopting the whole chapter leaves no phantom offset', async () => {
	const { session, saved } = harness(['First chapter text here.']);

	await session.adopt({ chapterIndex: 0, sessionId: 'surviving-session', playingText: 'First chapter text here.' });
	await session.flush();

	assert.equal(saved.at(-1)?.charOffset, 0);
});

test('advancing persists the new chapter at offset zero', async () => {
	const { session, saved } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	await session.advance();

	assert.equal(saved.at(-1)?.chapterIndex, 1);
	assert.equal(saved.at(-1)?.charOffset, 0);
});

/** PDF and DOCX arrive as one chapter that knows where its pages begin. */
function pagedHarness(text: string, pageStarts: number[]) {
	const started: { title: string; content: string; lang: string }[] = [];
	const saved: BookProgressRecord[] = [];
	const session = createBookSession({
		book: { title: 'Report', lang: 'en', chapterCount: 1, getChapterText: async () => text, pageStarts },
		file: { name: 'report.pdf', size: 42, lastModified: 7 },
		startChapter: async (payload) => {
			started.push(payload);
			return { success: true, sessionId: `session-${started.length}` };
		},
		saveProgress: async (record) => {
			saved.push(record);
		},
		now: () => 1_700_000_000_000,
	});
	return { session, started, saved };
}

const PAGED_TEXT = 'Page one text.\n\nPage two text.\n\nPage three text.';
const PAGED_STARTS = [0, 16, 32];

test('a paged book reports pages instead of chapters', async () => {
	const { session } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.deepEqual(session.state(), { kind: 'page', index: 0, count: 3 });
});

test('a book without page starts still reports chapters', async () => {
	const { session } = harness(['First chapter.', 'Second chapter.']);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.deepEqual(session.state(), { kind: 'chapter', index: 0, count: 2 });
});

test('advancing a paged book plays from the next page start', async () => {
	const { session, started } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });

	assert.equal(await session.advance(), true);
	assert.equal(started[1].content, 'Page two text.\n\nPage three text.');
	assert.deepEqual(session.state(), { kind: 'page', index: 1, count: 3 });
});

test('going back a page plays from the previous page start', async () => {
	const { session, started } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: PAGED_STARTS[2] });
	assert.deepEqual(session.state(), { kind: 'page', index: 2, count: 3 });

	assert.equal(await session.previous(), true);
	assert.equal(started[1].content, 'Page two text.\n\nPage three text.');
	assert.deepEqual(session.state(), { kind: 'page', index: 1, count: 3 });
});

test('advancing past the last page reports the document is finished', async () => {
	const { session } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: PAGED_STARTS[2] });
	assert.equal(await session.advance(), false);
});

test('going back from the first page leaves playback alone', async () => {
	const { session, started } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.equal(await session.previous(), false);
	assert.equal(started.length, 1);
});

test('the reported page follows the position being read', async () => {
	const { session } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });

	// A word being read partway through page two, reported against the slice that is playing.
	session.recordPosition(PAGED_STARTS[1] + 5);
	assert.deepEqual(session.state(), { kind: 'page', index: 1, count: 3 });
});

test('a paged book persists the total length so progress can be shown as a percentage', async () => {
	const { session, saved } = pagedHarness(PAGED_TEXT, PAGED_STARTS);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	session.recordPosition(PAGED_STARTS[1]);
	await session.flush();

	assert.equal(saved.at(-1)?.totalChars, PAGED_TEXT.length);
	assert.equal(saved.at(-1)?.charOffset, PAGED_STARTS[1]);
});

test('an empty page list falls back to chapter reporting', async () => {
	const { session } = pagedHarness(PAGED_TEXT, []);
	await session.start({ chapterIndex: 0, charOffset: 0 });
	assert.deepEqual(session.state(), { kind: 'chapter', index: 0, count: 1 });
});
