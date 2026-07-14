import * as nodeOrt from 'onnxruntime-web';

import { readFile, writeFile } from 'node:fs/promises';
import { type AbbreviationScorerConfig, OnnxAbbreviationScorer } from '../src/offscreen/vietnamese/abbreviation_scorer.ts';
import { calibrateAbbreviationConfidence, parseAbbreviationDictionary } from '../src/offscreen/vietnamese/abbreviations.ts';

interface CalibrationFixture {
	source: string;
	leftContext: string;
	rightContext: string;
	expected: string;
}

const root = new URL('../', import.meta.url);
const assetRoot = new URL('public/assets/vietnamese-normalizer/', root);
const dictionary = parseAbbreviationDictionary(await readFile(new URL('abbreviations.txt', assetRoot), 'utf8'));
const config = JSON.parse(await readFile(new URL('abbreviation-config.json', assetRoot), 'utf8')) as AbbreviationScorerConfig;
const scorer = await OnnxAbbreviationScorer.createWithRuntime(
	new Uint8Array(await readFile(new URL('abbreviation-scorer.onnx', assetRoot))),
	config,
	nodeOrt,
);
const fixtures = JSON.parse(
	await readFile(new URL('tests/fixtures/vietnamese-normalizer/abbreviation-calibration.json', root), 'utf8'),
) as CalibrationFixture[];
if (fixtures.length < 20) {
	throw new Error('At least 20 reviewed abbreviation contexts are required');
}

const samples = [];
for (const fixture of fixtures) {
	const candidates = dictionary.get(fixture.source);
	const expectedIndex = candidates?.indexOf(fixture.expected) ?? -1;
	if (!candidates || candidates.length < 2 || expectedIndex < 0) {
		throw new Error(`Invalid calibration fixture for ${fixture.source}`);
	}
	samples.push({
		scores: await scorer.score(candidates, fixture.leftContext, fixture.rightContext),
		expectedIndex,
	});
}

const calibration = calibrateAbbreviationConfidence(samples);
if (process.argv.includes('--write')) {
	const manifestUrl = new URL('model-manifest.json', assetRoot);
	const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
	manifest.abbreviation = {
		confidenceThreshold: calibration.confidenceThreshold,
		confidenceMargin: calibration.confidenceMargin,
	};
	await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify({ ...calibration, sampleCount: samples.length })}\n`);
