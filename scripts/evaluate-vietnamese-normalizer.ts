import * as nodeOrt from 'onnxruntime-web';

import { readFile } from 'node:fs/promises';
import { type AbbreviationScorerConfig, OnnxAbbreviationScorer } from '../src/offscreen/vietnamese/abbreviation_scorer.ts';
import { parseAbbreviationDictionary } from '../src/offscreen/vietnamese/abbreviations.ts';
import { createCrfDetector, decodePortableCrfModel, reconstructDetectedSpans } from '../src/offscreen/vietnamese/crf.ts';
import {
	expandTypedSpan,
	MEASUREMENT_UNIT_KEYS,
	MONEY_UNIT_KEYS,
	recognizeDeterministicType,
} from '../src/offscreen/vietnamese/expanders.ts';
import { detectVietnameseLabels, normalizeVietnameseText } from '../src/offscreen/vietnamese/normalizer.ts';
import { tokenizeVietnameseText } from '../src/offscreen/vietnamese/tokenizer.ts';
import { type CheckpointLabel, NSW_TYPES, type NswType, type VietnameseNormalizerAssets } from '../src/offscreen/vietnamese/types.ts';

interface EvaluationDocument {
	id: string;
	domain: 'general' | 'business' | 'technology' | 'health' | 'science' | 'sports';
	scenario: string;
	text: string;
	spans: Array<{ start: number; end: number; type: NswType; expected: string }>;
}

const root = new URL('../', import.meta.url);
const assetRoot = new URL('public/assets/vietnamese-normalizer/', root);
const readAsset = (name: string) => readFile(new URL(name, assetRoot));
const manifest = JSON.parse(await readAsset('model-manifest.json').then((data) => data.toString('utf8'))) as {
	labels: CheckpointLabel[];
	abbreviation: { confidenceThreshold: number; confidenceMargin: number };
};
const abbreviations = parseAbbreviationDictionary(await readAsset('abbreviations.txt').then((data) => data.toString('utf8')));
const vietnameseSyllables = new Set((await readAsset('vietnamese-syllables.txt')).toString('utf8').split(/\r?\n/u).filter(Boolean));
const crfBytes = await readAsset('crf-model.bin');
const crfBuffer = crfBytes.buffer.slice(crfBytes.byteOffset, crfBytes.byteOffset + crfBytes.byteLength) as ArrayBuffer;
const detector = createCrfDetector(decodePortableCrfModel(crfBuffer, manifest.labels), {
	vietnameseSyllables,
	abbreviations: new Set(abbreviations.keys()),
	moneyUnits: MONEY_UNIT_KEYS,
	measurementUnits: MEASUREMENT_UNIT_KEYS,
});
const scorerConfig = JSON.parse(
	await readAsset('abbreviation-config.json').then((data) => data.toString('utf8')),
) as AbbreviationScorerConfig;
const abbreviationScorer = await OnnxAbbreviationScorer.createWithRuntime(
	new Uint8Array(await readAsset('abbreviation-scorer.onnx')),
	scorerConfig,
	nodeOrt,
);
const assets: VietnameseNormalizerAssets = {
	detector,
	vietnameseSyllables,
	abbreviations,
	abbreviationScorer,
	confidenceThreshold: manifest.abbreviation.confidenceThreshold,
	confidenceMargin: manifest.abbreviation.confidenceMargin,
};

const corpus = JSON.parse(
	await readFile(new URL('tests/fixtures/vietnamese-normalizer/evaluation-corpus.json', root), 'utf8'),
) as EvaluationDocument[];
if (corpus.length < 30 || new Set(corpus.map(({ domain }) => domain)).size !== 6) {
	throw new Error('Evaluation corpus domain/document gate failed');
}
if (corpus.reduce((count, document) => count + document.spans.length, 0) < 200) {
	throw new Error('Evaluation corpus requires at least 200 spans');
}
if (new Set(corpus.map(({ scenario }) => scenario)).size < 10) {
	throw new Error('Evaluation corpus requires at least 10 distinct scenarios');
}
const coveredTypes = new Set(corpus.flatMap(({ spans }) => spans.map(({ type }) => type)));
const missingTypes = NSW_TYPES.filter((type) => !coveredTypes.has(type));
if (missingTypes.length > 0) {
	throw new Error(`Evaluation corpus is missing NSW types: ${missingTypes.join(', ')}`);
}

