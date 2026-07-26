import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWordHighlightWords, isWordHighlightInitMessage, isWordHighlightUpdateMessage } from '../../src/shared/word_highlight.ts';

test('flattens every word map entry into stable global indexes, including duplicates', () => {
	assert.deepEqual(
		buildWordHighlightWords([{ wordMap: [{ text: 'rất' }, { text: 'rất' }] }, { wordMap: [] }, { wordMap: [{ text: 'nhiều' }] }]),
		[
			{ text: 'rất', globalIndex: 0 },
			{ text: 'rất', globalIndex: 1 },
			{ text: 'nhiều', globalIndex: 2 },
		],
	);
});

test('accepts only a contiguous init word list with non-empty words', () => {
	assert.equal(
		isWordHighlightInitMessage({
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: 'session-1',
			contentScope: 'article',
			words: [{ text: 'First', globalIndex: 0 }],
		}),
		true,
	);
	assert.equal(
		isWordHighlightInitMessage({
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: 'session-1',
			contentScope: 'manual',
			words: [{ text: 'First', globalIndex: 0 }],
		}),
		false,
	);
	assert.equal(
		isWordHighlightInitMessage({
			action: 'WORD_HIGHLIGHT_INIT',
			sessionId: 'session-1',
			contentScope: 'article',
			words: [{ text: 'First', globalIndex: 1 }],
		}),
		false,
	);
});

test('accepts only non-negative integer update indexes', () => {
	assert.equal(isWordHighlightUpdateMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 's', wordIndex: 0 }), true);
	assert.equal(isWordHighlightUpdateMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 's', wordIndex: -1 }), false);
	assert.equal(isWordHighlightUpdateMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 's', wordIndex: 0.5 }), false);
});
