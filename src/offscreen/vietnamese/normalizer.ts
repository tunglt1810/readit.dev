import { expandAbbreviation } from './abbreviations.ts';
import { reconstructDetectedSpans } from './crf.ts';
import { expandTypedSpan, recognizeDeterministicType } from './expanders.ts';
import { restoreSource, tokenizeVietnameseText } from './tokenizer.ts';
import type {
	CheckpointLabel,
	DetectedSpan,
	NormalizationDependencies,
	NormalizationResult,
	SourceToken,
	TokenizedParagraph,
	VietnameseNormalizerAssets,
} from './types.ts';

function originalSpan(tokens: readonly SourceToken[], span: DetectedSpan): string {
	return tokens
		.slice(span.startToken, span.endToken)
		.map((token, index) => `${index === 0 ? '' : token.leading}${token.original}`)
		.join('');
}

function deterministicOverlay(tokens: readonly SourceToken[], labels: CheckpointLabel[]): void {
	for (let index = 0; index < tokens.length; index++) {
		const source = tokens[index].text;
		const isIpAddress = /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(source);
		const isIpPrefix = /^IPv[46]$/iu.test(source) && /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(tokens[index + 1]?.text ?? '');
		const isOpaqueIdentifier = /^[A-ZĐĂÂÊÔƠƯ]{2,}-\d+(?:-[A-ZĐĂÂÊÔƠƯ]{2,})+$/u.test(source);
		if (isIpAddress || isIpPrefix || isOpaqueIdentifier) {
			labels[index] = 'O';
			continue;
		}
		const type = recognizeDeterministicType(source);
		if (type && (labels[index] === 'O' || type === 'NVER')) {
			labels[index] = `B-${type}`;
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
	deterministicOverlay(tokens, labels);
	return { labels, usedCrf, ...(fallbackReason ? { fallbackReason } : {}) };
}

async function expandParagraph(
	paragraph: TokenizedParagraph,
	labels: readonly CheckpointLabel[],
	dependencies: NormalizationDependencies,
): Promise<{ text: string; usedAbbreviationScorer: boolean }> {
	const spans = reconstructDetectedSpans(labels);
	const spansByStart = new Map(spans.map((span) => [span.startToken, span]));
	const output: string[] = [];
	let usedAbbreviationScorer = false;
	for (let index = 0; index < paragraph.tokens.length; ) {
		const token = paragraph.tokens[index];
		const span = spansByStart.get(index);
		if (!span) {
			output.push(token.leading, token.original);
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
		output.push(token.leading, expansion?.trim() || source);
		index = span.endToken;
	}
	output.push(paragraph.trailing);
	return { text: output.join(''), usedAbbreviationScorer };
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
		paragraphs.push(expanded.text);
	}

	let normalized = paragraphs.join('\n\n');
	if (normalized.length === 0 && text.length > 0) {
		normalized = text;
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
	return { text: normalized, diagnostics };
}
