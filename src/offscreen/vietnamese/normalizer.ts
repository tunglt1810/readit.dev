import { expandAbbreviation } from './abbreviations.ts';
import { reconstructDetectedSpans } from './crf.ts';
import { expandTypedSpan, isCurrencyShapedToken, isUppercaseRomanNumeral, recognizeDeterministicType } from './expanders.ts';
import { restoreSource, tokenizeVietnameseText } from './tokenizer.ts';
import type {
	CheckpointLabel,
	DetectedSpan,
	NormalizationDependencies,
	NormalizationResult,
	SourceToken,
	TokenizedParagraph,
	VietnameseNormalizerAssets,
	WordMapEntry,
} from './types.ts';

function originalSpan(tokens: readonly SourceToken[], span: DetectedSpan): string {
	return tokens
		.slice(span.startToken, span.endToken)
		.map((token, index) => `${index === 0 ? '' : token.leading}${token.original}`)
		.join('');
}

const ROMAN_CONTEXT_WORDS = new Set(['mục', 'chương', 'phần', 'quý', 'điều', 'khoản']);

function hasExplicitRomanContext(tokens: readonly SourceToken[], index: number): boolean {
	const previousToken = tokens[index - 1];
	const previous = previousToken?.kind === 'word' ? previousToken.text.toLocaleLowerCase('vi') : undefined;
	const precedingToken = tokens[index - 2];
	const preceding = precedingToken?.kind === 'word' ? precedingToken.text.toLocaleLowerCase('vi') : undefined;
	const previousPhrase = preceding && previous ? `${preceding} ${previous}` : undefined;
	const isOutlineStart = index === 0 || (previousToken?.kind === 'punctuation' && /^[.!?…]$/u.test(previousToken.text));
	const isOutlineMarker = /^[.)]$/u.test(tokens[index + 1]?.text ?? '') && isOutlineStart;
	return Boolean((previous && ROMAN_CONTEXT_WORDS.has(previous)) || previousPhrase === 'thế kỷ' || isOutlineMarker);
}

function deterministicOverlay(tokens: readonly SourceToken[], labels: CheckpointLabel[], vietnameseSyllables: ReadonlySet<string>): void {
	for (let index = 0; index < tokens.length; index++) {
		const source = tokens[index].text;
		const isIpAddress = /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(source);
		const isIpPrefix = /^IPv[46]$/iu.test(source) && /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(tokens[index + 1]?.text ?? '');
		const isOpaqueIdentifier = /^[A-ZĐĂÂÊÔƠƯ]{2,}-\d+(?:-[A-ZĐĂÂÊÔƠƯ]{2,})+$/u.test(source);
		if (isIpAddress || isIpPrefix || isOpaqueIdentifier) {
			labels[index] = 'O';
			continue;
		}
		const explicitRomanContext = isUppercaseRomanNumeral(source) && hasExplicitRomanContext(tokens, index);
		const isVietnameseRomanWord = /^[IVXLCDM]+$/iu.test(source) && vietnameseSyllables.has(source.toLocaleLowerCase('vi'));
		if (isVietnameseRomanWord && !explicitRomanContext && labels[index] === 'B-ROMA') {
			labels[index] = 'O';
		}
		const type = recognizeDeterministicType(source);
		if (type === 'MONEY') {
			labels[index] = 'B-MONEY';
			continue;
		}
		if (isCurrencyShapedToken(source)) {
			labels[index] = 'O';
			continue;
		}
		if (type && (labels[index] === 'O' || type === 'NVER')) {
			labels[index] = `B-${type}`;
			continue;
		}
		if (explicitRomanContext && labels[index] === 'O') {
			labels[index] = 'B-ROMA';
			continue;
		}
		if (labels[index] !== 'O') {
			continue;
		}

		const previousWords = tokens
			.slice(Math.max(0, index - 3), index)
			.filter((token) => token.kind === 'word')
			.map((token) => token.text.toLocaleLowerCase('vi'));
		const previous = previousWords.at(-1);
		const previousPhrase = previousWords.slice(-2).join(' ');
		if (/^\d{1,2}\/\d{1,2}$/u.test(source)) {
			if (previous === 'ngày') {
				labels[index] = 'B-NDAY';
			} else if (previousPhrase === 'tỷ lệ' || previousPhrase === 'phân số') {
				labels[index] = 'B-NFRC';
			}
		} else if (/^\d+(?:[.,]\d+)?\s*[-–:]\s*\d+(?:[.,]\d+)?$/u.test(source)) {
			if (previous === 'ngày' && source.includes('-')) {
				labels[index] = 'B-NDAY';
			} else if (previousPhrase === 'tỷ số') {
				labels[index] = 'B-NSCR';
			} else if (previous === 'khoảng' || previous === 'từ') {
				labels[index] = 'B-NRNG';
			}
		}
	}
}

