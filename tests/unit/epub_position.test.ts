import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChapterStart, toAbsoluteOffset } from '../../src/shared/epub_position.ts';

const chapter = 'First sentence. Second sentence. Third sentence.';

test('a zero offset returns the whole chapter', () => {
	assert.deepEqual(resolveChapterStart(chapter, 0), { text: chapter, baseOffset: 0 });
});

test('a mid-chapter offset slices from that character', () => {
	const offset = chapter.indexOf('Second');
	assert.deepEqual(resolveChapterStart(chapter, offset), { text: 'Second sentence. Third sentence.', baseOffset: offset });
});

test('an offset past the end of the chapter restarts the chapter', () => {
	assert.deepEqual(resolveChapterStart(chapter, chapter.length + 50), { text: chapter, baseOffset: 0 });
});

test('a negative or non-finite offset restarts the chapter', () => {
	assert.deepEqual(resolveChapterStart(chapter, -5), { text: chapter, baseOffset: 0 });
	assert.deepEqual(resolveChapterStart(chapter, Number.NaN), { text: chapter, baseOffset: 0 });
});

test('absolute offsets are rebased onto the slice base', () => {
	assert.equal(toAbsoluteOffset(17, 7), 24);
	assert.equal(toAbsoluteOffset(0, 7), 7);
});

test('resuming twice does not drift', () => {
	// Play from the start, stop at "Third".
	const firstStop = toAbsoluteOffset(0, chapter.indexOf('Third'));
	const firstResume = resolveChapterStart(chapter, firstStop);
	assert.equal(firstResume.text, 'Third sentence.');

	// Inside that slice, stop at "sentence." -> its absolute position must still be correct.
	const secondStop = toAbsoluteOffset(firstResume.baseOffset, firstResume.text.indexOf('sentence.'));
	assert.equal(secondStop, chapter.indexOf('Third') + 'Third '.length);
	assert.equal(resolveChapterStart(chapter, secondStop).text, 'sentence.');
});
