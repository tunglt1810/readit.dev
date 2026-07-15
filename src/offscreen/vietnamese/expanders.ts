import { expandDecimal, expandDigits, expandInteger } from './number_words.ts';
import type { NswType } from './types.ts';

export interface ExpansionContext {
	previousText?: string;
	nextText?: string;
}

const MEASUREMENT_UNITS: Readonly<Record<string, string>> = {
	'%': 'phần trăm',
	mm: 'mi li mét',
	cm: 'xen ti mét',
	dm: 'đề xi mét',
	m: 'mét',
	'm²': 'mét vuông',
	m2: 'mét vuông',
	m3: 'mét khối',
	ml: 'mi li lít',
	l: 'lít',
	km: 'ki lô mét',
	km2: 'ki lô mét vuông',
	'km/h': 'ki lô mét trên giờ',
	'm/s': 'mét trên giây',
	kg: 'ki lô gam',
	mg: 'mi li gam',
	g: 'gam',
	ha: 'héc ta',
	MHz: 'mê ga héc',
	Mbps: 'mê ga bít trên giây',
	'°C': 'độ xê',
	'°F': 'độ ép',
};

const MONEY_UNITS: Readonly<Record<string, string>> = {
	$: 'đô la',
	'€': 'ơ rô',
	'¥': 'yên',
	'₫': 'đồng',
	đ: 'đồng',
	VND: 'đồng',
	USD: 'đô la',
	EUR: 'ơ rô',
	'£': 'bảng anh',
	'₩': 'won',
};

export const MONEY_UNIT_KEYS: ReadonlySet<string> = new Set(Object.keys(MONEY_UNITS));
export const MEASUREMENT_UNIT_KEYS: ReadonlySet<string> = new Set(Object.keys(MEASUREMENT_UNITS));

const LETTERS: Readonly<Record<string, string>> = {
	a: 'a',
	b: 'bê',
	c: 'xê',
	d: 'đê',
	e: 'e',
	f: 'ép',
	g: 'gờ',
	h: 'hát',
	i: 'i',
	j: 'di',
	k: 'ca',
	l: 'lờ',
	m: 'mờ',
	n: 'nờ',
	o: 'o',
	p: 'pê',
	q: 'quy',
	r: 'rờ',
	s: 'ét',
	t: 'tê',
	u: 'u',
	v: 'vê',
	w: 'vê kép',
	x: 'ích',
	y: 'y',
	z: 'dét',
};

const SPECIAL_CHARACTERS: Readonly<Record<string, string>> = {
	'@': 'a còng',
	'.': 'chấm',
	'/': 'gạch chéo',
	':': 'hai chấm',
	'-': 'gạch ngang',
	_: 'gạch dưới',
	'=': 'bằng',
	'?': 'chấm hỏi',
	'&': 'và',
};

function readSequence(source: string): string | null {
	const words: string[] = [];
	for (const character of source.trim()) {
		if (/\s/u.test(character)) {
			continue;
		}
		if (/\d/u.test(character)) {
			words.push(expandDigits(character) ?? character);
		} else {
			words.push(LETTERS[character.toLowerCase()] ?? SPECIAL_CHARACTERS[character] ?? character);
		}
	}
	return words.length > 0 ? words.join(' ') : null;
}

function parseRoman(source: string): number | null {
	const roman = source.trim().toUpperCase();
	if (!/^(?=[IVXLCDM]+$)M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/u.test(roman)) {
		return null;
	}
	const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
	let total = 0;
	for (let index = 0; index < roman.length; index++) {
		total += values[roman[index]] < (values[roman[index + 1]] ?? 0) ? -values[roman[index]] : values[roman[index]];
	}
	return total;
}

export function isUppercaseRomanNumeral(rawSource: string): boolean {
	const source = rawSource.trim();
	return source.length > 0 && source === source.toUpperCase() && parseRoman(source) !== null;
}

function daysInMonth(month: number, year: number): number {
	if (month === 2) {
		return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0) ? 29 : 28;
	}
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDay(day: number, month: number, year = 2024): boolean {
	return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(month, year);
}

