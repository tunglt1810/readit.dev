import assert from 'node:assert/strict';
import test from 'node:test';
import { isPredominantlyLatinText, LATIN_MAX_UNIT_LENGTH, planLatinSpeechUnits } from '../../src/offscreen/latin/speech_units.ts';
import { SegmentationCapacityError } from '../../src/offscreen/segmentation.ts';
import { normalizeSourceText } from '../../src/offscreen/text_normalization.ts';

function plan(source: string) {
	return planLatinSpeechUnits(normalizeSourceText(source).paragraphs);
}

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

test('keeps a fitting semicolon-delimited sentence intact and applies paragraph pause precedence', () => {
	const first = 'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.';
	const second = 'Đoạn cuối cùng đủ dài!';

	assert.deepEqual(plan(`${first}\n\n${second}`), [
		{ text: first, pauseAfterMs: 260 },
		{ text: second, pauseAfterMs: 165 },
	]);
});

test('plans one Source Unit per sentence with its own terminal pause', () => {
	assert.deepEqual(plan('A sentence. A question? An exclamation! An ellipsis…'), [
		{ text: 'A sentence.', pauseAfterMs: 180 },
		{ text: 'A question?', pauseAfterMs: 165 },
		{ text: 'An exclamation!', pauseAfterMs: 165 },
		{ text: 'An ellipsis…', pauseAfterMs: 165 },
	]);
	assert.deepEqual(plan('A sentence.'), [{ text: 'A sentence.', pauseAfterMs: 180 }]);
});

test('does not split punctuation inside protected structured forms', () => {
	const protectedText = 'admin@example.com 192.168.1.10 v2.3.4 11-07-2026 10:30 3.5kg https://a-b.example/x;y ÅBC-123';
	const source = `${'prefix '.repeat(22)}${protectedText} ${'additional content '.repeat(45).trim()}`;
	const reconstructed = plan(source)
		.map(({ text }) => text)
		.join(' ');

	assert.equal(normalizeWhitespace(reconstructed), normalizeWhitespace(source));
	assert.equal(reconstructed.includes('admin@example.com'), true);
	assert.equal(reconstructed.includes('192.168.1.10'), true);
	assert.equal(reconstructed.includes('v2.3.4'), true);
	assert.equal(reconstructed.includes('https://a-b.example/x;y'), true);
	assert.equal(reconstructed.includes('ÅBC-123'), true);
});

// Every form is placed inside a single sentence that cannot fit, so planning has to take the R6
// ordered fallback and actually choose a boundary near it rather than keeping the sentence whole.
const PROTECTED_FORMS = [
	'https://example.test/v1.2.3?q=a;b',
	'reader@example.test',
	'192.0.2.1',
	'v10.4.27',
	'ABC-123',
	'11/07/2026',
	'10:30',
	'3,5',
	'12-15',
	'1.500.000₫',
	'99,9%',
	'120km/h',
	'IRGC',
	'AFP',
	'CNN',
	'TP.HCM',
	'VnExpress',
	'PGS.TS',
	'Dr.',
];

for (const form of PROTECTED_FORMS) {
	test(`keeps ${form} whole while splitting the oversized sentence around it`, () => {
		const filler = 'padding word '.repeat(14).trim();
		const source = `${filler} ${form} ${filler} ${filler}.`;
		const units = plan(source);

		assert.ok(units.length > 1, 'the sentence must be oversized enough to exercise the fallback');
		assert.ok(units.every(({ text }) => text.length <= LATIN_MAX_UNIT_LENGTH));
		assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
		assert.equal(
			units.filter(({ text }) => text.includes(form)).length,
			1,
			`${form} must survive inside exactly one unit: ${JSON.stringify(units.map(({ text }) => text))}`,
		);
	});
}

test('permits a boundary immediately outside a protected form', () => {
	const filler = 'padding word '.repeat(12).trim();
	// The comma directly after the protected date is outside it, so the fallback may still use it.
	const source = `${filler} 11/07/2026, ${filler} ${filler}.`;
	const units = plan(source);

	assert.ok(units.some(({ text }) => text.endsWith('11/07/2026,')));
});

test('never splits between the halves of a surrogate pair', () => {
	const source = `${'𐐷'.repeat(80)} ${'𐐷'.repeat(80)} ${'𐐷'.repeat(80)}.`;
	const units = plan(source);

	assert.ok(units.length > 1);
	assert.ok(units.every(({ text }) => text.length <= LATIN_MAX_UNIT_LENGTH));
	for (const { text } of units) {
		assert.equal(text.replace(/𐐷/gu, '').replace(/[\s.]/gu, ''), '', `lone surrogate in ${JSON.stringify(text)}`);
	}
});

test('keeps every planned unit within capacity and preserves normalized text', () => {
	const source = Array.from({ length: 140 }, (_, index) => `word${index}`).join(' ');
	const units = plan(source);

	assert.ok(units.length > 1);
	assert.ok(units.every(({ text }) => text.length <= LATIN_MAX_UNIT_LENGTH));
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
});

test('treats a single line break as a soft wrap and a blank line as a paragraph break', () => {
	assert.deepEqual(plan('First line\nSecond line.'), [{ text: 'First line Second line.', pauseAfterMs: 180 }]);
	assert.deepEqual(plan('First paragraph.\n \t\nSecond paragraph.'), [
		{ text: 'First paragraph.', pauseAfterMs: 260 },
		{ text: 'Second paragraph.', pauseAfterMs: 180 },
	]);
});

test('does not emit a period-ending title as a standalone sentence', () => {
	const source = `Mr. ${'word '.repeat(70)}tail.`;
	const units = plan(source);

	assert.notEqual(units[0]?.text, 'Mr.');
	assert.equal(normalizeWhitespace(units.map(({ text }) => text).join(' ')), normalizeWhitespace(source));
	assert.ok(units.every(({ text }) => text.length <= LATIN_MAX_UNIT_LENGTH));
});

test('rejects an oversized unbreakable token without splitting it', () => {
	assert.throws(
		() => plan('a'.repeat(LATIN_MAX_UNIT_LENGTH + 1)),
		(error: unknown) => error instanceof SegmentationCapacityError,
	);
});

test('keeps a closing quote with the sentence it terminates', () => {
	assert.deepEqual(plan('Ông nói "Xin chào." Rồi ông đi.'), [
		{ text: 'Ông nói "Xin chào."', pauseAfterMs: 180 },
		{ text: 'Rồi ông đi.', pauseAfterMs: 180 },
	]);
	assert.deepEqual(plan('(Một ghi chú.) Câu tiếp theo.'), [
		{ text: '(Một ghi chú.)', pauseAfterMs: 180 },
		{ text: 'Câu tiếp theo.', pauseAfterMs: 180 },
	]);
});
