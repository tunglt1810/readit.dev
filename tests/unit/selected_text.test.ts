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

test('collapses horizontal whitespace (including NBSP) but keeps paragraph line breaks', () => {
	assert.deepEqual(
		createSelectedTextArticle({
			selectionText: 'Một câu \t có khoảng   trắng lạ',
			title: 'Bài viết',
			url: 'https://example.com/article',
			pageLanguage: 'vi',
		}),
		{
			title: 'Bài viết',
			content: 'Một câu có khoảng trắng lạ',
			url: 'https://example.com/article',
			lang: 'vi',
		},
	);
	assert.equal(
		createSelectedTextArticle({
			selectionText: 'Đoạn một kết thúc.\r\n\r\n  Đoạn hai bắt đầu.  ',
			title: 'Bài viết',
			url: 'https://example.com/article',
			pageLanguage: 'vi',
		})?.content,
		'Đoạn một kết thúc.\n\nĐoạn hai bắt đầu.',
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

test('reads the language from the selected text when the page declares none', () => {
	// The context-menu path resolves the page language with chrome.scripting.executeScript, which
	// fails silently wherever the extension cannot inject; without detection that lands on 'na' and
	// the offscreen pipeline skips Vietnamese normalization entirely.
	assert.equal(
		createSelectedTextArticle({
			selectionText: 'Ngoại trưởng đã đồng ý với thỏa thuận do Mỹ và Qatar làm trung gian.',
			title: 'Bài viết',
			url: 'https://example.com/article',
			pageLanguage: undefined,
		})?.lang,
		'vi',
	);
	assert.equal(
		createSelectedTextArticle({
			selectionText: 'The foreign minister agreed to the deal brokered by the United States.',
			title: 'Article',
			url: 'https://example.com/article',
			pageLanguage: 'en-US',
		})?.lang,
		'en',
	);
});
