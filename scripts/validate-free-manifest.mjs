import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PERMISSIONS = ['activeTab', 'contextMenus', 'offscreen', 'scripting', 'storage'];
const REQUIRED_HOST_PERMISSIONS = ['https://huggingface.co/*'];

function compareExact(actual, expected, label) {
	const actualValues = Array.isArray(actual) ? actual.map(String).sort() : [];
	const expectedValues = [...expected].sort();
	const missing = expectedValues.filter((value) => !actualValues.includes(value));
	const unexpected = actualValues.filter((value) => !expectedValues.includes(value));
	if (missing.length || unexpected.length) {
		throw new Error(`${label} mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
	}
}

export function validateFreeManifest(manifest) {
	if (!manifest || typeof manifest !== 'object') {
		throw new Error('Manifest must be an object');
	}
	if (manifest.manifest_version !== 3) {
		throw new Error(`Expected manifest_version 3, got ${String(manifest.manifest_version)}`);
	}
	compareExact(manifest.permissions, REQUIRED_PERMISSIONS, 'permissions');
	compareExact(manifest.host_permissions, REQUIRED_HOST_PERMISSIONS, 'host_permissions');
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (scriptPath && fileURLToPath(import.meta.url) === scriptPath) {
	const manifestPath = process.argv[2];
	if (!manifestPath) {
		throw new Error('Usage: node scripts/validate-free-manifest.mjs <manifest-path>');
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	validateFreeManifest(manifest);
	console.log(`Validated Free manifest: ${manifestPath}`);
}
