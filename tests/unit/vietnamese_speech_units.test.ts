import assert from 'node:assert/strict';
import test from 'node:test';
import { planSpeechUnits, VI_MAX_UNIT_LENGTH } from '../../src/offscreen/vietnamese/speech_units.ts';

test('applies clause, sentence, and paragraph pause precedence', () => {
	assert.deepEqual(
		planSpeechUnits(
			'Mệnh đề thứ nhất đủ dài, mệnh đề thứ hai cũng đủ dài; mệnh đề thứ ba vẫn đủ dài — mệnh đề thứ tư kết thúc.\n\nĐoạn cuối cùng đủ dài!',
		),
		[
			{ text: 'Mệnh đề thứ nhất đủ dài,', pauseAfterMs: 60 },
			{ text: 'mệnh đề thứ hai cũng đủ dài;', pauseAfterMs: 90 },
			{ text: 'mệnh đề thứ ba vẫn đủ dài —', pauseAfterMs: 105 },
			{ text: 'mệnh đề thứ tư kết thúc.', pauseAfterMs: 260 },
			{ text: 'Đoạn cuối cùng đủ dài!', pauseAfterMs: 165 },
		],
	);
});

test('keeps short clauses joined', () => {
	assert.deepEqual(planSpeechUnits('Một, hai; rồi ba.'), [{ text: 'Một, hai; rồi ba.', pauseAfterMs: 165 }]);
});

test('does not split dashes inside protected structured forms', () => {
	const source = 'Các mã 10-12, 11-07-2026, https://a-b.vn và AB-123 vẫn nằm cùng câu.';
	assert.equal(
		planSpeechUnits(source)
			.map(({ text }) => text)
			.join(' '),
		source,
	);
});

test('uses paragraph pause once and keeps every unit within the hard limit', () => {
	assert.deepEqual(planSpeechUnits('Câu đầu.\n\nCâu sau.'), [
		{ text: 'Câu đầu.', pauseAfterMs: 260 },
		{ text: 'Câu sau.', pauseAfterMs: 165 },
	]);
	const source = Array.from({ length: 100 }, (_, index) => `từ${index}`).join(' ');
	const units = planSpeechUnits(source);
	assert.ok(units.length > 1);
	assert.ok(units.every(({ text }) => text.length <= VI_MAX_UNIT_LENGTH));
	assert.ok(units[0].text.length >= 180 && units[0].text.length <= 220);
});

test('returns no empty units', () => {
	assert.deepEqual(planSpeechUnits(' \n\n '), []);
});

test('treats a Unicode ellipsis as a strong sentence boundary', () => {
	assert.deepEqual(planSpeechUnits('Câu đầu… Câu sau.'), [
		{ text: 'Câu đầu…', pauseAfterMs: 165 },
		{ text: 'Câu sau.', pauseAfterMs: 165 },
	]);
});
