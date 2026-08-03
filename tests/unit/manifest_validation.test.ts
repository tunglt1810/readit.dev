import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFreeManifest } from '../../scripts/validate-free-manifest.mjs';

const validManifest = {
	manifest_version: 3,
	minimum_chrome_version: '127',
	permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'contextMenus', 'sidePanel'],
	side_panel: { default_path: 'src/sidepanel/sidepanel.html' },
	host_permissions: ['file://*/*', 'https://huggingface.co/*'],
	web_accessible_resources: [
		{
			resources: ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs'],
			matches: ['<all_urls>'],
		},
		{
			resources: ['assets/icon32.png'],
			matches: ['http://*/*', 'https://*/*'],
		},
	],
};

const validFirefoxManifest = {
	...validManifest,
	minimum_chrome_version: undefined,
	permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'downloads'],
	side_panel: undefined,
	sidebar_action: { default_panel: 'src/sidepanel/sidepanel.html' },
	host_permissions: ['https://huggingface.co/*'],
	browser_specific_settings: {
		gecko: {
			id: 'readit-dev@readit.dev',
			data_collection_permissions: { required: ['none'] },
		},
	},
};

test('accepts the exact Free extension permission boundary', () => {
	assert.doesNotThrow(() => validateFreeManifest(validManifest));
});

test('accepts the Firefox manifest boundary', () => {
	assert.doesNotThrow(() => validateFreeManifest(validFirefoxManifest, 'firefox'));
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

test('rejects a missing or remote Side Panel path', () => {
	assert.throws(() => validateFreeManifest({ ...validManifest, side_panel: undefined }), /side_panel/);
	assert.throws(
		() => validateFreeManifest({ ...validManifest, side_panel: { default_path: 'https://example.com/panel' } }),
		/src\/sidepanel\/sidepanel\.html/,
	);
});

test('rejects unexpected permissions and host access', () => {
	assert.throws(() => validateFreeManifest({ ...validManifest, permissions: [...validManifest.permissions, 'tabs'] }), /tabs/);
	assert.throws(() => validateFreeManifest({ ...validManifest, host_permissions: ['<all_urls>'] }), /<all_urls>/);
});

test('rejects a Chrome version below the supported popup API floor', () => {
	assert.throws(() => validateFreeManifest({ ...validManifest, minimum_chrome_version: '126' }), /127/);
});

test('rejects missing or broadly exposed selection button artwork', () => {
	assert.throws(
		() =>
			validateFreeManifest({
				...validManifest,
				web_accessible_resources: validManifest.web_accessible_resources.slice(0, 1),
			}),
		/assets\/icon32\.png/,
	);
	assert.throws(
		() =>
			validateFreeManifest({
				...validManifest,
				web_accessible_resources: [
					validManifest.web_accessible_resources[0],
					{ resources: ['assets/icon32.png'], matches: ['<all_urls>'] },
				],
			}),
		/http:\/\/\*\/\*/,
	);
});
