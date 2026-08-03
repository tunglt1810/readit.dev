import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_PERMISSIONS = ['activeTab', 'contextMenus', 'offscreen', 'scripting', 'sidePanel', 'storage'];
const FIREFOX_PERMISSIONS = ['activeTab', 'contextMenus', 'downloads', 'scripting', 'storage'];
const CHROME_HOST_PERMISSIONS = ['file://*/*', 'https://huggingface.co/*'];
const FIREFOX_HOST_PERMISSIONS = ['https://huggingface.co/*'];
const REQUIRED_MINIMUM_CHROME_VERSION = '127';
const REQUIRED_SIDE_PANEL_PATH = 'src/sidepanel/sidepanel.html';
const REQUIRED_WEB_ACCESSIBLE_RESOURCES = [
	{
		resources: ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'],
		matches: ['<all_urls>'],
	},
	{
		resources: ['assets/icon32.png'],
		matches: ['http://*/*', 'https://*/*'],
	},
];

function compareExact(actual, expected, label) {
	const actualValues = Array.isArray(actual) ? actual.map(String).sort() : [];
	const expectedValues = [...expected].sort();
	const missing = expectedValues.filter((value) => !actualValues.includes(value));
	const unexpected = actualValues.filter((value) => !expectedValues.includes(value));
	if (missing.length || unexpected.length) {
		throw new Error(`${label} mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
	}
}

function canonicalizeResourceEntries(value) {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry) => ({
			resources: Array.isArray(entry?.resources) ? entry.resources.map(String).sort() : [],
			matches: Array.isArray(entry?.matches) ? entry.matches.map(String).sort() : [],
		}))
		.map((entry) => JSON.stringify(entry))
		.sort();
}

function compareResourceEntries(actual, expected) {
	compareExact(canonicalizeResourceEntries(actual), canonicalizeResourceEntries(expected), 'web_accessible_resources');
}

export function validateFreeManifest(manifest, target = 'chrome') {
	if (!manifest || typeof manifest !== 'object') {
		throw new Error('Manifest must be an object');
	}
	if (manifest.manifest_version !== 3) {
		throw new Error(`Expected manifest_version 3, got ${String(manifest.manifest_version)}`);
	}
	if (target === 'firefox') {
		if (manifest.minimum_chrome_version) {
			throw new Error('Firefox manifest should not include minimum_chrome_version');
		}
		if (manifest.side_panel) {
			throw new Error('Firefox manifest should not include side_panel key');
		}
		if (!manifest.sidebar_action?.default_panel) {
			throw new Error('Expected sidebar_action.default_panel in Firefox manifest');
		}
		if (!manifest.browser_specific_settings?.gecko?.id) {
			throw new Error('Expected browser_specific_settings.gecko.id in Firefox manifest');
		}
		compareExact(manifest.permissions, FIREFOX_PERMISSIONS, 'permissions');
		compareExact(manifest.host_permissions, FIREFOX_HOST_PERMISSIONS, 'host_permissions');
	} else {
		if (manifest.minimum_chrome_version !== REQUIRED_MINIMUM_CHROME_VERSION) {
			throw new Error(`Expected minimum_chrome_version 127, got ${String(manifest.minimum_chrome_version)}`);
		}
		if (manifest.side_panel?.default_path !== REQUIRED_SIDE_PANEL_PATH) {
			throw new Error(`Expected side_panel.default_path ${REQUIRED_SIDE_PANEL_PATH}`);
		}
		compareExact(manifest.permissions, CHROME_PERMISSIONS, 'permissions');
		compareExact(manifest.host_permissions, CHROME_HOST_PERMISSIONS, 'host_permissions');
	}
	compareResourceEntries(manifest.web_accessible_resources, REQUIRED_WEB_ACCESSIBLE_RESOURCES);
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (scriptPath && fileURLToPath(import.meta.url) === scriptPath) {
	const manifestPath = process.argv[2];
	if (!manifestPath) {
		throw new Error('Usage: node scripts/validate-free-manifest.mjs <manifest-path> [--target chrome|firefox]');
	}
	const targetIndex = process.argv.indexOf('--target');
	const target = targetIndex !== -1 && process.argv[targetIndex + 1] ? process.argv[targetIndex + 1] : 'chrome';
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	validateFreeManifest(manifest, target);
}
