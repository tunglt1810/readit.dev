import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSourceText } from '../../src/offscreen/text_normalization.ts';

test('normalizes unicode NFC and line endings (CRLF and CR to LF)', () => {
	const result = normalizeSourceText('é\r\nline2\rline3');
	assert.deepEqual(result.paragraphs, ['é line2 line3']);
});

test('classifies blank-line runs as hard paragraph breaks', () => {
	const result = normalizeSourceText('Paragraph 1.\n\nParagraph 2.');
	assert.deepEqual(result.paragraphs, ['Paragraph 1.', 'Paragraph 2.']);
});

test('classifies blank-line runs with horizontal whitespace as hard paragraph breaks', () => {
	const result = normalizeSourceText('First\n \t\nSecond.');
	assert.deepEqual(result.paragraphs, ['First', 'Second.']);
	assert.equal(result.planningText, 'First\n\nSecond.');
});

test('classifies blank lines containing Unicode horizontal whitespace as hard paragraph breaks', () => {
	const result = normalizeSourceText('Heading\n \nBody.');
	assert.deepEqual(result.paragraphs, ['Heading', 'Body.']);
	assert.equal(result.planningText, 'Heading\n\nBody.');
});

test('classifies a single line break following a sentence terminal as a hard paragraph break', () => {
	const result = normalizeSourceText('First sentence.\nSecond sentence.');
	assert.deepEqual(result.paragraphs, ['First sentence.', 'Second sentence.']);
});

test('classifies a single non-terminal line break as a soft line break', () => {
	const result = normalizeSourceText('Wrapped line\ncontinuation.');
	assert.deepEqual(result.paragraphs, ['Wrapped line continuation.']);
});

test('collapses all Unicode whitespace inside paragraph and planning text', () => {
	const result = normalizeSourceText('  가  나  \nwrapped\ttext  ');
	assert.deepEqual(result.paragraphs, ['가 나 wrapped text']);
	assert.equal(result.planningText, '가 나 wrapped text');
});

test('returns empty output for all-whitespace input', () => {
	const result = normalizeSourceText('   \r\n\t  \n  ');
	assert.deepEqual(result.paragraphs, []);
	assert.equal(result.planningText, '');
});
