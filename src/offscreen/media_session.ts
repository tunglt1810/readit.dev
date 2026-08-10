import type { MediaSessionMetadata } from '../shared/media_session_metadata';
import type { PlaybackStatus } from '../shared/types';

const ALBUM = 'readit.dev';

/**
 * A reading session that is synthesising its next unit is still playing: `loading`
 * fires at every paragraph boundary, so mapping it to `none` makes the OS see the
 * session disappear and come back for the whole article.
 */
export function toMediaSessionPlaybackState(status: PlaybackStatus): MediaSessionPlaybackState {
	switch (status) {
		case 'playing':
		case 'loading':
			return 'playing';
		case 'paused':
			return 'paused';
		default:
			return 'none';
	}
}

/** The slice of `navigator.mediaSession` this module uses, so it can be faked in tests. */
export interface MediaSessionLike {
	metadata: unknown;
	playbackState: MediaSessionPlaybackState;
	setActionHandler(action: MediaSessionAction, handler: (() => void) | null): void;
	setPositionState?(state?: MediaPositionState): void;
}

export type MediaSessionPosition = {
	duration: number;
	position: number;
	playbackRate: number;
};

export type MediaSessionHandlers = {
	play: () => void;
	pause: () => void;
	stop: () => void;
};

export interface MediaSessionController {
	sync(status: PlaybackStatus): void;
	setMetadata(metadata: MediaSessionMetadata | undefined): void;
	clear(): void;
	install(handlers: MediaSessionHandlers): void;
	setNextTrack(handler: (() => void) | null): void;
	/**
	 * Without a duration the OS treats the session as an incidental sound rather than
	 * something worth a Now Playing entry. Pass null to reset.
	 */
	setPosition(position: MediaSessionPosition | null): void;
	/** Which actions Chrome accepted, and how often the tile was populated or cleared. */
	getDebugState(): {
		registered: string[];
		refused: Record<string, string>;
		metadataSetCount: number;
		metadataClearCount: number;
		lastMetadataClearAtMs: number | null;
		positionStateError: string | null;
		lastPosition: MediaSessionPosition | null;
	};
}

export function createMediaSessionController(
	session: MediaSessionLike,
	createMetadata: (init: { title: string; artist: string; album: string }) => unknown,
): MediaSessionController {
	const registered = new Set<string>();
	const refused: Record<string, string> = {};
	// A tile that vanishes mid-article leaves no trace in playbackState, so count the
	// writes that can remove it.
	let metadataSetCount = 0;
	let metadataClearCount = 0;
	let lastMetadataClearAtMs: number | null = null;
	let positionStateError: string | null = null;
	let lastPosition: MediaSessionPosition | null = null;

	// Chrome throws NotSupportedError for actions a given build does not handle;
	// one refusal must not cost the others. The outcome is recorded because a
	// swallowed refusal looks exactly like a working control that never fires.
	function register(action: MediaSessionAction, handler: (() => void) | null): void {
		try {
			session.setActionHandler(action, handler);
			delete refused[action];
			if (handler) {
				registered.add(action);
			} else {
				registered.delete(action);
			}
		} catch (error) {
			registered.delete(action);
			refused[action] = (error as Error).message || String(error);
		}
	}

	return {
		sync(status) {
			session.playbackState = toMediaSessionPlaybackState(status);
		},
		setMetadata(metadata) {
			if (metadata) {
				metadataSetCount++;
			} else {
				metadataClearCount++;
				lastMetadataClearAtMs = performance.now();
			}
			session.metadata = metadata ? createMetadata({ ...metadata, album: ALBUM }) : null;
		},
		clear() {
			metadataClearCount++;
			lastMetadataClearAtMs = performance.now();
			session.metadata = null;
		},
		install(handlers) {
			register('play', handlers.play);
			register('pause', handlers.pause);
			register('stop', handlers.stop);
		},
		setNextTrack(handler) {
			// Passing null explicitly: the OS keeps the next button until it is cleared.
			register('nexttrack', handler);
		},
		setPosition(position) {
			if (typeof session.setPositionState !== 'function') {
				return;
			}
			try {
				if (!position) {
					session.setPositionState();
					lastPosition = null;
					return;
				}
				if (!(position.duration > 0)) {
					return;
				}
				// The duration is estimated over units that have not been synthesised yet, so
				// real playback can overrun it. setPositionState throws on position > duration.
				const clamped: MediaSessionPosition = {
					duration: position.duration,
					position: Math.max(0, Math.min(position.position, position.duration)),
					playbackRate: position.playbackRate,
				};
				session.setPositionState(clamped);
				lastPosition = clamped;
				positionStateError = null;
			} catch (error) {
				positionStateError = (error as Error).message || String(error);
			}
		},
		getDebugState() {
			return {
				registered: [...registered],
				refused: { ...refused },
				metadataSetCount,
				metadataClearCount,
				lastMetadataClearAtMs,
				positionStateError,
				lastPosition,
			};
		},
	};
}