export function detectVietnameseLabels(
	tokens: readonly SourceToken[],
	assets: VietnameseNormalizerAssets,
): { labels: CheckpointLabel[]; usedCrf: boolean; fallbackReason?: string } {
	let labels = tokens.map(() => 'O' as CheckpointLabel);
	let usedCrf = false;
	let fallbackReason: string | undefined;
	if (assets.detector) {
		try {
			const detected = assets.detector.detect(tokens);
			if (detected.length !== tokens.length) {
				throw new Error('CRF label count mismatch');
			}
			labels = [...detected];
			usedCrf = true;
		} catch (error) {
			fallbackReason = error instanceof Error ? error.message : 'CRF detection failed';
		}
	}
	deterministicOverlay(tokens, labels, assets.vietnameseSyllables);
	return { labels, usedCrf, ...(fallbackReason ? { fallbackReason } : {}) };
}

async function expandParagraph(
	paragraph: TokenizedParagraph,
	labels: readonly CheckpointLabel[],
	dependencies: NormalizationDependencies,
): Promise<{ text: string; wordMap: WordMapEntry[]; usedAbbreviationScorer: boolean }> {
	const spans = reconstructDetectedSpans(labels);
	const spansByStart = new Map(spans.map((span) => [span.startToken, span]));
	const output: string[] = [];
	const wordMap: WordMapEntry[] = [];
	let cursor = 0;
	let usedAbbreviationScorer = false;
	for (let index = 0; index < paragraph.tokens.length; ) {
		const token = paragraph.tokens[index];
		const span = spansByStart.get(index);
		if (!span) {
			output.push(token.leading, token.original);
			cursor += token.leading.length;
			// Punctuation tokens stay in the spoken output (they affect TTS pacing/pauses), but must
			// never become a highlight target: a punctuation mark is virtually always adjacent to a
			// letter (e.g. "úp,"), so its own position can never satisfy a word-boundary-aware DOM
			// search — forcing the highlighter to skip ahead to some unrelated, distant occurrence of
			// the same mark and silently eat every real word in between.
			if (token.kind !== 'punctuation') {
				wordMap.push({
					originalText: token.original,
					originalStart: token.start,
					originalEnd: token.end,
					spokenStart: cursor,
					spokenEnd: cursor + token.original.length,
				});
			}
			cursor += token.original.length;
			index++;
			continue;
		}

		const source = originalSpan(paragraph.tokens, span);
		let expansion: string | null = null;
		try {
			if (span.type === 'LABB') {
				const candidates =
					dependencies.assets.abbreviations.get(source) ?? dependencies.assets.abbreviations.get(source.replaceAll('.', ''));
				usedAbbreviationScorer ||= Boolean(dependencies.assets.abbreviationScorer && candidates && candidates.length > 1);
				expansion = await expandAbbreviation({
					source,
					leftContext: paragraph.tokens
						.slice(Math.max(0, span.startToken - 5), span.startToken)
						.map(({ text }) => text)
						.join(' '),
					rightContext: paragraph.tokens
						.slice(span.endToken, span.endToken + 5)
						.map(({ text }) => text)
						.join(' '),
					dictionary: dependencies.assets.abbreviations,
					scorer: dependencies.assets.abbreviationScorer,
					confidenceThreshold: dependencies.assets.confidenceThreshold,
					confidenceMargin: dependencies.assets.confidenceMargin,
				});
			} else {
				expansion = expandTypedSpan(span.type, source, {
					previousText: paragraph.tokens[span.startToken - 1]?.text,
					nextText: paragraph.tokens[span.endToken]?.text,
				});
				if (span.type === 'NDAT' && paragraph.tokens[span.startToken - 1]?.text.toLocaleLowerCase('vi') === 'ngày') {
					expansion = expansion?.replace(/^ngày\s+/u, '') ?? null;
				}
			}
		} catch {
			expansion = null;
		}
		const piece = expansion?.trim() || source;
		output.push(token.leading, piece);
		cursor += token.leading.length;
		const spanStartToken = paragraph.tokens[span.startToken];
		const spanEndToken = paragraph.tokens[span.endToken - 1];
		if (piece === source) {
			let pieceOffset = 0;
			for (const [relativeIndex, sourceToken] of paragraph.tokens.slice(span.startToken, span.endToken).entries()) {
				if (relativeIndex > 0) {
					pieceOffset += sourceToken.leading.length;
				}
				if (sourceToken.kind !== 'punctuation') {
					wordMap.push({
						originalText: sourceToken.original,
						originalStart: sourceToken.start,
						originalEnd: sourceToken.end,
						spokenStart: cursor + pieceOffset,
						spokenEnd: cursor + pieceOffset + sourceToken.original.length,
					});
				}
				pieceOffset += sourceToken.original.length;
			}
		} else {
			wordMap.push({
				originalText: source,
				originalStart: spanStartToken.start,
				originalEnd: spanEndToken.end,
				spokenStart: cursor,
				spokenEnd: cursor + piece.length,
			});
		}
		cursor += piece.length;
		index = span.endToken;
	}
	output.push(paragraph.trailing);
	return { text: output.join(''), wordMap, usedAbbreviationScorer };
}

