import assert from 'node:assert/strict';
import test from 'node:test';
import {
	consolidateShortSpeechUnits,
	isShortSpeechUnit,
	MIN_RELIABLE_SYNTHESIS_CHARACTERS,
	nonWhitespaceCodePointCount,
} from '../../src/offscreen/short_segment_consolidation.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';
import { synthesisTextLimitForLanguage } from '../../src/offscreen/supertonic_helper.ts';

function unit(text: string, pauseAfterMs: number | null): SpeechUnit {
	return { text, pauseAfterMs };
}

test('counts trimmed non-whitespace Unicode code points for the reliability policy', () => {
	assert.equal(MIN_RELIABLE_SYNTHESIS_CHARACTERS, 50);
	assert.equal(nonWhitespaceCodePointCount(` \t${'𐐷'.repeat(49)}\n `), 49);
	assert.equal(nonWhitespaceCodePointCount(`${'𐐷'.repeat(50)} `), 50);
	assert.equal(isShortSpeechUnit(unit('한'.repeat(49), 180), 'ko'), true);
	assert.equal(isShortSpeechUnit(unit('한'.repeat(50), 180), 'ja'), false);
});

test('shares the resolved engine synthesis limits', () => {
	assert.equal(synthesisTextLimitForLanguage('ko'), 120);
	assert.equal(synthesisTextLimitForLanguage('ja'), 120);
	assert.equal(synthesisTextLimitForLanguage('en'), 300);
	assert.equal(synthesisTextLimitForLanguage('unknown'), 300);
});

test('merges a short unit with the preceding safe neighbour and transfers the right terminal pause', () => {
	const units = [
		unit('The preceding speech unit is reliable and long enough to synthesize.', 180),
		unit('Tail.', 260),
		unit('The following speech unit remains independently reliable and has enough content.', 90),
	];

	assert.deepEqual(consolidateShortSpeechUnits(units, 'en'), [
		unit('The preceding speech unit is reliable and long enough to synthesize. Tail.', 260),
		unit('The following speech unit remains independently reliable and has enough content.', 90),
	]);
});

test('retains capacity-blocked and singleton short units without fabrication or loss', () => {
	const normalLimitBlocked = [unit('tiny', 180), unit('x'.repeat(296), 260)];
	const koreanLimitBlocked = [unit('tiny', 180), unit('x'.repeat(116), 260)];
	const singleton = [unit('tiny', 180)];

	assert.deepEqual(consolidateShortSpeechUnits(normalLimitBlocked, 'en'), normalLimitBlocked);
	assert.deepEqual(consolidateShortSpeechUnits(koreanLimitBlocked, 'ko'), koreanLimitBlocked);
	assert.deepEqual(consolidateShortSpeechUnits(singleton, 'ja'), singleton);
});

test('uses synthetic punctuation only for absorbed numeric audible boundaries', () => {
	const audible = consolidateShortSpeechUnits(
		[unit('Heading', 260), unit('The paragraph continues with enough content to be reliable on its own.', 180)],
		'en',
	);
	assert.deepEqual(audible, [
		{
			text: 'Heading The paragraph continues with enough content to be reliable on its own.',
			synthesisText: 'Heading. The paragraph continues with enough content to be reliable on its own.',
			pauseAfterMs: 180,
		},
	]);

	const nullPause = consolidateShortSpeechUnits([unit('Heading', null), unit('Continuation text.', 180)], 'en');
	assert.deepEqual(nullPause, [unit('Heading Continuation text.', 180)]);

	const semicolon = consolidateShortSpeechUnits([unit('Theo AFP;', 140), unit('The following unit is reliable.', 180)], 'en');
	assert.deepEqual(semicolon, [
		{
			text: 'Theo AFP; The following unit is reliable.',
			synthesisText: 'Theo AFP;. The following unit is reliable.',
			pauseAfterMs: 180,
		},
	]);
});

test('preserves protected forms in canonical text across feasible merges', () => {
	const forms = ['https://example.test/v1.2.3', 'reader@example.test', '11/07/2026', 'v2.3.4', '10:30', '3.5kg'];
	for (const [index, form] of forms.entries()) {
		const short = unit(`Note${index}`, 260);
		const follower = unit(`${form} remains intact in the following reliably long speech unit.`, 180);
		const [merged] = consolidateShortSpeechUnits([short, follower], 'en');

		assert.equal(merged.text, `${short.text} ${follower.text}`);
		assert.equal(merged.text.includes(form), true, form);
		assert.equal(merged.pauseAfterMs, follower.pauseAfterMs);
		assert.ok((merged.synthesisText ?? merged.text).length <= synthesisTextLimitForLanguage('en'));
	}
});
