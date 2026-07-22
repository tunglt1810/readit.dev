import assert from 'node:assert/strict';
import test from 'node:test';
import { detectManualTextLanguage, prepareManualStart, prepareManualText } from '../../src/background/manual_text.ts';
import { normalizeManualText } from '../../src/shared/manual_text.ts';

test('normalizes line endings while preserving paragraph boundaries', () => {
	assert.deepEqual(prepareManualText({ text: '  First line\r\n\r\nSecond line  ', language: 'en' }), {
		content: 'First line\n\nSecond line',
		lang: 'en',
	});
});

test('shares the exact normalized text shape used by the locked Side Panel reader', () => {
	assert.equal(normalizeManualText('  Cafe\u0301\r\n\r\nSecond\t line  '), 'Café\n\nSecond line');
});

test('rejects malformed, unsupported, and whitespace-only payloads', () => {
	assert.equal(prepareManualText(null), null);
	assert.equal(prepareManualText({ text: 42, language: 'auto' }), null);
	assert.equal(prepareManualText({ text: '   \n ', language: 'auto' }), null);
	assert.equal(prepareManualText({ text: 'Hello', language: 'fr' }), null);
});

test('explicit language bypasses automatic detection', () => {
	assert.deepEqual(prepareManualText({ text: 'Hello', language: 'vi' }), { content: 'Hello', lang: 'vi' });
	assert.deepEqual(prepareManualText({ text: 'Xin chào', language: 'zh' }), { content: 'Xin chào', lang: 'zh' });
});

test('detects dominant Han text as Chinese', () => {
	assert.equal(detectManualTextLanguage('Hello 中文內容，這是一段測試。'), 'zh');
});

test('detects Vietnamese-exclusive letters or two common function words', () => {
	assert.equal(detectManualTextLanguage('Tôi muốn đọc văn bản này.'), 'vi');
	assert.equal(detectManualTextLanguage('toi va ban khong can may chu'), 'vi');
});

test('falls back to English when automatic detection is uncertain', () => {
	assert.equal(detectManualTextLanguage('Plain text without a strong language signal.'), 'en');
	assert.equal(detectManualTextLanguage('123 😀 !!!'), 'en');
});

test('keeps a valid Side Panel owner ID while preparing manual text', () => {
	assert.deepEqual(
		prepareManualStart({
			text: 'Read this locally.',
			language: 'en',
			panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd',
		}),
		{
			content: 'Read this locally.',
			lang: 'en',
			panelInstanceId: 'ad6f72b4-2b6a-42c4-9d11-c3d6f07333cd',
		},
	);
	assert.equal(prepareManualStart({ text: 'Read this locally.', language: 'en', panelInstanceId: 'stale' }), null);
});
