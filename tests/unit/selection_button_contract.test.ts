import assert from 'node:assert/strict';
import test from 'node:test';
import {
	isSelectionButtonEnabled,
	SELECTION_BUTTON_HOST_ID,
	SELECTION_BUTTON_ICON_SIZE,
	SELECTION_BUTTON_SIZE,
} from '../../src/shared/selection_button.ts';

test('selection button defaults on and only literal false disables it', () => {
	assert.equal(isSelectionButtonEnabled(undefined), true);
	assert.equal(isSelectionButtonEnabled(true), true);
	assert.equal(isSelectionButtonEnabled(false), false);
	assert.equal(isSelectionButtonEnabled('false'), true);
});

test('selection button dimensions and host id stay stable', () => {
	assert.equal(SELECTION_BUTTON_HOST_ID, 'readit-dev-selection-button-host');
	assert.equal(SELECTION_BUTTON_SIZE, 36);
	assert.equal(SELECTION_BUTTON_ICON_SIZE, 26);
});
