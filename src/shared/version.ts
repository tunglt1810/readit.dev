/**
 * Returns the synchronized display version string (e.g. "1.1.1-dev.4" or "1.1.1").
 * Prefers `version_name` from manifest if present (set during build-dev), otherwise falls back to `version`.
 */
export function getDisplayVersion(): string {
	try {
		if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
			const manifest = chrome.runtime.getManifest();
			return manifest.version_name ?? manifest.version ?? '1.1.0';
		}
	} catch (_e) {
		// Ignore environments without extension runtime
	}
	return '1.1.0';
}
