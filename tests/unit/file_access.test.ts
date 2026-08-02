import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIsFileSchemeAccessAllowed } from '../../src/background/file_access.ts';

test('checkIsFileSchemeAccessAllowed handles callback pattern when file access is allowed', async () => {
	(globalThis as unknown as { chrome: unknown }).chrome = {
		extension: {
			isAllowedFileSchemeAccess: (callback: (isAllowed: boolean) => void) => {
				callback(true);
			},
		},
	};

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, true);
});

test('checkIsFileSchemeAccessAllowed handles callback pattern when file access is disallowed', async () => {
	(globalThis as unknown as { chrome: unknown }).chrome = {
		extension: {
			isAllowedFileSchemeAccess: (callback: (isAllowed: boolean) => void) => {
				callback(false);
			},
		},
	};

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, false);
});

test('checkIsFileSchemeAccessAllowed returns false when chrome API is unavailable', async () => {
	(globalThis as unknown as { chrome: unknown }).chrome = {};

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, false);
});

test('checkIsFileSchemeAccessAllowed fails closed when the callback times out', async () => {
	(globalThis as unknown as { chrome: unknown }).chrome = {
		extension: {
			isAllowedFileSchemeAccess: () => {
				// Simulate an unavailable browser callback.
			},
		},
	};

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, false);
});
