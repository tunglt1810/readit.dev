import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePlaybackUnits } from '../../src/offscreen/playback_preparation.ts';

test('rejects an oversized Korean compatibility unit before attaching word maps', async () => {
	await assert.rejects(() => preparePlaybackUnits('한'.repeat(121), 'ko', null), RangeError);
});

test('plans Latin text to Japanese synthesis capacity before attaching word maps', async () => {
	const source = `${'word '.repeat(25)}end.`;
	const units = await preparePlaybackUnits(source, 'ja', null);

	assert.equal(units.map(({ text }) => text).join(' '), source);
	assert.ok(units.every((unit) => (unit.synthesisText ?? unit.text).length <= 120));
	assert.deepEqual(
		units.flatMap((unit) => unit.wordMap?.map(({ text }) => text) ?? []),
		source.split(' '),
	);
});

test('uses canonical whitespace for compatibility units and their word maps', async () => {
	const [unit] = await preparePlaybackUnits('가\u00a0\u00a0나', 'zh', null);
	assert.equal(unit.text, '가 나');
	assert.deepEqual(unit.wordMap, [
		{ text: '가', start: 0, end: 1 },
		{ text: '나', start: 2, end: 3 },
	]);
});

test('preserves a whitespace-only blank paragraph boundary through preparation when units are not short', async () => {
	const first = 'First paragraph remains deliberately long enough to avoid short-fragment consolidation.';
	const second = 'Second paragraph also remains deliberately long enough to preserve its paragraph cadence.';
	const units = await preparePlaybackUnits(`${first}\n \t\n${second}`, 'en', null);
	assert.deepEqual(
		units.map(({ text, pauseAfterMs }) => ({ text, pauseAfterMs })),
		[
			{ text: first, pauseAfterMs: 260 },
			{ text: second, pauseAfterMs: 180 },
		],
	);
});
