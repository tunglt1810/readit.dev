import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCrfsuiteAttributes, extractCrfFeatures } from '../../src/offscreen/vietnamese/features.ts';
import { tokenizeVietnameseText } from '../../src/offscreen/vietnamese/tokenizer.ts';

const dictionaries = {
	vietnameseSyllables: new Set(['trường', 'tuyển', 'sinh']),
	abbreviations: new Set(['ĐH']),
	moneyUnits: new Set(['₫']),
	measurementUnits: new Set(['km']),
};

test('matches every reference feature around an abbreviation', () => {
	const tokens = tokenizeVietnameseText('Trường ĐH tuyển sinh').paragraphs[0].tokens;
	assert.deepEqual(extractCrfFeatures(tokens, 1, dictionaries), {
		wi: 'ĐH',
		is_first_capital: true,
		is_first_word: false,
		is_last_word: false,
		is_complete_capital: true,
		is_alphanumeric: false,
		is_numeric: false,
		prev_word: 'Trường',
		next_word: 'tuyển',
		prev_word_2: '',
		next_word_2: 'sinh',
		prefix_1: 'Đ',
		prefix_2: 'ĐH',
		prefix_3: 'ĐH',
		prefix_4: 'ĐH',
		suffix_1: 'H',
		suffix_2: 'ĐH',
		suffix_3: 'ĐH',
		suffix_4: 'ĐH',
		ws: 'XX',
		short_ws: 'X',
		in_vn_dict: 0,
		in_abbr_dict: 1,
		in_money_dict: 0,
		in_measurement_dict: 0,
		word_has_hyphen: false,
		word_has_tilde: false,
		word_has_at: false,
		word_has_comma: false,
		word_has_colon: false,
		word_has_dot: false,
		word_has_ws_xxslashxxxx: false,
		word_has_romanslashxxxx: false,
		word_has_num_dash_colon_num: false,
		word_contain_only_roman: false,
		word_has_time_shape: false,
		word_has_day_shape: false,
		word_has_date_shape: false,
		word_has_month_shape: false,
	});
});

test('matches date shape, morphology, and boundary flags', () => {
	const tokens = tokenizeVietnameseText('11/07/2026').paragraphs[0].tokens;
	const features = extractCrfFeatures(tokens, 0, dictionaries);
	assert.equal(features.wi, '11/07/2026');
	assert.equal(features.ws, 'dd/dd/dddd');
	assert.equal(features.short_ws, 'd/d/d');
	assert.equal(features.is_first_word, true);
	assert.equal(features.is_last_word, true);
	assert.equal(features.is_complete_capital, true);
	assert.equal(features.word_has_ws_xxslashxxxx, false);
	assert.equal(features.word_has_date_shape, true);
	assert.equal(features.word_has_day_shape, false);
	assert.equal(features.word_has_month_shape, false);
});

test('encodes CRFsuite attributes with reference string, boolean, and numeric semantics', () => {
	assert.deepEqual(encodeCrfsuiteAttributes({ text: '', enabled: true, disabled: false, fraction: 0.5 }), [
		['text:', 1],
		['enabled', 1],
		['fraction', 0.5],
	]);
	assert.throws(() => encodeCrfsuiteAttributes({ invalid: Number.NaN }), /finite/);
});