function expandDate(source: string, withYear: boolean): string | null {
	const pattern = withYear ? /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/u : /^(\d{1,2})[/-](\d{1,2})$/u;
	const match = pattern.exec(source.trim());
	if (!match) {
		return null;
	}
	const day = Number(match[1]);
	const month = Number(match[2]);
	const year = withYear ? Number(match[3]) : 2024;
	if (!validDay(day, month, year)) {
		return null;
	}
	const dayWords = expandInteger(match[1]);
	const monthWords = expandInteger(match[2]);
	if (!dayWords || !monthWords) {
		return null;
	}
	if (!withYear) {
		return `${dayWords} tháng ${monthWords}`;
	}
	const yearWords = expandInteger(match[3]);
	return yearWords ? `ngày ${dayWords} tháng ${monthWords} năm ${yearWords}` : null;
}

function expandMeasurement(source: string): string | null {
	const unitOnly = MEASUREMENT_UNITS[source.trim()];
	if (unitOnly) {
		return unitOnly;
	}
	const match = /^(-?\d+(?:\.\d{3})*(?:,\d+)?)\s*([^\d\s.,]+)$/u.exec(source.trim());
	if (!match) {
		return null;
	}
	const value = expandDecimal(match[1]);
	const unit = MEASUREMENT_UNITS[match[2]];
	return value && unit ? `${value} ${unit}` : null;
}

export function isCurrencyShapedToken(rawSource: string): boolean {
	const source = rawSource.trim();
	return /^(?:[$€¥£₩]\s*-?\d[\d.,]*(?:\s*(?:nghìn|triệu|tỷ))?|-?\d[\d.,]*\s*(?:₫|đ|VND|USD|EUR))$/iu.test(source);
}

function expandMoney(source: string): string | null {
	const input = source.trim();
	const match = /^(?:([$€¥£₩])\s*(-?\d+(?:\.\d{3})*(?:,\d+)?)|(-?\d+(?:\.\d{3})*(?:,\d+)?)\s*(₫|đ|VND|USD|EUR))$/iu.exec(input);
	if (!match) {
		return null;
	}
	const amount = match[2] ?? match[3];
	const unit = match[1] ?? match[4];
	const value = expandDecimal(amount);
	return value && MONEY_UNITS[unit] ? `${value} ${MONEY_UNITS[unit]}` : null;
}

function expandTime(source: string): string | null {
	const input = source.trim();
	const hourOnly = /^(\d{1,2})h$/u.exec(input);
	if (hourOnly) {
		const hour = Number(hourOnly[1]);
		return hour <= 23 ? `${expandInteger(hourOnly[1])} giờ` : null;
	}

	const match = /^(\d{1,2})[:hg](\d{1,2})(?:[:mp](\d{1,2}))?$/u.exec(input);
	if (!match) {
		return null;
	}
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = match[3] === undefined ? undefined : Number(match[3]);
	if (hour > 23 || minute > 59 || (second !== undefined && second > 59)) {
		return null;
	}
	const base = `${expandInteger(match[1])} giờ ${expandInteger(match[2])} phút`;
	return second === undefined ? base : `${base} ${expandInteger(match[3])} giây`;
}

function expandUrlOrEmail(source: string): string | null {
	const input = source.trim();
	if (!/^https?:\/\/[^\s]+$/iu.test(input) && !/^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}$/iu.test(input)) {
		return null;
	}
	return readSequence(input);
}

function expandForeignWord(source: string): string | null {
	const parts = source
		.trim()
		.split(/[-_\s]+/u)
		.filter(Boolean);
	if (parts.length === 0) {
		return null;
	}
	return parts
		.map((part) =>
			/^\d+$/u.test(part) ? expandInteger(part) : part.replace(/\d+/gu, (digits) => ` ${expandInteger(digits) ?? digits} `).trim(),
		)
		.join(' ');
}

