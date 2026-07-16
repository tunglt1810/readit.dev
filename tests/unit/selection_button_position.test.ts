import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSelectionButtonPosition } from '../../src/content/selection_button_position.ts';

test('places the button below and right-aligned with the final selection rect', () => {
	assert.deepEqual(
		computeSelectionButtonPosition(
			{ left: 120, top: 80, right: 220, bottom: 120 },
			{ width: 800, height: 600 },
			{ width: 36, height: 36 },
		),
		{ left: 184, top: 126 },
	);
});

test('flips above when the preferred bottom placement would overflow', () => {
	assert.deepEqual(
		computeSelectionButtonPosition(
			{ left: 120, top: 180, right: 220, bottom: 210 },
			{ width: 320, height: 240 },
			{ width: 36, height: 36 },
		),
		{ left: 184, top: 138 },
	);
});

test('flips left and clamps to the viewport margin', () => {
	assert.deepEqual(
		computeSelectionButtonPosition(
			{ left: 300, top: 20, right: 318, bottom: 42 },
			{ width: 320, height: 240 },
			{ width: 36, height: 36 },
		),
		{ left: 258, top: 48 },
	);
	assert.deepEqual(
		computeSelectionButtonPosition({ left: 0, top: 0, right: 12, bottom: 12 }, { width: 40, height: 40 }, { width: 36, height: 36 }),
		{ left: 0, top: 0 },
	);
});
