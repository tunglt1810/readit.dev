import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFreeManifest } from '../../scripts/validate-free-manifest.mjs';

const validManifest = {
	manifest_version: 3,
	permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'contextMenus'],
	host_permissions: ['https://huggingface.co/*'],
};

test('accepts the exact Free extension permission boundary', () => {
	assert.doesNotThrow(() => validateFreeManifest(validManifest));
});

test('rejects a missing contextMenus permission', () => {
	assert.throws(
		() =>
			validateFreeManifest({
				...validManifest,
				permissions: validManifest.permissions.filter((value) => value !== 'contextMenus'),
			}),
		/contextMenus/,
	);
});

test('rejects unexpected permissions and host access', () => {
	assert.throws(() => validateFreeManifest({ ...validManifest, permissions: [...validManifest.permissions, 'tabs'] }), /tabs/);
	assert.throws(() => validateFreeManifest({ ...validManifest, host_permissions: ['<all_urls>'] }), /<all_urls>/);
});
