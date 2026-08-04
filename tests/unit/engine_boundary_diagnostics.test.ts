import assert from 'node:assert/strict';
import test from 'node:test';

import { ENGINE_BOUNDARY_DIAGNOSTIC_STAGE, EngineBoundaryDiagnostics, safeTextIdentifier } from '../../src/offscreen/engine_boundary_diagnostics.ts';
import { synthesizeSpeechUnitSamples } from '../../src/offscreen/audio.ts';
import { VoicedAudioError } from '../../src/offscreen/voiced_audio.ts';

test('records immutable foreground raw metrics with safe canonical and synthesis identifiers', () => {
	const diagnostics = new EngineBoundaryDiagnostics();
	const samples = new Float32Array(128).fill(0.5);
	diagnostics.record({
		probeId: 'probe-1',
		unitIndex: 3,
		owner: 'foreground',
		canonicalText: 'Heading The paragraph continues.',
		synthesisText: 'Heading. The paragraph continues.',
		language: 'en',
		requestedSpeed: 1.5,
		samples,
	});

	const [record] = diagnostics.read('probe-1');
	assert.deepEqual(record, {
		stage: ENGINE_BOUNDARY_DIAGNOSTIC_STAGE,
		probeId: 'probe-1',
		unitIndex: 3,
		owner: 'foreground',
		canonicalTextHash: safeTextIdentifier('Heading The paragraph continues.'),
		synthesisTextHash: safeTextIdentifier('Heading. The paragraph continues.'),
		language: 'en',
		requestedSpeed: 1.5,
		rawSampleCount: 128,
		finite: true,
		peak: 0.5,
		maxWindowRms: 0.5,
		voiced: true,
	});
	assert.equal(Object.isFrozen(record), true);

	diagnostics.clear('probe-1');
	assert.deepEqual(diagnostics.read(), []);
});

test('records an unvoiced raw waveform before the shared verifier rejects it', async () => {
	const diagnostics = new EngineBoundaryDiagnostics();
	await assert.rejects(
		() =>
			synthesizeSpeechUnitSamples(
				{ text: 'short singleton', pauseAfterMs: 180 },
				'en',
				1.5,
				async () => new Float32Array(32),
				{ unitIndex: 7, unitText: 'short singleton' },
				(samples) =>
					diagnostics.record({
						probeId: 'probe-2',
						unitIndex: 7,
						owner: 'export',
						canonicalText: 'short singleton',
						synthesisText: 'short singleton',
						language: 'en',
						requestedSpeed: 1.5,
						samples,
					}),
			),
		(error: unknown) => error instanceof VoicedAudioError && error.reason === 'materially-silent',
	);

	assert.deepEqual(diagnostics.read('probe-2').map((record) => ({
		stage: record.stage,
		owner: record.owner,
		unitIndex: record.unitIndex,
		requestedSpeed: record.requestedSpeed,
		rawSampleCount: record.rawSampleCount,
		finite: record.finite,
		voiced: record.voiced,
	})), [
		{
			stage: ENGINE_BOUNDARY_DIAGNOSTIC_STAGE,
			owner: 'export',
			unitIndex: 7,
			requestedSpeed: 1.5,
			rawSampleCount: 32,
			finite: true,
			voiced: false,
		},
	]);
});
