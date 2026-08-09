import type { PlaybackSessionSnapshot, PlaybackStatus } from './types';

/**
 * The one status every surface renders. A session stays `loading` until the offscreen document has
 * synthesized its first unit, so once playback has moved past the first paragraph the surface must
 * show `playing` — otherwise the popup, Side Panel and document reader disagree about the same
 * session depending on which of them derived it.
 */
export function resolvePlaybackStatus(session: PlaybackSessionSnapshot | null | undefined): PlaybackStatus {
	if (!session) {
		return 'stopped';
	}
	return session.status === 'loading' && session.currentParagraphIndex > 0 ? 'playing' : session.status;
}
