import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isPredominantlyLatinText,
	LATIN_MAX_UNIT_LENGTH,
	LATIN_PREFERRED_MAX_LENGTH,
	LATIN_PREFERRED_MIN_LENGTH,
	planLatinSpeechUnits,
} from '../../src/offscreen/latin/speech_units.ts';

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

test('classifies Unicode Latin letters and ignores non-letter noise', () => {
	for (const source of [
		'English text',
		'français déjà vu',
		'Falsches Üben von Xylophonmusik quält jeden größeren Zwerg',
		'español corazón',
		'Zażółć gęślą jaźń',
		'123 😀 français !!!',
		'abc中',
	]) {
		assert.equal(isPredominantlyLatinText(source), true, source);
	}
});

test('rejects no-letter, exact-half, and non-Latin text', () => {
	for (const source of ['123 😀 !!!', 'ab中文', '中文内容', 'Русский текст', 'نص عربي']) {
		assert.equal(isPredominantlyLatinText(source), false, source);
	}
});

test('splits semicolon clauses and applies paragraph pause precedence', () => {
	const first = 'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.';
	const second = 'Đoạn cuối cùng đủ dài!';

	assert.deepEqual(planLatinSpeechUnits(`${first}\n\n${second}`), [
		{ text: 'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài;', pauseAfterMs: 140 },
		{ text: 'mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.', pauseAfterMs: 260 },
		{ text: second, pauseAfterMs: 165 },
	]);
});

test('splits the reported semicolon-delimited paragraph into speech units', () => {
	const source =
		'Dự thảo đồng thời bổ sung nhóm chức danh được sử dụng thường xuyên một ôtô trong thời gian công tác, không quy định mức giá, gồm: Chủ nhiệm Ủy ban Kiểm tra Trung ương; trưởng các ban Đảng ở Trung ương; Chánh Văn phòng Trung ương Đảng; Giám đốc Học viện Chính trị quốc gia Hồ Chí Minh.';

	assert.deepEqual(planLatinSpeechUnits(source), [
		{
			text: 'Dự thảo đồng thời bổ sung nhóm chức danh được sử dụng thường xuyên một ôtô trong thời gian công tác, không quy định mức giá, gồm: Chủ nhiệm Ủy ban Kiểm tra Trung ương;',
			pauseAfterMs: 140,
		},
		{ text: 'trưởng các ban Đảng ở Trung ương;', pauseAfterMs: 140 },
		{ text: 'Chánh Văn phòng Trung ương Đảng;', pauseAfterMs: 140 },
		{ text: 'Giám đốc Học viện Chính trị quốc gia Hồ Chí Minh.', pauseAfterMs: 180 },
	]);
});

test('uses a slightly longer pause after a period without changing other sentence endings', () => {
	assert.deepEqual(planLatinSpeechUnits('A sentence. A question? An exclamation! An ellipsis…'), [
		{ text: 'A sentence. A question? An exclamation! An ellipsis…', pauseAfterMs: 165 },
	]);
	assert.deepEqual(planLatinSpeechUnits('A sentence.'), [{ text: 'A sentence.', pauseAfterMs: 180 }]);
});

test('selects a weighted boundary in the preferred range', () => {
	const source = `${'word '.repeat(18).trim()}. ${'phrase '.repeat(14).trim()}, ${'long '.repeat(90).trim()}`;
	const units = planLatinSpeechUnits(source);

	assert.equal(units[0].text.endsWith(','), true);
	assert.ok(units[0].text.length >= LATIN_PREFERRED_MIN_LENGTH);
	assert.ok(units[0].text.length <= LATIN_PREFERRED_MAX_LENGTH);
});

test('does not split punctuation inside protected structured forms', () => {
	const protectedText = 'admin@example.com 192.168.1.10 v2.3.4 11-07-2026 10:30 3.5kg https://a-b.example/x;y ÅBC-123';
	const source = `${'prefix '.repeat(22)}${protectedText} ${'additional content '.repeat(45).trim()}`;
	const reconstructed = planLatinSpeechUnits(source)
		.map(({ text }) => text)
		.join(' ');

	assert.equal(normalizeWhitespace(reconstructed), normalizeWhitespace(source));
	assert.equal(reconstructed.includes('admin@example.com'), true);
	assert.equal(reconstructed.includes('192.168.1.10'), true);
	assert.equal(reconstructed.includes('v2.3.4'), true);
	assert.equal(reconstructed.includes('https://a-b.example/x;y'), true);
	assert.equal(reconstructed.includes('ÅBC-123'), true);
});

test('does not split a standalone decimal at its punctuation', () => {
	const source = 'word '.repeat(45) + '3.14 ' + 'content '.repeat(35);
	const units = planLatinSpeechUnits(source);
	const splitsDecimal = units.some(({ text }, index) => text.endsWith('3.') && units[index + 1]?.text.startsWith('14'));

	assert.equal(splitsDecimal, false);
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('keeps every unit within the hard limit and preserves all normalized text', () => {
	const source = Array.from({ length: 140 }, (_, index) => `word${index}`).join(' ');
	const units = planLatinSpeechUnits(source);

	assert.ok(units.length > 1);
	assert.ok(units.every(({ text }) => text.length <= LATIN_MAX_UNIT_LENGTH));
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('returns no empty units', () => {
	assert.deepEqual(planLatinSpeechUnits(' \n\n '), []);
});

test('keeps consecutive short sentences in one synthesis unit', () => {
	assert.deepEqual(planLatinSpeechUnits('Câu đầu… Câu sau.'), [{ text: 'Câu đầu… Câu sau.', pauseAfterMs: 180 }]);
});

test('treats a single line break as a paragraph boundary instead of erasing it to a plain space', () => {
	// Google Docs' plain-text export puts headings and standalone citation lines on their own line
	// separated by a single \n (only genuine new-paragraph breaks get \n\n+). Collapsing that single
	// \n to a bare space fused unrelated lines together with zero pause between them.
	assert.deepEqual(planLatinSpeechUnits('First line\nSecond line.'), [
		{ text: 'First line', pauseAfterMs: 260 },
		{ text: 'Second line.', pauseAfterMs: 180 },
	]);
});

test('treats several consecutive single line breaks the same as paragraph breaks', () => {
	assert.deepEqual(planLatinSpeechUnits('First line\nSecond line\nThird line.'), [
		{ text: 'First line', pauseAfterMs: 260 },
		{ text: 'Second line', pauseAfterMs: 260 },
		{ text: 'Third line.', pauseAfterMs: 180 },
	]);
});

test('assigns non-zero fallback pause to an unpunctuated final paragraph', () => {
	assert.deepEqual(planLatinSpeechUnits('Đoạn đầu.\n\nHuyền Lê (Theo AFP, CNN)'), [
		{ text: 'Đoạn đầu.', pauseAfterMs: 260 },
		{ text: 'Huyền Lê (Theo AFP, CNN)', pauseAfterMs: 165 },
	]);
});

