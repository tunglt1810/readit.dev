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
		| { contentScope: 'article' | 'selection'; source: { kind: 'tab'; tabId: number; title: string; url: string } }
		| { contentScope: 'manual'; source: { kind: 'manual'; panelInstanceId: string } }
	);

const MANUAL_PLAYBACK_SESSION_KEYS = new Set([
	'sessionId',
	'contentScope',
	'source',
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
	return input.contentScope === 'manual'
		? { ...base, contentScope: 'manual', source: input.source }
		: { ...base, contentScope: input.contentScope, source: input.source };
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
			isPanelInstanceId(source.panelInstanceId) &&
			Object.keys(source).length === 2 &&
			Object.keys(session).every((key) => MANUAL_PLAYBACK_SESSION_KEYS.has(key))
		);
	}
	return (
		source.kind === 'tab' &&
		(session.contentScope === 'article' || session.contentScope === 'selection') &&
		Number.isInteger(source.tabId) &&
		typeof source.title === 'string' &&
		typeof source.url === 'string'
	);
}

export function ownsTab(session: PlaybackSessionSnapshot | null, tabId: number): boolean {
	return session?.source.kind === 'tab' && session.source.tabId === tabId;
}