export async function normalizeVietnameseText(text: string, dependencies: NormalizationDependencies): Promise<NormalizationResult> {
	const startedAt = dependencies.now();
	const document = tokenizeVietnameseText(text);
	let tokenCount = 0;
	let crfMs = 0;
	let expansionMs = 0;
	let usedCrf = false;
	let usedAbbreviationScorer = false;
	let fallbackReason: string | undefined;
	const paragraphs: string[] = [];
	const wordMap: WordMapEntry[] = [];
	let spokenOffset = 0;

	for (const paragraph of document.paragraphs) {
		tokenCount += paragraph.tokens.length;
		const crfStartedAt = dependencies.now();
		const detected = detectVietnameseLabels(paragraph.tokens, dependencies.assets);
		crfMs += dependencies.now() - crfStartedAt;
		usedCrf ||= detected.usedCrf;
		fallbackReason ??= detected.fallbackReason;
		const expansionStartedAt = dependencies.now();
		const expanded = await expandParagraph(paragraph, detected.labels, dependencies);
		expansionMs += dependencies.now() - expansionStartedAt;
		usedAbbreviationScorer ||= expanded.usedAbbreviationScorer;
		for (const entry of expanded.wordMap) {
			wordMap.push({
				originalText: entry.originalText,
				originalStart: entry.originalStart,
				originalEnd: entry.originalEnd,
				spokenStart: spokenOffset + entry.spokenStart,
				spokenEnd: spokenOffset + entry.spokenEnd,
			});
		}
		spokenOffset += expanded.text.length + 2;
		paragraphs.push(expanded.text);
	}

	let normalized = paragraphs.join('\n\n');
	if (normalized.length === 0 && text.length > 0) {
		normalized = text;
		wordMap.length = 0;
	}
	const diagnostics = {
		tokenCount,
		crfMs,
		expansionMs,
		totalMs: dependencies.now() - startedAt,
		usedCrf,
		usedAbbreviationScorer,
		...(fallbackReason ? { fallbackReason } : {}),
	};
	if (document.paragraphs.length === 0 && document.normalizedSource.length > 0) {
		normalized = restoreSource([], document.normalizedSource);
	}
	return { text: normalized, wordMap, diagnostics };
}
