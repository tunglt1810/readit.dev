import assert from 'node:assert/strict';
import test from 'node:test';

import {
	MIN_RELIABLE_SYNTHESIS_CHARACTERS,
	consolidateShortSpeechUnits,
	nonWhitespaceCodePointCount,
} from '../../src/offscreen/short_segment_consolidation.ts';
import type { SpeechUnit } from '../../src/offscreen/speech_unit.ts';
import { synthesisTextLimitForLanguage } from '../../src/offscreen/supertonic_helper.ts';

/** Validates: Requirements 2.1, 2.2, 2.3, 2.4, 3.1 */

function unit(text: string, pauseAfterMs: number | null): SpeechUnit {
	return { text, pauseAfterMs };
}

test('counts trimmed non-whitespace Unicode code points for the reliability policy', () => {
	assert.equal(MIN_RELIABLE_SYNTHESIS_CHARACTERS, 20);
	assert.equal(nonWhitespaceCodePointCount(` \t${'𐐷'.repeat(19)}\n `), 19);
	assert.equal(nonWhitespaceCodePointCount(`${'𐐷'.repeat(20)} `), 20);
});

test('shares the resolved engine synthesis limits', () => {
	assert.equal(synthesisTextLimitForLanguage('ko'), 120);
	assert.equal(synthesisTextLimitForLanguage('ja'), 120);
	assert.equal(synthesisTextLimitForLanguage('en'), 300);
	assert.equal(synthesisTextLimitForLanguage('unknown'), 300);
});

test('merges a short unit with the preceding safe neighbour and transfers the right terminal pause', () => {
	const units = [
		unit('The preceding speech unit is already long enough to synthesize reliably.', 180),
		unit('Tail.', 260),
		unit('The following speech unit remains independently reliable.', 90),
	];

	assert.deepEqual(consolidateShortSpeechUnits(units, 'en'), [
		unit('The preceding speech unit is already long enough to synthesize reliably. Tail.', 260),
		unit('The following speech unit remains independently reliable.', 90),
	]);
});

test('repeatedly absorbs a consecutive short run without reordering canonical text', () => {
	const units = [unit('A.', 180), unit('B.', 180), unit('The final unit contains enough text to be reliable on its own.', 260)];

	assert.deepEqual(consolidateShortSpeechUnits(units, 'en'), [
		unit('A. B. The final unit contains enough text to be reliable on its own.', 260),
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

test('uses existing synthesis-only rendering when checking capacity without changing above-threshold units', () => {
	const markerAware = [
		{ text: 'short', synthesisText: 'short.', pauseAfterMs: 180 },
		unit('x'.repeat(294), 260),
	];
	const stable = [unit('a'.repeat(20), 180), unit('b'.repeat(20), 260)];

	assert.deepEqual(consolidateShortSpeechUnits(markerAware, 'en'), markerAware);
	assert.deepEqual(consolidateShortSpeechUnits(stable, 'en'), stable);
	assert.ok(consolidateShortSpeechUnits(stable, 'en').every((speechUnit) => !('synthesisText' in speechUnit)));
});


test('prefers the preceding reliable neighbour when both adjacent merges are safe', () => {
	const preceding = unit('The preceding unit is already long enough to synthesize reliably.', 180);
	const middle = unit('Note', 140);
	const following = unit('The following unit is also long enough to synthesize reliably.', 260);

	assert.deepEqual(consolidateShortSpeechUnits([preceding, middle, following], 'en'), [
		unit(`${preceding.text} ${middle.text}`, middle.pauseAfterMs),
		following,
	]);
});

test('retains absorbed cadence in synthesis text exactly once without changing canonical text or terminal pause ownership', () => {
	const paragraph = consolidateShortSpeechUnits(
		[unit('Heading', 260), unit('The paragraph continues with enough content to be reliable on its own.', 180)],
		'en',
	);
	assert.deepEqual(paragraph, [
		{
			text: 'Heading The paragraph continues with enough content to be reliable on its own.',
			synthesisText: 'Heading. The paragraph continues with enough content to be reliable on its own.',
			pauseAfterMs: 180,
		},
	]);

	const semicolon = consolidateShortSpeechUnits(
		[unit('Theo AFP;', 140), unit('The following unit contains enough content to be reliable.', 180)],
		'en',
	);
	assert.deepEqual(semicolon, [unit('Theo AFP; The following unit contains enough content to be reliable.', 180)]);
	assert.equal('synthesisText' in semicolon[0], false);

	const compatibility = consolidateShortSpeechUnits(
		[unit('标题', null), unit('兼容路径保留足够的字符以便稳定合成并保持原有顺序。', null)],
		'zh',
	);
	assert.equal(compatibility[0]?.synthesisText, '标题. 兼容路径保留足够的字符以便稳定合成并保持原有顺序。');
	assert.equal(compatibility[0]?.pauseAfterMs, null);
});

test('property: protected forms remain whole and ordered across generated safe merges', () => {
	const forms = ['https://example.test/v1.2.3', 'reader@example.test', '11/07/2026', 'v2.3.4', '10:30', '3.5kg'];
	for (const [index, form] of forms.entries()) {
		const short = unit(`Note${index}`, 260);
		const follower = unit(`${form} remains intact in the following reliably long speech unit.`, 180);
		const [merged] = consolidateShortSpeechUnits([short, follower], 'en');

		assert.equal(merged.text, `${short.text} ${follower.text}`);
		assert.equal(merged.text.includes(form), true, form);
		assert.equal(merged.pauseAfterMs, follower.pauseAfterMs);
		assert.ok(merged.text.length <= synthesisTextLimitForLanguage('en'));
	}
});
