import type { PlaybackContentScope } from './types';

const FALLBACK = 'readit.dev';

export type MediaSessionMetadata = {
	title: string;
	artist: string;
};

export type MediaSessionMetadataLabels = {
	selection: string;
	manual: string;
};

export type MediaSessionMetadataInput = {
	contentScope: PlaybackContentScope;
	title?: string;
	url?: string;
};

function hostnameOf(url: string | undefined): string {
	if (!url) {
		return FALLBACK;
	}
	try {
		return new URL(url).hostname || FALLBACK;
	} catch {
		return FALLBACK;
	}
}

/**
 * Metadata is shown by the OS, which can mean a lock screen. Selection and manual
 * reading therefore get a fixed label: their "title" would be the user's own text.
 */
export function buildMediaSessionMetadata(input: MediaSessionMetadataInput, labels: MediaSessionMetadataLabels): MediaSessionMetadata {
	if (input.contentScope === 'manual') {
		return { title: labels.manual, artist: FALLBACK };
	}
	if (input.contentScope === 'selection') {
		return { title: labels.selection, artist: hostnameOf(input.url) };
	}
	return { title: input.title?.trim() || FALLBACK, artist: hostnameOf(input.url) };
}
