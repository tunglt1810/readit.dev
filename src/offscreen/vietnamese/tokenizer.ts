import type { SourceToken, TokenizedDocument, TokenizedParagraph, TokenKind } from './types.ts';

const STRUCTURED_PATTERNS = [
	/^https?:\/\/[^\s<>"'“”‘’]+/iu,
	/^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu,
	/^(?:\d{1,3}\.){3}\d{1,3}/u,
	/^v\d+(?:\.\d+){1,}/iu,
	/^(?:I|II|III|IV)\/\d{4}(?![\p{L}\p{M}\p{N}/-])/iu,
	/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?![\p{L}\p{M}\p{N}/-])/u,
	/^(?:0?[1-9]|1[0-2])[/-]\d{4}(?![\p{L}\p{M}\p{N}/-])/u,
	/^\d{1,2}[/-]\d{1,2}(?![\p{L}\p{M}\p{N}/-])/u,
	/^\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?/u,
	/^(?:(?:₫|\$|€|£)\s?\d+(?:[.,]\d+)*(?:\s?(?:nghìn|triệu|tỷ))?|\d+(?:[.,]\d+)*\s?(?:₫|đ|VND|USD|EUR))(?![\p{L}\p{M}\p{N}])/iu,
	/^\d+(?:[.,]\d+)*(?:\s?[-–]\s?\d+(?:[.,]\d+)*)?\s?(?:km\/h|m²|m3|mm|cm|dm|km|kg|mg|ml|ha|°C|m|g|l)(?![\p{L}\p{N}])/iu,
	/^\d+(?:[.,]\d+)*\s?%/u,
	/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|^\d+[.,]\d+/u,
	/^\d+(?:\s?[-–:]\s?)\d+/u,
	/^(?=[\p{L}\p{N}_-]*\d)(?=[\p{L}\p{N}_-]*[\p{L}_])[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)+/iu,
] as const;

const WORD = /[\p{L}\p{M}\p{N}_]+(?:[-'][\p{L}\p{M}\p{N}_]+)*/uy;
const PUNCTUATION = /[….,!?;:()[\]{}"'“”‘’]|(?:[-–—](?=\s|$))/uy;
const TRAILING_URL_PUNCTUATION = /[….,!?;:()[\]{}"'“”‘’]+$/u;

function normalizeSource(input: string): string {
	const canonicalNewlines = input.normalize('NFC').replace(/\r\n?/g, '\n');
	return canonicalNewlines
		.split(/\n[\t ]*\n+/u)
		.map((part) => part.replace(/[\t ]*\n[\t ]*/gu, ' ').replace(/[\t ]+/gu, ' '))
		.join('\n\n');
}

function structuredMatch(source: string, index: number): string | undefined {
	const remaining = source.slice(index);
	for (const pattern of STRUCTURED_PATTERNS) {
		const match = pattern.exec(remaining);
		if (!match || match.index !== 0) {
			continue;
		}
		let value = match[0];
		if (pattern === STRUCTURED_PATTERNS[0]) {
			value = value.replace(TRAILING_URL_PUNCTUATION, '');
		}
		if (value.length > 0) {
			return value;
		}
	}
	return undefined;
}

function lexicalMatch(source: string, index: number): { text: string; kind: TokenKind } {
	const structured = structuredMatch(source, index);
	if (structured) {
		return { text: structured, kind: 'structured' };
	}

	WORD.lastIndex = index;
	const word = WORD.exec(source);
	if (word) {
		return { text: word[0], kind: 'word' };
	}

	PUNCTUATION.lastIndex = index;
	const punctuation = PUNCTUATION.exec(source);
	return { text: punctuation?.[0] ?? source[index], kind: 'punctuation' };
}

function tokenizeParagraph(source: string, start: number): TokenizedParagraph {
	const tokens: SourceToken[] = [];
	let index = 0;
	let leading = '';
	let trailing = '';
	while (index < source.length) {
		const whitespaceStart = index;
		while (index < source.length && source[index] === ' ') {
			index++;
		}
		leading = source.slice(whitespaceStart, index);
		if (index === source.length) {
			trailing = leading;
			break;
		}

		const tokenStart = index;
		const { text, kind } = lexicalMatch(source, index);
		index += text.length;
		tokens.push({
			text,
			original: source.slice(tokenStart, index),
			leading,
			start: start + tokenStart,
			end: start + index,
			kind,
		});
	}

	return {
		source,
		start,
		end: start + source.length,
		tokens,
		trailing,
	};
}

export function restoreSource(tokens: readonly SourceToken[], trailing = ''): string {
	return tokens.map(({ leading, original }) => leading + original).join('') + trailing;
}

export function tokenizeVietnameseText(input: string): TokenizedDocument {
	const normalizedSource = normalizeSource(input);
	const paragraphs: TokenizedParagraph[] = [];
	let start = 0;
	for (const source of normalizedSource.split('\n\n')) {
		if (source.trim().length > 0) {
			paragraphs.push(tokenizeParagraph(source, start));
		}
		start += source.length + 2;
	}
	return { normalizedSource, paragraphs };
}
