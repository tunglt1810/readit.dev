import assert from 'node:assert/strict';
import test from 'node:test';
import { isDocumentReaderSnapshot } from '../../src/shared/document_reader.ts';

const base = {
	sessionId: 's1',
	title: 'Title',
	content: 'Xin chào thế giới',
	words: [{ text: 'Xin', globalIndex: 0 }],
	currentWordIndex: 0,
};

test('accepts an untranslated snapshot', () => {
	assert.equal(isDocumentReaderSnapshot(base), true);
});

test('accepts a translated snapshot carrying the original text', () => {
	assert.equal(
		isDocumentReaderSnapshot({
			...base,
			originalContent: 'Hello world',
			translation: { sourceLanguage: 'en', targetLanguage: 'vi' },
		}),
		true,
	);
});

test('rejects a translation descriptor without the original text', () => {
	assert.equal(isDocumentReaderSnapshot({ ...base, translation: { sourceLanguage: 'en', targetLanguage: 'vi' } }), false);
});

test('rejects original text without a translation descriptor', () => {
	assert.equal(isDocumentReaderSnapshot({ ...base, originalContent: 'Hello world' }), false);
});

test('rejects an unsupported target language', () => {
	assert.equal(
		isDocumentReaderSnapshot({
			...base,
			originalContent: 'Hello world',
			translation: { sourceLanguage: 'en', targetLanguage: 'ja' },
		}),
		false,
	);
});

test('still rejects unknown fields', () => {
	assert.equal(isDocumentReaderSnapshot({ ...base, surpriseField: true }), false);
});
