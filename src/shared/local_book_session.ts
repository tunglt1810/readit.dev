import type { PlaybackSessionSnapshot } from './types.ts';

/**
 * A locally opened book has no navigable source: the Reader tab is both loader and
 * surface, so its session carries the picked file name in place of a URL.
 */
export function isLocalBookSession(session: PlaybackSessionSnapshot | null): boolean {
	if (!session || session.readableSurface !== 'document-reader' || session.source.kind !== 'tab') {
		return false;
	}
	try {
		new URL(session.source.url);
		return false;
	} catch {
		return true;
	}
}
