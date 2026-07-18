import type { PlaybackContentScope, PlaybackProgress, PlaybackSessionSnapshot } from '../shared/types';

export function createPlaybackSession(input: {
	sessionId: string;
	tabId: number;
	contentScope?: PlaybackContentScope;
	title: string;
	url: string;
	lang: string;
	voiceStyleId: string;
	speed: number;
	now: number;
}): PlaybackSessionSnapshot {
	return {
		sessionId: input.sessionId,
		tabId: input.tabId,
		contentScope: input.contentScope ?? 'article',
		title: input.title,
		url: input.url,
		lang: input.lang,
		status: 'loading',
		currentParagraphIndex: 0,
		totalParagraphs: 0,
		progressPercentage: 0,
		voiceStyleId: input.voiceStyleId,
		speed: input.speed,
		updatedAt: input.now,
	};
}

export function createPlaybackErrorSession(input: {
	sessionId: string;
	tabId: number;
	title: string;
	url: string;
	voiceStyleId: string;
	speed: number;
	error: string;
	now: number;
}): PlaybackSessionSnapshot {
	return {
		sessionId: input.sessionId,
		tabId: input.tabId,
		contentScope: 'article',
		title: input.title,
		url: input.url,
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

	return {
		sessionId: session.sessionId,
		tabId: session.tabId,
		contentScope: session.contentScope,
		title: session.title,
		url: session.url,
		lang: session.lang,
		status: progress.status,
		currentParagraphIndex: progress.currentParagraphIndex,
		totalParagraphs: progress.totalParagraphs,
		progressPercentage: progress.progressPercentage,
		voiceStyleId: session.voiceStyleId,
		speed: session.speed,
		error: progress.error,
		updatedAt: now,
	};
}

export function ownsTab(session: PlaybackSessionSnapshot | null, tabId: number): boolean {
	return session !== null && session.tabId === tabId;
}
