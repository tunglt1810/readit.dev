export interface Article {
	title: string;
	content: string;
	url: string;
	lang: string;
}

export interface VoiceStyle {
	id: string;
	name: string;
	path: string;
	gender: 'male' | 'female';
}

export type PlaybackStatus = 'stopped' | 'loading' | 'playing' | 'paused' | 'error';

export interface PlaybackProgress {
	status: PlaybackStatus;
	currentParagraphIndex: number;
	totalParagraphs: number;
	progressPercentage: number;
	duration?: number;
	currentTime?: number;
	error?: string;
}

export interface PlaybackSessionSnapshot {
	sessionId: string;
	tabId: number;
	title: string;
	url: string;
	lang: string;
	status: PlaybackStatus;
	currentParagraphIndex: number;
	totalParagraphs: number;
	progressPercentage: number;
	voiceStyleId: string;
	speed: number;
	error?: string;
	updatedAt: number;
}

export interface PlaybackProgressUpdateMessage {
	action: 'PLAYBACK_PROGRESS_UPDATE';
	sessionId: string;
	progress: PlaybackProgress;
}

export interface PlaybackStateResponse {
	session: PlaybackSessionSnapshot | null;
	currentTabId?: number;
}