let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
let emptyDocuments = 0;
let fallbackDocuments = 0;
const mismatchSamples: Array<{ id: string; expected: string[]; predicted: string[] }> = [];
const normalizationMismatches: Array<{ id: string; expected: string; actual: string }> = [];
for (const document of corpus) {
	const predicted: Array<{ start: number; end: number; type: NswType }> = [];
	for (const paragraph of tokenizeVietnameseText(document.text).paragraphs) {
		const detected = detectVietnameseLabels(paragraph.tokens, assets);
		if (!detected.usedCrf || detected.fallbackReason) {
			fallbackDocuments++;
		}
		for (const span of reconstructDetectedSpans(detected.labels)) {
			const source = paragraph.tokens
				.slice(span.startToken, span.endToken)
				.map((token, index) => `${index === 0 ? '' : token.leading}${token.original}`)
				.join('');
			if (span.type !== 'LABB') {
				const expansion = expandTypedSpan(span.type, source);
				if (!expansion || expansion.trim() === source.trim()) {
					continue;
				}
			}
			predicted.push({
				start: paragraph.tokens[span.startToken].start,
				end: paragraph.tokens[span.endToken - 1].end,
				type: span.type,
			});
		}
	}
	const expectedKeys = new Set(document.spans.map(({ start, end, type }) => `${start}:${end}:${type}`));
	const predictedKeys = new Set(predicted.map(({ start, end, type }) => `${start}:${end}:${type}`));
	for (const key of predictedKeys) {
		expectedKeys.has(key) ? truePositive++ : falsePositive++;
	}
	for (const key of expectedKeys) {
		if (!predictedKeys.has(key)) {
			falseNegative++;
		}
	}
	if ([...expectedKeys].some((key) => !predictedKeys.has(key)) || [...predictedKeys].some((key) => !expectedKeys.has(key))) {
		mismatchSamples.push({ id: document.id, expected: [...expectedKeys], predicted: [...predictedKeys] });
	}
	const normalized = await normalizeVietnameseText(document.text, { assets, now: performance.now.bind(performance) });
	if (document.text.length > 0 && normalized.text.length === 0) {
		emptyDocuments++;
	}
	const sortedSpans = [...document.spans].sort((left, right) => left.start - right.start);
	let cursor = 0;
	let expectedText = '';
	for (const span of sortedSpans) {
		if (span.start < cursor || span.end <= span.start || document.text.slice(span.start, span.end).length === 0) {
			throw new Error(`Invalid or overlapping span in ${document.id}`);
		}
		expectedText += document.text.slice(cursor, span.start) + span.expected;
		cursor = span.end;
	}
	expectedText += document.text.slice(cursor);
	if (normalized.text !== expectedText) {
		normalizationMismatches.push({ id: document.id, expected: expectedText, actual: normalized.text });
	}
}
const precision = truePositive / (truePositive + falsePositive || 1);
const recall = truePositive / (truePositive + falseNegative || 1);
const f1 = (2 * precision * recall) / (precision + recall || 1);

const expansionGoldens = JSON.parse(
	await readFile(new URL('tests/fixtures/vietnamese-normalizer/expansion-goldens.json', root), 'utf8'),
) as Array<{ type: Exclude<NswType, 'LABB'>; input: string; expected: string }>;
let deterministicMatches = 0;
for (const golden of expansionGoldens) {
	if (expandTypedSpan(golden.type, golden.input) === golden.expected) {
		deterministicMatches++;
	}
}
const deterministicRate = deterministicMatches / expansionGoldens.length;

const mustNotChange = JSON.parse(
	await readFile(new URL('tests/fixtures/vietnamese-normalizer/must-not-change.json', root), 'utf8'),
) as string[];
let preservationMatches = 0;
const preservationFailures: string[] = [];
const deterministicOnlyAssets = { ...assets, detector: null, abbreviationScorer: null };
for (const source of mustNotChange) {
	const recognized = recognizeDeterministicType(source);
	if (recognized === 'URLE') {
		if (expandTypedSpan('URLE', source)) {
			preservationMatches++;
		} else {
			preservationFailures.push(source);
		}
	} else {
		const normalized = await normalizeVietnameseText(source, {
			assets: deterministicOnlyAssets,
			now: performance.now.bind(performance),
		});
		if (normalized.text === source) {
			preservationMatches++;
		} else {
			preservationFailures.push(`${source} => ${normalized.text}`);
		}
	}
}
const preservationRate = preservationMatches / mustNotChange.length;

const report = {
	documents: corpus.length,
	spans: corpus.reduce((count, document) => count + document.spans.length, 0),
	precision,
	recall,
	f1,
	deterministicRate,
	preservationRate,
	emptyDocuments,
	fallbackDocuments,
	mismatchSamples: mismatchSamples.slice(0, 3),
	normalizationMismatches: normalizationMismatches.slice(0, 3),
	preservationFailures,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (
	f1 < 0.9 ||
	deterministicRate !== 1 ||
	preservationRate !== 1 ||
	emptyDocuments !== 0 ||
	fallbackDocuments !== 0 ||
	normalizationMismatches.length !== 0
) {
	process.exitCode = 1;
}
