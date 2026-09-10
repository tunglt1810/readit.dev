/**
 * The reader's explicit language choice, or undefined when they left it on automatic.
 *
 * `auto` collapses to undefined rather than travelling as a value: everything downstream reads a
 * language code, and a sentinel that only the UI understands would have to be unwrapped again in
 * `startPlayback`, where getting it wrong means speaking a real article in a made-up language.
 */
export function parseLanguageOverride(payload: unknown): string | undefined {
	const value = (payload as { languageOverride?: unknown } | undefined)?.languageOverride;
	if (typeof value !== 'string') {
		return undefined;
	}
	const normalized = value.trim().replaceAll('_', '-').toLowerCase();
	return normalized && normalized !== 'auto' ? normalized : undefined;
}
