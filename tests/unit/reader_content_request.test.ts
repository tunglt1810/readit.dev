import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReaderContentRequest } from '../../src/background/reader_content_request.ts';

test('accepts a well-formed request and trusts the sender tab id', () => {
	const request = parseReaderContentRequest({ title: 'Chapter 1', content: 'Hello there.', lang: 'en' }, 42);
	assert.deepEqual(request, { tabId: 42, title: 'Chapter 1', content: 'Hello there.', lang: 'en' });
});

test('rejects a request with no sender tab', () => {
	assert.equal(parseReaderContentRequest({ title: 'Chapter 1', content: 'Hello.', lang: 'en' }, undefined), null);
});

test('rejects empty or whitespace-only content', () => {
	assert.equal(parseReaderContentRequest({ title: 'Chapter 1', content: '   ', lang: 'en' }, 42), null);
	assert.equal(parseReaderContentRequest({ title: 'Chapter 1', content: '', lang: 'en' }, 42), null);
});

test('rejects malformed payloads', () => {
	assert.equal(parseReaderContentRequest(null, 42), null);
	assert.equal(parseReaderContentRequest({ content: 'Hello.', lang: 'en' }, 42), null);
	assert.equal(parseReaderContentRequest({ title: 5, content: 'Hello.', lang: 'en' }, 42), null);
});

test('falls back to automatic language detection when lang is missing', () => {
	const request = parseReaderContentRequest({ title: 'Chapter 1', content: 'Hello.' }, 42);
	assert.equal(request?.lang, 'na');
});
