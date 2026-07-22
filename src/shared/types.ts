export interface PlaybackContent {
	content: string;
	lang: string;
}

export type ThemeName = 'default' | 'winamp' | 'wmp12';

export interface Article extends PlaybackContent {
	title: string;
	url: string;
}

export type ManualTextLanguage = 'auto' | 'en' | 'vi' | 'zh';
export type ResolvedManualTextLanguage = Exclude<ManualTextLanguage, 'auto'>;

export type PageInfoResponse = { available: true; title: string; url: string; lang: string } | { available: false };

export interface StartManualTextMessage {
	action: 'START_MANUAL_TEXT';
	payload: {
		text: string;
		language: ManualTextLanguage;
		panelInstanceId: string;
	};
}

export interface CommandResponse {
	success: boolean;
	error?: string;
	transportError?: true;
}

export interface VoiceStyle {
	id: string;
	name: string;
	path: string;
	gender: 'male' | 'female';
}

export type PlaybackStatus = 'stopped' | 'loading' | 'playing' | 'paused' | 'error';
export type PlaybackContentScope = 'article' | 'selection' | 'manual';

export interface PlaybackProgress {
	status: PlaybackStatus;
	currentParagraphIndex: number;
	totalParagraphs: number;
	progressPercentage: number;
	duration?: number;
	currentTime?: number;
	error?: string;
}

export interface PlaybackSessionBase {
	sessionId: string;
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

export interface TabPlaybackSessionSnapshot extends PlaybackSessionBase {
	contentScope: 'article' | 'selection';
	source: { kind: 'tab'; tabId: number; title: string; url: string };
}

export interface ManualPlaybackSessionSnapshot extends PlaybackSessionBase {
	contentScope: 'manual';
	source: { kind: 'manual'; panelInstanceId: string };
}

export type PlaybackSessionSnapshot = TabPlaybackSessionSnapshot | ManualPlaybackSessionSnapshot;

export interface PlaybackProgressUpdateMessage {
	action: 'PLAYBACK_PROGRESS_UPDATE';
	sessionId: string;
	progress: PlaybackProgress;
}

export interface PlaybackStateResponse {
	session: PlaybackSessionSnapshot | null;
	currentTabId?: number;
}
