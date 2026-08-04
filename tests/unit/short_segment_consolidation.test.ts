import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';
import { planLatinSpeechUnits } from '../../src/offscreen/latin/speech_units.ts';
import { preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';

/** Validates: Requirements 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6 */

const MIN_RELIABLE_SYNTHESIS_CHARACTERS = 20;
const VOICED_SAMPLES = new Float32Array([0.04, -0.06, 0.08, -0.05]);

type Scenario = {
	name: string;
	language: 'en' | 'ko' | 'ja';
	source: string;
};

type SynthesisResult = {
	prepared: SpeechUnit[];
	engineCalls: string[];
	started: number[];
	rawWaveforms: Array<{ index: number; samples: Float32Array }>;
	failures: Array<{ index: number; error: unknown }>;
};

function nonWhitespaceCodePointCount(text: string): number {
	return Array.from(text.trim()).filter((character) => !/\s/u.test(character)).length;
}

function synthesisLimit(language: Scenario['language']): number {
	return language === 'ko' || language === 'ja' ? 120 : 300;
}

function canonicalText(units: readonly SpeechUnit[]): string {
	return units.map((unit) => unit.text.trim()).join(' ');
}

function mergeableShortIndexes(units: readonly SpeechUnit[], limit: number): number[] {
	return units.flatMap((unit, index) => {
		if (nonWhitespaceCodePointCount(unit.text) >= MIN_RELIABLE_SYNTHESIS_CHARACTERS) {
			return [];
		}
		const fitsPrevious = index > 0 && canonicalText([units[index - 1], unit]).length <= limit;
		const fitsNext = index < units.length - 1 && canonicalText([unit, units[index + 1]]).length <= limit;
		return fitsPrevious || fitsNext ? [index] : [];
	});
}

function isMateriallyVoiced(samples: Float32Array): boolean {
	return samples.length > 0 && samples.every(Number.isFinite) && samples.some((sample) => Math.abs(sample) >= 0.01);
}

async function runScenario({ language, source }: Scenario): Promise<SynthesisResult> {
	const prepared = await preparePlaybackUnits(source, language, null);
	const engineCalls: string[] = [];
	const started: number[] = [];
	const rawWaveforms: Array<{ index: number; samples: Float32Array }> = [];
	const failures: Array<{ index: number; error: unknown }> = [];

	for (const [index, unit] of prepared.entries()) {
		try {
			const samples = await synthesizeSpeechUnitSamples(unit, language, 1.5, async (text) => {
				engineCalls.push(text);
				return nonWhitespaceCodePointCount(unit.text) < MIN_RELIABLE_SYNTHESIS_CHARACTERS
					? new Float32Array(32)
					: VOICED_SAMPLES;
			});
			rawWaveforms.push({ index, samples });
			started.push(index);
		} catch (error) {
			failures.push({ index, error });
		}
	}

	return { prepared, engineCalls, started, rawWaveforms, failures };
}

function assertExpectedBehavior(scenario: Scenario, planned: readonly SpeechUnit[], result: SynthesisResult): void {
	const limit = synthesisLimit(scenario.language);
	const violations: string[] = [];

	if (canonicalText(result.prepared) !== canonicalText(planned)) {
		violations.push(`canonical reconstruction changed: ${JSON.stringify(canonicalText(result.prepared))}`);
	}
	for (const [index, unit] of result.prepared.entries()) {
		if (!unit.text.trim()) {
			violations.push(`unit ${index} is empty`);
		}
		if (unit.text.length > limit) {
			violations.push(`unit ${index} exceeds the ${limit}-character synthesis limit`);
		}
		for (const entry of unit.wordMap ?? []) {
			if (unit.text.slice(entry.start, entry.end) !== entry.text) {
				violations.push(`word map ${JSON.stringify(entry.text)} no longer refers to canonical unit ${index}`);
			}
		}
	}

	const mergeable = mergeableShortIndexes(result.prepared, limit);
	if (mergeable.length > 0) {
		violations.push(
			`independent mergeable short units at indexes ${mergeable.join(', ')}: ${JSON.stringify(
				mergeable.map((index) => result.prepared[index].text),
			)}`,
		);
	}

	for (const [index, unit] of result.prepared.entries()) {
		if (nonWhitespaceCodePointCount(unit.text) >= MIN_RELIABLE_SYNTHESIS_CHARACTERS || mergeable.includes(index)) {
			continue;
		}
		const raw = result.rawWaveforms.find((waveform) => waveform.index === index)?.samples;
		const failure = result.failures.find((candidate) => candidate.index === index);
		if (raw && !isMateriallyVoiced(raw) && !failure) {
			violations.push(
				`unmergeable short unit ${index} accepted raw pre-padding waveform ${JSON.stringify(Array.from(raw.slice(0, 8)))}`,
			);
		}
	}

	const expectedStarts = result.prepared.map((_, index) => index).filter((index) => !result.failures.some((failure) => failure.index === index));
	if (JSON.stringify(result.started) !== JSON.stringify(expectedStarts)) {
		violations.push(`started indexes ${JSON.stringify(result.started)} are not ordered exactly once`);
	}

	assert.deepEqual(
		violations,
		[],
		`Property 1 baseline counterexample (${scenario.name}, ${scenario.language}, limit ${limit}): ${violations.join('; ')}`,
	);
}

function longText(length: number): string {
	return `L${'a'.repeat(length - 1)}`;
}

const scenarios: readonly Scenario[] = [
	{
		name: 'short first unit',
		language: 'en',
		source: 'Vũ Tuân\n\nThe following paragraph is deliberately long enough to be reliable on its own.',
	},
	{
		name: 'short middle semicolon unit',
		language: 'en',
		source: 'A preceding paragraph remains long enough for normal synthesis output.\n\nTheo AFP;\n\nA following paragraph also remains long enough for normal synthesis output.',
	},
	{
		name: 'short final unit',
		language: 'en',
		source: 'A preceding paragraph remains long enough for normal synthesis output.\n\nTail.',
	},
	{
		name: 'consecutive short units',
		language: 'en',
		source: 'A.\n\nB.\n\nThe final paragraph remains long enough for normal synthesis output.',
	},
	{
		name: 'punctuationless paragraph boundary',
		language: 'en',
		source: 'Heading\n\nThe paragraph continues with enough content to be independently reliable.',
	},
	{
		name: 'protected URL adjacency',
		language: 'en',
		source: 'Note\n\nhttps://example.com/2026/short-segment-audio-dropout?source=test',
	},
];

for (const scenario of scenarios) {
	test(`expected bug condition: ${scenario.name} is consolidated before synthesis`, async () => {
		const planned = planLatinSpeechUnits(scenario.source);
		assert.ok(planned.some((unit) => nonWhitespaceCodePointCount(unit.text) < MIN_RELIABLE_SYNTHESIS_CHARACTERS));
		assertExpectedBehavior(scenario, planned, await runScenario(scenario));
	});
}

test('expected bug condition property: Unicode short units merge without changing canonical mapping or order', async () => {
	const unicodeShorts = ['ééé', '𐐷𐐷𐐷', '한글', '🙂🙂', 'e\u0301e\u0301e\u0301'];
	const protectedForms = ['https://example.test/v1.2.3', '11/07/2026', 'reader@example.test'];
	for (const language of ['en', 'ko', 'ja'] as const) {
		for (const [index, short] of unicodeShorts.entries()) {
			const protectedForm = protectedForms[index % protectedForms.length];
			const scenario: Scenario = {
				name: `unicode ${JSON.stringify(short)} adjacent to ${protectedForm}`,
				language,
				source: `${short};\n\n${protectedForm} remains in source order with sufficient surrounding text.`,
			};
			const planned = planLatinSpeechUnits(scenario.source);
			assertExpectedBehavior(scenario, planned, await runScenario(scenario));
		}
	}
});

test('expected bug condition: capacity-blocked normal and Korean/Japanese units remain ordered for voiced verification', async () => {
	const cases: readonly Scenario[] = [
		{ name: 'normal capacity-blocked', language: 'en', source: `short-frag\n\n${longText(291)}` },
		{ name: 'Korean capacity-blocked', language: 'ko', source: `short-frag\n\n${longText(110)}` },
		{ name: 'Japanese capacity-blocked', language: 'ja', source: `short-frag\n\n${longText(110)}` },
	];
	for (const scenario of cases) {
		const planned = planLatinSpeechUnits(scenario.source);
		const result = await runScenario(scenario);
		assert.equal(mergeableShortIndexes(result.prepared, synthesisLimit(scenario.language)).length, 0, scenario.name);
		assertExpectedBehavior(scenario, planned, result);
	}
});
