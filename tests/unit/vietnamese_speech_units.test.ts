import assert from 'node:assert/strict';
import test from 'node:test';
import {
	planSpeechUnits,
	VI_MAX_UNIT_LENGTH,
	VI_PREFERRED_MAX_LENGTH,
	VI_PREFERRED_MIN_LENGTH,
} from '../../src/offscreen/vietnamese/speech_units.ts';

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

test('keeps short clauses together and applies paragraph pause precedence', () => {
	const first = 'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.';
	const second = 'Đoạn cuối cùng đủ dài!';

	assert.deepEqual(planSpeechUnits(`${first}\n\n${second}`), [
		{ text: first, pauseAfterMs: 260 },
		{ text: second, pauseAfterMs: 165 },
	]);
});

test('selects a weighted Vietnamese boundary in the preferred range', () => {
	const source = `${'từ '.repeat(30).trim()}. ${'ngữ '.repeat(20).trim()}, ${'dài '.repeat(90).trim()}`;
	const units = planSpeechUnits(source);

	assert.equal(units[0].text.endsWith(','), true);
	assert.ok(units[0].text.length >= VI_PREFERRED_MIN_LENGTH);
	assert.ok(units[0].text.length <= VI_PREFERRED_MAX_LENGTH);
});

test('does not split punctuation inside protected structured forms', () => {
	const protectedText = 'Các mã 10-12, 11-07-2026, https://a-b.vn và AB-123 vẫn nằm cùng câu.';
	const source = `${protectedText} ${'nội dung '.repeat(45).trim()}`;
	const reconstructed = planSpeechUnits(source)
		.map(({ text }) => text)
		.join(' ');

	assert.equal(normalizeWhitespace(reconstructed), normalizeWhitespace(source));
	assert.equal(reconstructed.includes('https://a-b.vn'), true);
});

test('does not split a standalone decimal at its punctuation', () => {
	const source = 'từ '.repeat(45) + '3.14 ' + 'nội dung '.repeat(35);
	const units = planSpeechUnits(source);
	const splitsDecimal = units.some(({ text }, index) => text.endsWith('3.') && units[index + 1]?.text.startsWith('14'));

	assert.equal(splitsDecimal, false);
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('keeps every unit within the hard limit and preserves all normalized text', () => {
	const source = Array.from({ length: 140 }, (_, index) => `từ${index}`).join(' ');
	const units = planSpeechUnits(source);

	assert.ok(units.length > 1);
	assert.ok(units.every(({ text }) => text.length <= VI_MAX_UNIT_LENGTH));
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('returns no empty units', () => {
	assert.deepEqual(planSpeechUnits(' \n\n '), []);
});

test('keeps consecutive short sentences in one synthesis unit', () => {
	assert.deepEqual(planSpeechUnits('Câu đầu… Câu sau.'), [{ text: 'Câu đầu… Câu sau.', pauseAfterMs: 165 }]);
});
