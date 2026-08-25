import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIsFileSchemeAccessAllowed } from '../../src/background/file_access.ts';

test('checkIsFileSchemeAccessAllowed handles callback pattern when file access is allowed', async () => {
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: {
			extension: {
				isAllowedFileSchemeAccess: (callback: (isAllowed: boolean) => void) => {
					callback(true);
				},
			},
		},
	});

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, true);
});

test('checkIsFileSchemeAccessAllowed handles callback pattern when file access is disallowed', async () => {
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: {
			extension: {
				isAllowedFileSchemeAccess: (callback: (isAllowed: boolean) => void) => {
					callback(false);
				},
			},
		},
	});

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, false);
});

test('checkIsFileSchemeAccessAllowed returns false when chrome API is unavailable', async () => {
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: {},
	});

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, false);
});

test('checkIsFileSchemeAccessAllowed fails closed when the callback times out', async () => {
	Object.defineProperty(globalThis, 'chrome', {
		configurable: true,
		writable: true,
		value: {
			extension: {
				isAllowedFileSchemeAccess: () => {
					// Simulate an unavailable browser callback.
				},
			},
		},
	});

	const result = await checkIsFileSchemeAccessAllowed();
	assert.equal(result, false);
});
