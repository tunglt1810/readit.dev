const DIGIT_WORDS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'] as const;
const GROUP_UNITS = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ', 'tỷ tỷ'] as const;

function normalizeInteger(value: string): { negative: boolean; digits: string } | null {
	let input = value.trim();
	let negative = false;
	if (input.startsWith('-')) {
		negative = true;
		input = input.slice(1);
	}
	if (input.length === 0 || input.startsWith('+')) {
		return null;
	}
	if (input.includes('.')) {
		if (!/^\d{1,3}(?:\.\d{3})+$/u.test(input)) {
			return null;
		}
		input = input.replaceAll('.', '');
	} else if (!/^\d+$/u.test(input)) {
		return null;
	}
	input = input.replace(/^0+(?=\d)/u, '');
	if (input.length > GROUP_UNITS.length * 3) {
		return null;
	}
	return { negative, digits: input };
}

function readThreeDigits(group: string, forceHundreds: boolean): string {
	const padded = group.padStart(3, '0');
	const hundreds = Number(padded[0]);
	const tens = Number(padded[1]);
	const ones = Number(padded[2]);
	const words: string[] = [];
	if (hundreds > 0 || forceHundreds) {
		words.push(DIGIT_WORDS[hundreds], 'trăm');
	}
	if (tens > 1) {
		words.push(DIGIT_WORDS[tens], 'mươi');
		if (ones === 1) {
			words.push('mốt');
		} else if (ones === 4) {
			words.push('tư');
		} else if (ones === 5) {
			words.push('lăm');
		} else if (ones > 0) {
			words.push(DIGIT_WORDS[ones]);
		}
	} else if (tens === 1) {
		words.push('mười');
		if (ones === 5) {
			words.push('lăm');
		} else if (ones > 0) {
			words.push(DIGIT_WORDS[ones]);
		}
	} else if (ones > 0) {
		if (hundreds > 0 || forceHundreds) {
			words.push('linh');
		}
		words.push(ones === 4 && (hundreds > 0 || forceHundreds) ? 'tư' : DIGIT_WORDS[ones]);
	}
	return words.join(' ');
}

export function expandDigits(value: string): string | null {
	const input = value.replaceAll(' ', '');
	if (!/^\d+$/u.test(input)) {
		return null;
	}
	return Array.from(input, (digit) => DIGIT_WORDS[Number(digit)]).join(' ');
}

export function expandInteger(value: string): string | null {
	const parsed = normalizeInteger(value);
	if (!parsed) {
		return null;
	}
	if (/^0+$/u.test(parsed.digits)) {
		return `${parsed.negative ? 'âm ' : ''}không`;
	}
	const groups: string[] = [];
	for (let end = parsed.digits.length; end > 0; end -= 3) {
		groups.unshift(parsed.digits.slice(Math.max(0, end - 3), end));
	}
	const words: string[] = [];
	let sawHigherGroup = false;
	for (let index = 0; index < groups.length; index++) {
		const numeric = Number(groups[index]);
		const unitIndex = groups.length - index - 1;
		if (numeric === 0) {
			continue;
		}
		words.push(readThreeDigits(groups[index], sawHigherGroup && groups[index].length === 3 && numeric < 100));
		if (GROUP_UNITS[unitIndex]) {
			words.push(GROUP_UNITS[unitIndex]);
		}
		sawHigherGroup = true;
	}
	return `${parsed.negative ? 'âm ' : ''}${words.join(' ')}`;
}

export function expandDecimal(value: string): string | null {
	const input = value.trim();
	if (!input.includes(',')) {
		return expandInteger(input);
	}
	if ((input.match(/,/gu) ?? []).length !== 1) {
		return null;
	}
	const [integer, decimal] = input.split(',');
	if (!/^\d+$/u.test(decimal)) {
		return null;
	}
	const integerWords = expandInteger(integer);
	const decimalWords = expandDigits(decimal);
	return integerWords && decimalWords ? `${integerWords} phẩy ${decimalWords}` : null;
}
