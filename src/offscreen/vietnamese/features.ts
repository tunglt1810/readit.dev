import type { SourceToken } from './types.ts';

export type CrfFeatureValue = string | boolean | number;
export type CrfFeatureMap = Record<string, CrfFeatureValue>;

export interface FeatureDictionaries {
	vietnameseSyllables: ReadonlySet<string>;
	abbreviations: ReadonlySet<string>;
	moneyUnits: ReadonlySet<string>;
	measurementUnits: ReadonlySet<string>;
}

function dictionaryFraction(token: string, dictionary: ReadonlySet<string>): number {
	if (dictionary.has(token) || dictionary.has(token.replace(/[-.]|\p{N}+/gu, ''))) {
		return 1;
	}
	const parts = token.split(/[-.]|(\d+)/u).filter(Boolean);
	return parts.length === 0 ? 0 : parts.filter((part) => dictionary.has(part)).length / parts.length;
}

function wordShape(token: string, short: boolean): string {
	const shapes: string[] = [];
	for (const character of token) {
		const shape = /\p{Lu}/u.test(character) ? 'X' : /\p{L}/u.test(character) ? 'x' : /\p{N}/u.test(character) ? 'd' : character;
		if (!short || shapes.at(-1) !== shape) {
			shapes.push(shape);
		}
	}
	return shapes.join('');
}

function matchesAny(token: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(token));
}

function isTimePattern(token: string): boolean {
	return matchesAny(token, [
		/^([01]?[0-9]|2[0-3])[:hg][0-5]?[0-9][:mp][0-5]?[0-9]$/u,
		/^([01]?[0-9]|2[0-3])[:hg][0-5]?[0-9]$/u,
		/^([01]?[0-9]|2[0-3])[hg]$/u,
		/^([01]?[0-9]|2[0-3])\s*[-/]\s*([01]?[0-9]|2[0-3])[hg]$/u,
		/^([01]?[0-9]|2[0-3])[hg]([0-5]?[0-9])?\s*-\s*([01]?[0-9]|2[0-3])[hg]([0-5]?[0-9])?$/u,
		/^([01]?[0-9]|2[0-3]):[0-5]?[0-9]\s*-\s*([01]?[0-9]|2[0-3]):[0-5]?[0-9]$/u,
	]);
}

function isDayPattern(rawToken: string): boolean {
	const token = rawToken.replaceAll('.', '/');
	return matchesAny(token, [
		/^(0?[1-9]|[12][0-9]|3[01])[/-](0?[1-9]|1[0-2])$/u,
		/^(0?[1-9]|[12][0-9]|3[01])\s*-\s*(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])$/u,
		/^(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\s*-\s*(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])$/u,
	]);
}

function isDatePattern(rawToken: string): boolean {
	const token = rawToken.replaceAll('.', '/');
	return matchesAny(token, [
		/^(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\/[1-9]\d{2,3}$/u,
		/^(0?[1-9]|[12][0-9]|3[01])-(0?[1-9]|1[0-2])-[1-9]\d{2,3}$/u,
		/^(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\s*-\s*(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\/[1-9]\d{2,3}$/u,
		/^(0?[1-9]|[12][0-9]|3[01])\s*-\s*(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\/[1-9]\d{2,3}$/u,
		/^(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\/[1-9]\d{2,3}\s*-\s*(0?[1-9]|[12][0-9]|3[01])\/(0?[1-9]|1[0-2])\/[1-9]\d{2,3}$/u,
	]);
}

function isMonthPattern(rawToken: string): boolean {
	const token = rawToken.replaceAll('.', '/');
	return matchesAny(token, [
		/^(0?[1-9]|1[0-2])\/[1-9]\d{2,3}$/u,
		/^(0?[1-9]|1[0-2])-[1-9]\d{2,3}$/u,
		/^(0?[1-9]|1[0-2])\s*-\s*(0?[1-9]|1[0-2])\/[1-9]\d{2,3}$/u,
		/^(0?[1-9]|1[0-2])\/[1-9]\d{2,3}\s*-\s*(0?[1-9]|1[0-2])\/[1-9]\d{2,3}$/u,
	]);
}

export function extractCrfFeatures(tokens: readonly SourceToken[], index: number, dictionaries: FeatureDictionaries): CrfFeatureMap {
	if (!Number.isInteger(index) || index < 0 || index >= tokens.length) {
		throw new RangeError('CRF token index is out of range');
	}
	const token = tokens[index].text;
	if (token.length === 0) {
		throw new Error('CRF tokens must not be empty');
	}
	const characters = Array.from(token);
	const prefix = (length: number) => characters.slice(0, length).join('');
	const suffix = (length: number) => characters.slice(-length).join('');

	return {
		wi: token,
		is_first_capital: /^\p{Lu}/u.test(token),
		is_first_word: index === 0,
		is_last_word: index === tokens.length - 1,
		is_complete_capital: token.toUpperCase() === token,
		is_alphanumeric: /^(?=[^0-9]*[0-9])(?=[^a-zA-Z]*[a-zA-Z])/u.test(token),
		is_numeric: /^\p{N}+$/u.test(token),
		prev_word: index === 0 ? '' : tokens[index - 1].text,
		next_word: index === tokens.length - 1 ? '' : tokens[index + 1].text,
		prev_word_2: index < 2 ? '' : tokens[index - 2].text,
		next_word_2: index > tokens.length - 3 ? '' : tokens[index + 2].text,
		prefix_1: prefix(1),
		prefix_2: prefix(2),
		prefix_3: prefix(3),
		prefix_4: prefix(4),
		suffix_1: suffix(1),
		suffix_2: suffix(2),
		suffix_3: suffix(3),
		suffix_4: suffix(4),
		ws: wordShape(token, false),
		short_ws: wordShape(token, true),
		in_vn_dict: dictionaryFraction(token.toLowerCase(), dictionaries.vietnameseSyllables),
		in_abbr_dict: dictionaryFraction(token, dictionaries.abbreviations),
		in_money_dict: dictionaryFraction(token, dictionaries.moneyUnits),
		in_measurement_dict: dictionaryFraction(token, dictionaries.measurementUnits),
		word_has_hyphen: token.includes('-') || token.includes('–'),
		word_has_tilde: token.includes('~'),
		word_has_at: token.includes('@'),
		word_has_comma: token.includes(','),
		word_has_colon: token.includes(':'),
		word_has_dot: token.includes('.'),
		word_has_ws_xxslashxxxx: /^\d{1,2}\/\d{4}$/u.test(token),
		word_has_romanslashxxxx: /^[IVXLCDM]+[/.-]\d{4}$/u.test(token),
		word_has_num_dash_colon_num: /^\d[\d.,]*([-–:]\d[\d.,]*)+$/u.test(token),
		word_contain_only_roman: /^[IVXLCDM]+$/u.test(token),
		word_has_time_shape: isTimePattern(token),
		word_has_day_shape: isDayPattern(token),
		word_has_date_shape: isDatePattern(token),
		word_has_month_shape: isMonthPattern(token),
	};
}

export function encodeCrfsuiteAttributes(features: CrfFeatureMap): readonly [string, number][] {
	const attributes: [string, number][] = [];
	for (const [name, value] of Object.entries(features)) {
		if (typeof value === 'string') {
			attributes.push([`${name}:${value}`, 1]);
		} else if (typeof value === 'boolean') {
			if (value) {
				attributes.push([name, 1]);
			}
		} else {
			if (!Number.isFinite(value)) {
				throw new Error(`CRF feature ${name} must be finite`);
			}
			attributes.push([name, value]);
		}
	}
	return attributes;
}
