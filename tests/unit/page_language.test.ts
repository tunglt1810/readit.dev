import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePageLanguage } from '../../src/content/page_language.ts';

const VIETNAMESE_SAMPLE = (
	'Trí tuệ nhân tạo đang thay đổi cách con người tiếp cận tri thức mỗi ngày, và nhiều công cụ ' +
	'mới ra đời khiến việc theo kịp trở nên khó khăn hơn trước rất nhiều. '
).repeat(3);
const ENGLISH_SAMPLE = 'Romantic rejection activates the same brain regions implicated in physical pain. '.repeat(3);

test('reads the language from the sample when the page declares the wrong one', () => {
	const result = resolvePageLanguage({
		url: 'https://vnexpress.net/bai-viet',
		declared: 'en',
		sample: VIETNAMESE_SAMPLE,
	});
	assert.deepEqual(result, { lang: 'vi', langSource: 'detected' });
});

test('refuses to read a Google Docs page, whose declaration is the account locale', () => {
	const result = resolvePageLanguage({
		url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
		declared: 'en',
		sample: ENGLISH_SAMPLE,
	});
	assert.deepEqual(result, { lang: 'en', langSource: 'unknown' });
});

test('refuses to read a Word Online page', () => {
	const result = resolvePageLanguage({
		url: 'https://contoso-my.sharepoint.com/personal/me/_layouts/15/Doc.aspx?sourcedoc=%7B3f2504e0-4f89-11d3-9a0c-0305e82c3301%7D&file=a.docx',
		declared: 'en',
		sample: ENGLISH_SAMPLE,
	});
	assert.equal(result.langSource, 'unknown');
});

test('refuses to read a page with too little text to judge', () => {
	const result = resolvePageLanguage({ url: 'https://example.com', declared: 'fr', sample: 'Bonjour' });
	assert.deepEqual(result, { lang: 'fr', langSource: 'unknown' });
});

test('keeps the declared language when the sample agrees with it', () => {
	const result = resolvePageLanguage({ url: 'https://example.com', declared: 'en', sample: ENGLISH_SAMPLE });
	assert.deepEqual(result, { lang: 'en', langSource: 'detected' });
});
