/**
 * Cross-browser storage wrapper.
 *
 * Uses `chrome.storage.local` directly with its callback form, promisified by hand,
 * instead of `webextension-polyfill`: in the Chrome offscreen document, the polyfill's
 * `browser` ends up without a `.storage` namespace (Chrome now exposes a partial native
 * `browser` global that the polyfill detects and defers to instead of doing its own
 * wrapping, and that native object is missing `storage`). The callback form of
 * `chrome.storage.local` is supported the same way on both Chrome and Firefox, so
 * wrapping it in a Promise here keeps callers cross-browser without depending on the
 * polyfill for this API.
 */
export const browserStorage = {
	get: (keys: string | string[]): Promise<Record<string, unknown>> =>
		new Promise((resolve) => chrome.storage.local.get(keys, (items: Record<string, unknown>) => resolve(items))),
	set: (items: Record<string, unknown>): Promise<void> => new Promise((resolve) => chrome.storage.local.set(items, () => resolve())),
};
