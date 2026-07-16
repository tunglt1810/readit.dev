import assert from 'node:assert/strict';
import test from 'node:test';
import { requestActionPopup } from '../../src/background/action_popup.ts';

test('requests the action popup in the sender window', async () => {
	const calls: unknown[] = [];
	await requestActionPopup(7, {
		openPopup: async (options) => {
			calls.push(options);
		},
	});
	assert.deepEqual(calls, [{ windowId: 7 }]);
});

test('absorbs popup API rejection', async () => {
	await assert.doesNotReject(() =>
		requestActionPopup(7, {
			openPopup: async () => {
				throw new Error('Popup unavailable');
			},
		}),
	);
});
