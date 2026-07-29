import { isPanelInstanceId } from '../shared/manual_playback.ts';
import type { PlaybackProgress, PlaybackSessionSnapshot, PlaybackStatus } from '../shared/types';

type PlaybackSessionInputBase = {
	sessionId: string;
	lang: string;
	voiceStyleId: string;
	speed: number;
	now: number;
};

type CreatePlaybackSessionInput = PlaybackSessionInputBase &
	(
		| {
				contentScope: 'article';
				source: { kind: 'tab'; tabId: number; title: string; url: string };
				readableSurface: 'website-dom' | 'document-reader' | 'none';
		  }
		| {
				contentScope: 'selection';
				source: { kind: 'tab'; tabId: number; title: string; url: string };
				readableSurface: 'website-dom' | 'none';
		  }
		| {
				contentScope: 'manual';
				source: { kind: 'manual'; panelInstanceId: string };
				readableSurface: 'manual-reader';
		  }
	);

const MANUAL_PLAYBACK_SESSION_KEYS = new Set([
	'sessionId',
	'contentScope',
	'source',
	'readableSurface',
	'lang',
	'status',
	'currentParagraphIndex',
	'totalParagraphs',
	'progressPercentage',
	'voiceStyleId',
	'speed',
	'error',
	'updatedAt',
]);

export function createPlaybackSession(input: CreatePlaybackSessionInput): PlaybackSessionSnapshot {
	const base = {
		sessionId: input.sessionId,
		lang: input.lang,
		status: 'loading' as const,
		currentParagraphIndex: 0,
		totalParagraphs: 0,
		progressPercentage: 0,
		voiceStyleId: input.voiceStyleId,
		speed: input.speed,
		updatedAt: input.now,
	};
	if (input.contentScope === 'manual') {
		return { ...base, contentScope: 'manual', source: input.source, readableSurface: input.readableSurface };
	}
	if (input.contentScope === 'article') {
		return { ...base, contentScope: 'article', source: input.source, readableSurface: input.readableSurface };
	}
	return { ...base, contentScope: 'selection', source: input.source, readableSurface: input.readableSurface };
}

export function createPlaybackErrorSession(input: {
	sessionId: string;
	source: { kind: 'tab'; tabId: number; title: string; url: string };
	voiceStyleId: string;
	speed: number;
	error: string;
	now: number;
}): PlaybackSessionSnapshot {
	return {
		sessionId: input.sessionId,
		contentScope: 'article',
		source: input.source,
		readableSurface: 'none',
		lang: 'und',
		status: 'error',
		currentParagraphIndex: 0,
		totalParagraphs: 0,
		progressPercentage: 0,
		voiceStyleId: input.voiceStyleId,
		speed: input.speed,
		error: input.error,
		updatedAt: input.now,
	};
}

export function applyPlaybackProgress(
	session: PlaybackSessionSnapshot | null,
	sessionId: string,
	progress: PlaybackProgress,
	now: number,
): PlaybackSessionSnapshot | null {
	if (session === null) {
		return null;
	}

	if (session.sessionId !== sessionId) {
		return null;
	}

	return { ...session, ...progress, updatedAt: now };
}

function isPlaybackStatus(value: unknown): value is PlaybackStatus {
	return value === 'stopped' || value === 'loading' || value === 'playing' || value === 'paused' || value === 'error';
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function isPlaybackSessionSnapshot(value: unknown): value is PlaybackSessionSnapshot {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const session = value as Record<string, unknown>;
	const source = session.source as Record<string, unknown> | undefined;
	const baseIsValid =
		typeof session.sessionId === 'string' &&
		typeof session.lang === 'string' &&
		isPlaybackStatus(session.status) &&
		isFiniteNumber(session.currentParagraphIndex) &&
		isFiniteNumber(session.totalParagraphs) &&
		isFiniteNumber(session.progressPercentage) &&
		typeof session.voiceStyleId === 'string' &&
		isFiniteNumber(session.speed) &&
		(session.error === undefined || typeof session.error === 'string') &&
		isFiniteNumber(session.updatedAt);
	if (!baseIsValid || !source) {
		return false;
	}
	if (source.kind === 'manual') {
		return (
			session.contentScope === 'manual' &&
			session.readableSurface === 'manual-reader' &&
			isPanelInstanceId(source.panelInstanceId) &&
			Object.keys(source).length === 2 &&
			Object.keys(session).every((key) => MANUAL_PLAYBACK_SESSION_KEYS.has(key))
		);
	}
	const validTabSurface =
		session.contentScope === 'article'
			? session.readableSurface === 'website-dom' ||
				session.readableSurface === 'document-reader' ||
				session.readableSurface === 'none'
			: session.contentScope === 'selection' && (session.readableSurface === 'website-dom' || session.readableSurface === 'none');
	return (
		source.kind === 'tab' &&
		validTabSurface &&
		Number.isInteger(source.tabId) &&
		typeof source.title === 'string' &&
		typeof source.url === 'string'
	);
}

export function ownsTab(session: PlaybackSessionSnapshot | null, tabId: number): boolean {
	return session?.source.kind === 'tab' && session.source.tabId === tabId;
}

/**
 * Whether two URLs address the same document, i.e. differ at most by their fragment.
 *
 * `chrome.tabs.onUpdated` reports a fragment change, a `pushState`, a reload and a real navigation
 * as the same `status: "loading"` update, with no `url` field to tell them apart. Google Docs
 * rewrites its own `#heading=…` every time the caret moves, so treating every such update as a
 * navigation stopped playback on each click into the document.
 */
export function isSameDocumentUrl(left: string, right: string): boolean {
	if (left === right) {
		return true;
	}
	try {
		const from = new URL(left);
		const to = new URL(right);
		from.hash = '';
		to.hash = '';
		return from.href === to.href;
	} catch {
		return false;
	}
}
