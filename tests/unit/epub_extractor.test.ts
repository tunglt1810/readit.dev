import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChapterList, normalizeChapterText, resolveHref } from '../../src/shared/epub_extractor.ts';

test('hrefs resolve relative to the OPF directory', () => {
	assert.equal(resolveHref('OEBPS/content.opf', 'chapter1.xhtml'), 'OEBPS/chapter1.xhtml');
	assert.equal(resolveHref('OEBPS/content.opf', 'text/chapter1.xhtml'), 'OEBPS/text/chapter1.xhtml');
	assert.equal(resolveHref('content.opf', 'chapter1.xhtml'), 'chapter1.xhtml');
});

test('parent segments in hrefs are resolved', () => {
	assert.equal(resolveHref('OEBPS/text/content.opf', '../images/../chapter1.xhtml'), 'OEBPS/chapter1.xhtml');
});

test('percent-encoded hrefs are decoded to their archive path', () => {
	assert.equal(resolveHref('OEBPS/content.opf', 'chapter%201.xhtml'), 'OEBPS/chapter 1.xhtml');
});

test('blocks are joined as paragraphs with whitespace collapsed', () => {
	assert.equal(normalizeChapterText(['  First   block  ', 'Second\tblock']), 'First block\n\nSecond block');
});

test('empty and whitespace-only blocks are dropped', () => {
	assert.equal(normalizeChapterText(['First', '   ', '', 'Second']), 'First\n\nSecond');
});

test('a chapter with no text normalizes to an empty string', () => {
	assert.equal(normalizeChapterText(['', '  ']), '');
});

const SPINE = ['cover.xhtml', 'title.xhtml', 'toc.xhtml', 'ch1.xhtml', 'ch1b.xhtml', 'ch2.xhtml'];

test('the table of contents decides which spine slots are chapters', () => {
	const chapters = buildChapterList(SPINE, [
		{ title: 'Chapter One', path: 'ch1.xhtml' },
		{ title: 'Chapter Two', path: 'ch2.xhtml' },
	]);

	// The cover, title page and contents page precede the first nav target and are not chapters.
	assert.deepEqual(
		chapters.map((chapter) => chapter.title),
		['Chapter One', 'Chapter Two'],
	);
});

test('a chapter spans every spine slot up to the next nav target', () => {
	const chapters = buildChapterList(SPINE, [
		{ title: 'Chapter One', path: 'ch1.xhtml' },
		{ title: 'Chapter Two', path: 'ch2.xhtml' },
	]);

	// ch1b.xhtml is a continuation the navigation never names; dropping it would lose text.
	assert.deepEqual(chapters[0].spineIndices, [3, 4]);
	assert.deepEqual(chapters[1].spineIndices, [5]);
});

test('nav targets are ordered by the spine, which is the definitive reading order', () => {
	const chapters = buildChapterList(SPINE, [
		{ title: 'Chapter Two', path: 'ch2.xhtml' },
		{ title: 'Chapter One', path: 'ch1.xhtml' },
	]);

	assert.deepEqual(
		chapters.map((chapter) => chapter.spineIndices[0]),
		[3, 5],
	);
});

test('sub-sections pointing into a file an earlier entry already covers are not new chapters', () => {
	const chapters = buildChapterList(SPINE, [
		{ title: 'Chapter One', path: 'ch1.xhtml' },
		{ title: 'A section of chapter one', path: 'ch1.xhtml' },
		{ title: 'Chapter Two', path: 'ch2.xhtml' },
	]);

	assert.equal(chapters.length, 2);
	assert.deepEqual(chapters[0].spineIndices, [3, 4]);
});

test('a book whose navigation points nowhere still reads, one chapter per spine slot', () => {
	for (const entries of [[], [{ title: 'Dangling', path: 'missing.xhtml' }]]) {
		const chapters = buildChapterList(SPINE, entries);
		assert.equal(chapters.length, SPINE.length);
		assert.deepEqual(chapters[0].spineIndices, [0]);
	}
});
