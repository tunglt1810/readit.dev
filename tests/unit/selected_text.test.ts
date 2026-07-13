import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectedTextArticle, normalizePageLanguage } from '../../src/background/selected_text.ts';

test('normalizes regional page languages and falls back when missing', () => {
	assert.equal(normalizePageLanguage('vi-VN'), 'vi');
	assert.equal(normalizePageLanguage(' EN_us '), 'en');
	assert.equal(normalizePageLanguage(''), 'na');
	assert.equal(normalizePageLanguage(undefined), 'na');
});

test('creates an Article from trimmed selected text and tab metadata', () => {
	assert.deepEqual(
		createSelectedTextArticle({
			selectionText: '  Nội dung đã chọn  ',
			title: 'Bài viết',
			url: 'https://example.com/article',
			pageLanguage: 'vi-VN',
		}),
		{
			title: 'Bài viết',
			content: 'Nội dung đã chọn',
			url: 'https://example.com/article',
			lang: 'vi',
		},
	);
});

test('uses the URL as title fallback and rejects whitespace-only text', () => {
	assert.deepEqual(
		createSelectedTextArticle({
			selectionText: 'Readable selection',
			title: '',
			url: 'https://example.com/article',
			pageLanguage: null,
		}),
		{
			title: 'https://example.com/article',
			content: 'Readable selection',
			url: 'https://example.com/article',
			lang: 'na',
		},
	);
	assert.equal(
		createSelectedTextArticle({
			selectionText: ' \n\t ',
			title: 'Keep playing',
			url: 'https://example.com',
			pageLanguage: 'en',
		}),
		null,
	);
});
