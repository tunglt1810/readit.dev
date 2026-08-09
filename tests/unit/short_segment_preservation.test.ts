import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackSession } from '../../src/background/playback_state.ts';
import { synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';
import { AudioExportEngine } from '../../src/offscreen/audio_export_engine.ts';
import { estimateSpeechUnitDurations, estimateSpeechUnits } from '../../src/offscreen/audio_export_estimate.ts';
import { planLatinSpeechUnits } from '../../src/offscreen/latin/speech_units.ts';
import { preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';
import { consolidateShortSpeechUnits } from '../../src/offscreen/short_segment_consolidation.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';
import { TextToSpeech } from '../../src/offscreen/supertonic_helper.ts';
import { IndexedSynthesisCoordinator } from '../../src/offscreen/synthesis_coordinator.ts';
import { normalizeSourceText } from '../../src/offscreen/text_normalization.ts';
import { attachPlainWordMap } from '../../src/offscreen/word_map.ts';

/** Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6 */

const MIN_RELIABLE_SYNTHESIS_CHARACTERS = 50;

const diagnostics = {
	tokenCount: 2,
	crfMs: 0,
	expansionMs: 0,
	totalMs: 0,
	usedCrf: true,
	usedAbbreviationScorer: false,
};

function nonWhitespaceCodePointCount(text: string): number {
	return Array.from(text.trim()).filter((character) => !/\s/u.test(character)).length;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

function assertAbsentSynthesisText(units: readonly SpeechUnit[]): void {
	for (const unit of units) {
		assert.equal('synthesisText' in unit, false, `unexpected synthesis-only rendering for ${JSON.stringify(unit.text)}`);
	}
}

/** The Latin path as `preparePlaybackUnits` runs it: normalize, plan per sentence, then consolidate. */
function planAndConsolidate(source: string, language = 'en'): SpeechUnit[] {
	return attachPlainWordMap(consolidateShortSpeechUnits(planLatinSpeechUnits(normalizeSourceText(source).paragraphs), language));
}

function assertMappedTokens(units: readonly SpeechUnit[], expected: readonly string[]): void {
	const actual = units.flatMap((unit) =>
		(unit.wordMap ?? []).map((entry) => {
			assert.ok(entry.start >= 0 && entry.end >= entry.start && entry.end <= unit.text.length);
			assert.equal(unit.text.slice(entry.start, entry.end), entry.text);
			return entry.text;
		}),
	);
	assert.deepEqual(actual, expected);
}

test('preserves all-above-threshold canonical Latin planning field-for-field', async () => {
	const sources = [
		'Every planned unit in this sentence has more than twenty non-whitespace Unicode code points.',
		'Première unité suffisamment longue pour rester stable. Deuxième unité suffisamment longue également.',
		'First paragraph remains comfortably above the reliability threshold.\n\nSecond paragraph also remains comfortably above the reliability threshold.',
	];

	for (const source of sources) {
		const planned = planAndConsolidate(source);
		assert.ok(
			planned.every((unit) => nonWhitespaceCodePointCount(unit.text) >= MIN_RELIABLE_SYNTHESIS_CHARACTERS),
			source,
		);

		const prepared = await preparePlaybackUnits(source, 'en', null);
		assert.deepEqual(prepared, planned, source);
		assertAbsentSynthesisText(prepared);
	}
});

test('preserves observed sentence, semicolon, colon, paragraph, fallback, and protected-token planning boundaries', async () => {
	const semicolonSource =
		'Dự thảo đồng thời bổ sung nhóm chức danh được sử dụng thường xuyên một ôtô trong thời gian công tác, không quy định mức giá, gồm: Chủ nhiệm Ủy ban Kiểm tra Trung ương; trưởng các ban Đảng ở Trung ương; Chánh Văn phòng Trung ương Đảng; Giám đốc Học viện Chính trị quốc gia Hồ Chí Minh.';
	assert.deepEqual(
		planLatinSpeechUnits(normalizeSourceText(semicolonSource).paragraphs).map(({ pauseAfterMs }) => pauseAfterMs),
		[180],
	);

	const colonPrefix = 'alpha '.repeat(31).trim();
	const colonSource = `${colonPrefix}: ${'tail '.repeat(40).trim()}.`;
	const colonUnits = planLatinSpeechUnits(normalizeSourceText(colonSource).paragraphs);
	assert.equal(colonUnits[0]?.text, `${colonPrefix}:`);
	assert.equal(colonUnits[0]?.pauseAfterMs, 90);

	const paragraphUnits = planLatinSpeechUnits(
		normalizeSourceText(
			'First paragraph is long enough to keep its boundary explicit.\n\nSecond paragraph is also long enough to remain independent.',
		).paragraphs,
	);
	assert.equal(paragraphUnits[0]?.pauseAfterMs, 260);
	assert.equal(paragraphUnits.at(-1)?.pauseAfterMs, 180);

	const protectedForms = ['admin@example.com', '11-07-2026', 'v2.3.4', '10:30', '3.5kg', 'https://a-b.example/x;y'];
	const protectedSource = `${'prefix '.repeat(30)}${protectedForms.join(' ')} ${'suffix '.repeat(30)}`.trim();
	const protectedUnits = await preparePlaybackUnits(protectedSource, 'en', null);
	assert.equal(normalizeWhitespace(protectedUnits.map((unit) => unit.text).join(' ')), normalizeWhitespace(protectedSource));
	assertMappedTokens(protectedUnits, protectedSource.split(/\s+/u));
	assertAbsentSynthesisText(protectedUnits);

	const compatibility = await preparePlaybackUnits('中文内容 保持 兼容 映射', 'zh', null);
	assert.deepEqual(
		compatibility.map(({ text, pauseAfterMs }) => ({ text, pauseAfterMs })),
		[{ text: '中文内容 保持 兼容 映射', pauseAfterMs: null }],
	);
});

test('preserves ordered word associations for Latin, normalized Vietnamese, fallback Vietnamese, and compatibility units', async () => {
	const latin = 'Plain Latin mapping remains stable across each source token.';
	const latinUnits = await preparePlaybackUnits(latin, 'en', null);
	assertMappedTokens(latinUnits, latin.split(/\s+/u));

	const spokenDate = 'mười một tháng bảy năm hai nghìn không trăm hai mươi sáu';
	const normalized = await preparePlaybackUnits('Có 11/07/2026.', 'vi', {
		async normalize() {
			return {
				text: `Có ${spokenDate}.`,
				wordMap: [
					{ originalText: 'Có', originalStart: 0, originalEnd: 2, spokenStart: 0, spokenEnd: 2 },
					{ originalText: '11/07/2026', originalStart: 3, originalEnd: 13, spokenStart: 3, spokenEnd: 3 + spokenDate.length },
				],
				diagnostics,
			};
		},
	});
	assert.deepEqual(
		normalized.flatMap((speechUnit) =>
			(speechUnit.wordMap ?? []).map((entry) => ({
				text: entry.text,
				spokenText: speechUnit.text.slice(entry.start, entry.end),
			})),
		),
		[
			{ text: 'Có', spokenText: 'Có' },
			{ text: '11/07/2026', spokenText: spokenDate },
		],
	);

	const fallback = 'Một đường dự phòng đủ dài để giữ các ánh xạ từ gốc.';
	const fallbackUnits = await preparePlaybackUnits(fallback, 'vi', {
		async normalize() {
			throw new Error('baseline fallback');
		},
	});
	assertMappedTokens(fallbackUnits, fallback.split(/\s+/u));

	const compatibility = '中文 兼容 路径 映射 保持 原样';
	const compatibilityUnits = await preparePlaybackUnits(compatibility, 'zh', null);
	assertMappedTokens(compatibilityUnits, compatibility.split(/\s+/u));
});

test('property: protected forms and all-above-threshold units preserve canonical order, maps, and no synthesis override', async () => {
	const protectedForms = ['https://example.test/v1.2.3', 'reader@example.test', '11/07/2026', 'v2.3.4', '10:30', '3.5kg'];
	for (const [index, protectedForm] of protectedForms.entries()) {
		const source = `${'leading content '.repeat(12)}${protectedForm} ${'trailing content '.repeat(12)}case${index}.`;
		const planned = planAndConsolidate(source);
		assert.ok(planned.every((unit) => nonWhitespaceCodePointCount(unit.text) >= MIN_RELIABLE_SYNTHESIS_CHARACTERS));

		const prepared = await preparePlaybackUnits(source, 'en', null);
		assert.deepEqual(prepared, planned, protectedForm);
		assert.equal(prepared.flatMap((unit) => unit.wordMap ?? []).filter((entry) => entry.text === protectedForm).length, 1);
		assertAbsentSynthesisText(prepared);
	}
});

function createDurationEngine(rawDuration: number): TextToSpeech {
	const textProcessor = {
		call() {
			return { textIds: [[1, 0]], textMask: [[[1, 0]]] };
		},
	};
	const durationPredictor = {
		async run() {
			return { duration: { data: new Float32Array([rawDuration]) } };
		},
	};
	return new TextToSpeech(
		{ ae: { sample_rate: 24_000, base_chunk_size: 512 }, ttl: { chunk_compress_factor: 4, latent_dim: 64 } },
		textProcessor as never,
		durationPredictor as never,
		{} as never,
		{} as never,
		{} as never,
	);
}

async function exportAtSpeed(speed: number, unit: SpeechUnit): Promise<number[]> {
	const observed: number[] = [];
	const engine = new AudioExportEngine({
		takeHandle: async () => null,
		deleteHandle: async () => {},
		createEncoder: async () => ({
			add: async () => {},
			finalize: async () => {},
			cancel: async () => {},
			bytesWritten: () => 0,
			outputBlob: () => new Blob(),
		}),
		download: async () => {},
		synthesize: async (input) => {
			observed.push(input.speed);
			return { duration: 1 } as AudioBuffer;
		},
		canStartBackgroundSynthesis: () => true,
		waitForRunway: async () => {},
		wakeRunway: () => {},
		onProgress: () => {},
		now: () => 0,
	});
	engine.prepare({
		jobId: `preservation-${speed}`,
		playbackSessionId: 'session',
		outputFilename: 'preservation.mp3',
		units: [unit],
		language: 'en',
		voiceStyleId: 'voice',
		style: {} as never,
		speed,
		estimate: estimateSpeechUnits([unit], 'en', speed),
	});
	await engine.start(`preservation-${speed}`);
	return observed;
}

test('property: every observed controller speed, including exact 1.5, is passed unchanged once through prediction, synthesis, scheduling, and export', async () => {
	const unit: SpeechUnit = { text: 'one two three four', pauseAfterMs: 500, wordMap: [] };
	for (const speed of [1.05, 1.25, 1.5, 2] as const) {
		const session = createPlaybackSession({
			sessionId: `session-${speed}`,
			contentScope: 'article',
			source: { kind: 'tab', tabId: 1, title: 'Preservation', url: 'https://example.test' },
			readableSurface: 'website-dom',
			lang: 'en',
			voiceStyleId: 'voice',
			speed,
			now: 0,
		});
		assert.equal(session.speed, speed);

		const predictor = createDurationEngine(21);
		const style = { dp: { type: 'float32', data: new Float32Array([0]), dims: [1, 1, 1] } };
		assert.deepEqual(await predictor.predictDurations(['one two three four'], ['en'], style as never, session.speed), [21 / speed]);

		const schedulerSpeeds: number[] = [];
		const engineSpeeds: number[] = [];
		const coordinator = new IndexedSynthesisCoordinator<{ unit: SpeechUnit; speed: number }, Float32Array>(async (input) => {
			schedulerSpeeds.push(input.speed);
			return synthesizeSpeechUnitSamples(input.unit, 'en', input.speed, async (_text, _lang, _steps, requestedSpeed) => {
				engineSpeeds.push(requestedSpeed);
				return new Float32Array(128).fill(0.1);
			});
		});
		await coordinator.get({ session: 1, unitIndex: 0, speedVersion: 0 }, { unit, speed: session.speed });
		assert.deepEqual(schedulerSpeeds, [speed]);
		assert.deepEqual(engineSpeeds, [speed]);

		const expectedDuration = 1.5 / speed + 0.5;
		assert.deepEqual(estimateSpeechUnitDurations([unit], 'en', session.speed), [expectedDuration]);
		assert.equal(estimateSpeechUnits([unit], 'en', session.speed).durationSeconds, expectedDuration);
		assert.deepEqual(await exportAtSpeed(session.speed, unit), [speed]);
	}
});
