import * as nodeOrt from 'onnxruntime-web';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { OnnxAbbreviationScorer } from '../../src/offscreen/vietnamese/abbreviation_scorer.ts';
import {
	type AbbreviationScorer,
	calibrateAbbreviationConfidence,
	expandAbbreviation,
	parseAbbreviationDictionary,
} from '../../src/offscreen/vietnamese/abbreviations.ts';

function request(source: string, dictionaryText: string, scorer: AbbreviationScorer | null = null) {
	return {
		source,
		leftContext: 'ngữ cảnh bên trái',
		rightContext: 'ngữ cảnh bên phải',
		dictionary: parseAbbreviationDictionary(dictionaryText),
		scorer,
		confidenceThreshold: 0.7,
		confidenceMargin: 0.2,
	};
}

test('returns a unique dictionary value without invoking the scorer', async () => {
	let calls = 0;
	const scorer: AbbreviationScorer = {
		async score() {
			calls++;
			return [1];
		},
	};
	assert.equal(await expandAbbreviation(request('ĐH', 'ĐH:đại học', scorer)), 'đại học');
	assert.equal(calls, 0);
});

test('uses punctuation-cleaned dictionary lookup without changing the source', async () => {
	assert.equal(await expandAbbreviation(request('TP.HCM', 'TPHCM:Thành phố Hồ Chí Minh')), 'Thành phố Hồ Chí Minh');
});

test('selects only a dictionary candidate above confidence and margin gates', async () => {
	const scorer: AbbreviationScorer = {
		async score() {
			return [3, 0];
		},
	};
	assert.equal(await expandAbbreviation(request('ĐH', 'ĐH:đại học,đại hội', scorer)), 'đại học');
});

test('fails safely for low confidence, malformed scores, and scorer exceptions', async () => {
	const scorers: AbbreviationScorer[] = [
		{
			async score() {
				return [0, 0];
			},
		},
		{
			async score() {
				return [1];
			},
		},
		{
			async score() {
				return [Number.NaN, 0];
			},
		},
		{
			async score() {
				throw new Error('expected scorer failure');
			},
		},
	];
	for (const scorer of scorers) assert.equal(await expandAbbreviation(request('ĐH', 'ĐH:đại học,đại hội', scorer)), 'đê hát');
});

test('spells only vetted unknown uppercase sequences', async () => {
	assert.equal(await expandAbbreviation(request('KPI', 'ĐH:đại học')), 'ca pê i');
	assert.equal(await expandAbbreviation(request('Covid', 'ĐH:đại học')), null);
	assert.equal(await expandAbbreviation(request('AB-123-CD', 'ĐH:đại học')), null);
});

test('parses duplicate dictionary records deterministically and rejects malformed records', () => {
	const dictionary = parseAbbreviationDictionary('ĐH:đại học,đại hội\nĐH:đại học\n');
	assert.deepEqual(dictionary.get('ĐH'), ['đại học', 'đại hội']);
	assert.throws(() => parseAbbreviationDictionary('ĐH:'), /malformed/);
	assert.throws(() => parseAbbreviationDictionary('không có dấu phân cách'), /malformed/);
});

test('calibrates with zero wrong accepted expansions and deterministic tie-breakers', () => {
	assert.deepEqual(
		calibrateAbbreviationConfidence([
			{ scores: [4, 0], expectedIndex: 0 },
			{ scores: [0, 1], expectedIndex: 0 },
		]),
		{ confidenceThreshold: 0.95, confidenceMargin: 0.3, correctAccepted: 1 },
	);
});

test('runs the pinned ONNX scorer locally and rejects remote model URLs', async () => {
	const assetRoot = new URL('../../public/assets/vietnamese-normalizer/', import.meta.url);
	const config = JSON.parse(readFileSync(new URL('abbreviation-config.json', assetRoot), 'utf8'));
	const model = new Uint8Array(readFileSync(new URL('abbreviation-scorer.onnx', assetRoot)));
	const scorer = await OnnxAbbreviationScorer.createWithRuntime(model, config, nodeOrt);
	const scores = await scorer.score(['Đại học', 'Đại hội'], 'Trường', 'Bách Khoa');
	assert.equal(scores.length, 2);
	assert.ok(scores.every(Number.isFinite));
	await assert.rejects(
		() => OnnxAbbreviationScorer.createWithRuntime('https://example.com/scorer.onnx', config, nodeOrt),
		/extension-local/,
	);
});
