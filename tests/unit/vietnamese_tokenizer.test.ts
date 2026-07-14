import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreSource, tokenizeVietnameseText } from '../../src/offscreen/vietnamese/tokenizer.ts';

test('protects structured Vietnamese tokens before punctuation separation', () => {
	const document = tokenizeVietnameseText('Ngày 11/07/2026, đạt 12,5% tại https://example.vn/a-b. Email a@b.vn; bản v1.2.3.');
	const paragraph = document.paragraphs[0];
	assert.deepEqual(
		paragraph.tokens.filter((token) => token.kind === 'structured').map((token) => token.text),
		['11/07/2026', '12,5%', 'https://example.vn/a-b', 'a@b.vn', 'v1.2.3'],
	);
	assert.equal(restoreSource(paragraph.tokens, paragraph.trailing), paragraph.source);
});

test('preserves paragraph boundaries and distinguishes spaced dash from a range', () => {
	const document = tokenizeVietnameseText('Khoảng 10-12 km - thử nghiệm.\n\nĐoạn hai.');
	assert.equal(document.paragraphs.length, 2);
	assert.equal(document.paragraphs[0].tokens.find((token) => token.text === '10-12')?.kind, 'structured');
	assert.equal(document.paragraphs[0].tokens.find((token) => token.text === '-')?.kind, 'punctuation');
	assert.equal(document.normalizedSource, document.paragraphs.map((paragraph) => paragraph.source).join('\n\n'));
});

test('normalizes to NFC without removing Vietnamese diacritics', () => {
	const document = tokenizeVietnameseText('Tha\u0300nh pho\u0302\u0301 Ho\u0302\u0300 Chi\u0301 Minh');
	assert.equal(document.normalizedSource, 'Thành phố Hồ Chí Minh');
});

test('restores normalized whitespace and keeps exact token offsets', () => {
	const document = tokenizeVietnameseText('  Một\t  hai.  \n \n Ba  ');
	assert.equal(document.normalizedSource, ' Một hai. \n\n Ba ');
	assert.equal(document.paragraphs.length, 2);
	for (const paragraph of document.paragraphs) {
		assert.equal(restoreSource(paragraph.tokens, paragraph.trailing), paragraph.source);
		for (const token of paragraph.tokens) {
			assert.equal(document.normalizedSource.slice(token.start, token.end), token.original);
		}
	}
});

test('returns no lexical paragraphs for empty or whitespace-only input', () => {
	assert.deepEqual(tokenizeVietnameseText('').paragraphs, []);
	assert.deepEqual(tokenizeVietnameseText(' \t\n\n ').paragraphs, []);
});

test('does not consume grouped money as an unprefixed version', () => {
	const tokens = tokenizeVietnameseText('Học phí 700.000đ.').paragraphs[0].tokens;
	assert.equal(tokens.find((token) => token.text.startsWith('700'))?.text, '700.000đ');
});

test('does not consume a currency prefix from the following Vietnamese word', () => {
	const tokens = tokenizeVietnameseText('Ghi 178.000 điểm.').paragraphs[0].tokens;
	assert.deepEqual(
		tokens.map(({ text }) => text),
		['Ghi', '178.000', 'điểm', '.'],
	);
});

test('protects IPv4 and does not duplicate a final token leading gap as trailing text', () => {
	const paragraph = tokenizeVietnameseText('IPv4 192.168.1.1').paragraphs[0];
	assert.equal(paragraph.tokens.find((token) => token.text === '192.168.1.1')?.kind, 'structured');
	assert.equal(restoreSource(paragraph.tokens, paragraph.trailing), paragraph.source);
});

test('uses longest-match measurement units', () => {
	const structured = tokenizeVietnameseText('Tốc độ 42 km/h trên diện tích 10 m².')
		.paragraphs[0].tokens.filter((token) => token.kind === 'structured')
		.map((token) => token.text);
	assert.deepEqual(structured, ['42 km/h', '10 m²']);
});

test('protects full month, quarter, and malformed date-like tokens without prefix splitting', () => {
	const tokens = tokenizeVietnameseText('Tháng 07/2026, quý II/2026, mã 11/99/2026.').paragraphs[0].tokens;
	assert.deepEqual(
		tokens.filter((token) => token.kind === 'structured').map((token) => token.text),
		['07/2026', 'II/2026', '11/99/2026'],
	);
});