export function expandTypedSpan(type: Exclude<NswType, 'LABB'>, rawSource: string, _context: ExpansionContext = {}): string | null {
	const source = rawSource.trim();
	if (source.length === 0) {
		return null;
	}
	switch (type) {
		case 'LSEQ':
			return readSequence(source);
		case 'LWRD':
			return expandForeignWord(source);
		case 'MEA':
			return expandMeasurement(source);
		case 'MONEY':
			return expandMoney(source);
		case 'NDAT':
			return expandDate(source, true);
		case 'NDAY':
			return expandDate(source, false);
		case 'NDIG':
			return expandDigits(source);
		case 'NFRC': {
			const match = /^(\d+(?:\.\d{3})*)[/:](\d+(?:\.\d{3})*)$/u.exec(source);
			return match ? `${expandInteger(match[1])} trên ${expandInteger(match[2])}` : null;
		}
		case 'NMON': {
			const match = /^(\d{1,2})[/-](\d{4})$/u.exec(source);
			if (!match || Number(match[1]) < 1 || Number(match[1]) > 12) {
				return null;
			}
			return `tháng ${expandInteger(match[1])} năm ${expandInteger(match[2])}`;
		}
		case 'NNUM':
			if (/^0\d{8,10}$/u.test(source)) {
				return null;
			}
			return expandDecimal(source);
		case 'NPER': {
			const match = /^(-?\d+(?:\.\d{3})*(?:,\d+)?)\s*%$/u.exec(source);
			const value = match ? expandDecimal(match[1]) : null;
			return value ? `${value} phần trăm` : null;
		}
		case 'NQUA': {
			const match = /^(I|II|III|IV)[/-](\d{4})$/iu.exec(source);
			const quarter = match ? parseRoman(match[1]) : null;
			return match && quarter ? `quý ${expandInteger(String(quarter))} năm ${expandInteger(match[2])}` : null;
		}
		case 'NRNG': {
			const match = /^(-?\d+(?:[.,]\d+)?)\s*[-–]\s*(-?\d+(?:[.,]\d+)?)$/u.exec(source);
			const from = match ? expandDecimal(match[1]) : null;
			const to = match ? expandDecimal(match[2]) : null;
			return from && to ? `${from} đến ${to}` : null;
		}
		case 'NSCR': {
			const match = /^(\d+(?:[.,]\d+)?)\s*[-–:]\s*(\d+(?:[.,]\d+)?)$/u.exec(source);
			const first = match ? expandDecimal(match[1]) : null;
			const second = match ? expandDecimal(match[2]) : null;
			return first && second ? `${first} ${second}` : null;
		}
		case 'NTIM':
			return expandTime(source);
		case 'NVER': {
			const match = /^v(\d+(?:\.\d+)+)$/iu.exec(source);
			if (!match) {
				return null;
			}
			const parts = match[1].split('.').map(expandInteger);
			return parts.every(Boolean) ? `vê ${parts.join(' chấm ')}` : null;
		}
		case 'ROMA': {
			const value = parseRoman(source);
			return value === null ? null : expandInteger(String(value));
		}
		case 'URLE':
			return expandUrlOrEmail(source);
		default:
			return null;
	}
}

export function recognizeDeterministicType(rawSource: string): NswType | null {
	const source = rawSource.trim();
	if (expandUrlOrEmail(source)) {
		return 'URLE';
	}
	if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/u.test(source)) {
		return expandDate(source, true) ? 'NDAT' : null;
	}
	if (expandTypedSpan('NMON', source)) {
		return 'NMON';
	}
	if ((/^\d{1,2}h$/u.test(source) || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(source)) && expandTime(source)) {
		return 'NTIM';
	}
	if (expandMoney(source)) {
		return 'MONEY';
	}
	if (expandTypedSpan('NPER', source)) {
		return 'NPER';
	}
	if (expandMeasurement(source)) {
		return 'MEA';
	}
	if (expandTypedSpan('NQUA', source)) {
		return 'NQUA';
	}
	if (expandTypedSpan('NVER', source)) {
		return 'NVER';
	}
	if (/^0\d{8,10}$/u.test(source) || !/^-?\d[\d.,]{0,20}$/u.test(source)) {
		return null;
	}
	return expandDecimal(source) ? 'NNUM' : null;
}
