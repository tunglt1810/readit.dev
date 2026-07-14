import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { expandTypedSpan, recognizeDeterministicType } from '../../src/offscreen/vietnamese/expanders.ts';
import { expandDecimal, expandInteger } from '../../src/offscreen/vietnamese/number_words.ts';
import type { NswType } from '../../src/offscreen/vietnamese/types.ts';

test('expands the required Vietnamese pronunciation table', () => {
	const cases: Array<[Exclude<NswType, 'LABB'>, string, string]> = [
		['NDAY', '11/07', 'mười một tháng bảy'],
		['NDAT', '11/07/2026', 'ngày mười một tháng bảy năm hai nghìn không trăm hai mươi sáu'],
		['NNUM', '7,9', 'bảy phẩy chín'],
		['NNUM', '178.000', 'một trăm bảy mươi tám nghìn'],
		['MEA', '42 km', 'bốn mươi hai ki lô mét'],
		['NPER', '12,5%', 'mười hai phẩy năm phần trăm'],
		['NRNG', '10-12', 'mười đến mười hai'],
		['MONEY', '700.000đ', 'bảy trăm nghìn đồng'],
		['NVER', 'v1.2.3', 'vê một chấm hai chấm ba'],
	];
	for (const [type, input, expected] of cases) assert.equal(expandTypedSpan(type, input), expected, `${type}: ${input}`);
});

test('validates Gregorian dates without locale parsing', () => {
	assert.equal(expandTypedSpan('NDAT', '29/02/2024'), 'ngày hai mươi chín tháng hai năm hai nghìn không trăm hai mươi tư');
	assert.equal(expandTypedSpan('NDAT', '29/02/2023'), null);
	assert.equal(expandTypedSpan('NDAT', '31/04/2026'), null);
	assert.equal(expandTypedSpan('NDAT', '11/99/2026'), null);
});

test('rejects malformed numbers and reads long values without floating point', () => {
	assert.equal(expandInteger('1000000000000000000'), 'một tỷ tỷ');
	assert.equal(expandInteger('12.34'), null);
	assert.equal(expandDecimal('-7,05'), 'âm bảy phẩy không năm');
	assert.equal(expandDecimal('dev-team@example.vn'), null);
});

test('covers every non-abbreviation NSW type with reviewed goldens', () => {
	const fixture = JSON.parse(
		readFileSync(new URL('../fixtures/vietnamese-normalizer/expansion-goldens.json', import.meta.url), 'utf8'),
	) as Array<{ type: Exclude<NswType, 'LABB'>; input: string; expected: string }>;
	assert.equal(new Set(fixture.map(({ type }) => type)).size, 18);
	for (const { type, input, expected } of fixture) assert.equal(expandTypedSpan(type, input), expected, `${type}: ${input}`);
});

test('limits deterministic fallback to high-confidence shapes', () => {
	assert.equal(recognizeDeterministicType('11/07/2026'), 'NDAT');
	assert.equal(recognizeDeterministicType('11/07'), null);
	assert.equal(recognizeDeterministicType('12,5%'), 'NPER');
	assert.equal(recognizeDeterministicType('https://example.vn/11/07?id=v1.2.3'), 'URLE');
	assert.equal(recognizeDeterministicType('dev-team@example.vn'), 'URLE');
	assert.equal(recognizeDeterministicType('0901234567'), null);
	assert.equal(recognizeDeterministicType('AB-123-CD'), null);
	assert.equal(recognizeDeterministicType('IPv4 192.168.1.1'), null);
	assert.equal(recognizeDeterministicType('29/02/2023'), null);
	assert.equal(recognizeDeterministicType('2-1'), null);
});

test('allows phone-like digits only when explicitly typed by the CRF', () => {
	assert.equal(expandTypedSpan('NNUM', '0901234567'), null);
	assert.equal(expandTypedSpan('NDIG', '0901234567'), 'không chín không một hai ba bốn năm sáu bảy');
	assert.equal(expandTypedSpan('LSEQ', '0901234567'), 'không chín không một hai ba bốn năm sáu bảy');
});
