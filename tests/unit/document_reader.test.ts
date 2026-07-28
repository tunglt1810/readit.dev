import assert from 'node:assert/strict';
import test from 'node:test';
import { isDocumentReaderSnapshot, mapDocumentReaderWords } from '../../src/shared/document_reader.ts';

test('maps repeated words monotonically', () => {
	assert.deepEqual(
		mapDocumentReaderWords('cat saw cat', [
			{ text: 'cat', globalIndex: 0 },
			{ text: 'cat', globalIndex: 1 },
		]),
		[
			{ start: 0, end: 3 },
			{ start: 8, end: 11 },
		],
	);
});

test('preserves source offsets while matching NFC words against NFD text', () => {
	assert.deepEqual(
		mapDocumentReaderWords('Cafe\u0301 costs 1.000 USD.', [
			{ text: 'café', globalIndex: 0 },
			{ text: '1.000 USD', globalIndex: 1 },
		]),
		[
			{ start: 0, end: 5 },
			{ start: 12, end: 21 },
		],
	);
});

test('does not consume the cursor when one word is unmatched', () => {
	assert.deepEqual(
		mapDocumentReaderWords('First second', [
			{ text: 'First', globalIndex: 0 },
			{ text: 'missing', globalIndex: 1 },
			{ text: 'second', globalIndex: 2 },
		]),
		[{ start: 0, end: 5 }, null, { start: 6, end: 12 }],
	);
});

test('does not match a short word inside a longer word', () => {
	assert.deepEqual(mapDocumentReaderWords('candy can', [{ text: 'can', globalIndex: 0 }]), [{ start: 6, end: 9 }]);
});

test('validates a strict memory-only snapshot', () => {
	const snapshot = {
		sessionId: 'document-session',
		title: 'Document',
		content: 'First second',
		words: [
			{ text: 'First', globalIndex: 0 },
			{ text: 'second', globalIndex: 1 },
		],
		currentWordIndex: 1,
	};

	assert.equal(isDocumentReaderSnapshot(snapshot), true);
	assert.equal(isDocumentReaderSnapshot({ ...snapshot, words: [{ text: 'First', globalIndex: 1 }] }), false);
	assert.equal(isDocumentReaderSnapshot({ ...snapshot, currentWordIndex: 1.5 }), false);
	assert.equal(isDocumentReaderSnapshot({ ...snapshot, persistedText: snapshot.content }), false);
});
