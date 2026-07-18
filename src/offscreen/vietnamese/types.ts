export const NSW_TYPES = [
	'LABB',
	'LSEQ',
	'LWRD',
	'MEA',
	'MONEY',
	'NDAT',
	'NDAY',
	'NDIG',
	'NFRC',
	'NMON',
	'NNUM',
	'NPER',
	'NQUA',
	'NRNG',
	'NSCR',
	'NTIM',
	'NVER',
	'ROMA',
	'URLE',
] as const;

export type NswType = (typeof NSW_TYPES)[number];
export type BioLabel = `B-${NswType}` | `I-${NswType}` | 'O';
export type CheckpointLabel = BioLabel | 'B-USS';
export type TokenKind = 'word' | 'structured' | 'punctuation';

export interface SourceToken {
	text: string;
	original: string;
	leading: string;
	start: number;
	end: number;
	kind: TokenKind;
}

export interface TokenizedParagraph {
	source: string;
	start: number;
	end: number;
	tokens: SourceToken[];
	trailing: string;
}

export interface TokenizedDocument {
	normalizedSource: string;
	paragraphs: TokenizedParagraph[];
}

export interface DetectedSpan {
	type: NswType;
	startToken: number;
	endToken: number;
}

export interface NormalizationDiagnostics {
	tokenCount: number;
	crfMs: number;
	expansionMs: number;
	totalMs: number;
	usedCrf: boolean;
	usedAbbreviationScorer: boolean;
	fallbackReason?: string;
}

export interface WordMapEntry {
	originalText: string;
	originalStart: number;
	originalEnd: number;
	spokenStart: number;
	spokenEnd: number;
}

export interface NormalizationResult {
	text: string;
	wordMap: readonly WordMapEntry[];
	diagnostics: NormalizationDiagnostics;
}

export interface VietnameseNormalizerAssets {
	detector: CrfDetector | null;
	vietnameseSyllables: ReadonlySet<string>;
	abbreviations: ReadonlyMap<string, readonly string[]>;
	abbreviationScorer: AbbreviationScorer | null;
	confidenceThreshold: number;
	confidenceMargin: number;
}

export interface NormalizationDependencies {
	assets: VietnameseNormalizerAssets;
	now: () => number;
}

import type { AbbreviationScorer } from './abbreviations.ts';
import type { CrfDetector } from './crf.ts';
