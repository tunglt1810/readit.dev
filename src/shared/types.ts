export interface PlaybackContent {
	content: string;
	lang: string;
}

export type ThemeName = 'default' | 'winamp' | 'wmp12';

export interface Article extends PlaybackContent {
	title: string;
	url: string;
}

export type ReadableSurfaceKind = 'website-dom' | 'manual-reader' | 'document-reader' | 'none';

export interface ExtractedArticle {
	article: Article;
	readableSurface: Extract<ReadableSurfaceKind, 'website-dom' | 'document-reader' | 'none'>;
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

export type AudioExportJobState =
	| 'preparing'
	| 'exporting'
	| 'waiting-for-playback'
	| 'cancelling'
	| 'completed'
	| 'failed'
	| 'interrupted';

export type AudioExportErrorCode =
	| 'permission-denied'
	| 'write-failed'
	| 'encoding-failed'
	| 'snapshot-unavailable'
	| 'interrupted';

export interface AudioExportEstimate {
	durationSeconds: number;
	estimatedBytes: number;
}

export interface AudioExportJobSnapshot {
	jobId: string;
	playbackSessionId: string;
	title: string;
	outputFilename: string;
	state: AudioExportJobState;
	estimate: AudioExportEstimate;
	processedDurationSeconds: number;
	progressPercentage: number;
	bytesWritten: number;
	etaSeconds?: number;
	startedAt: number;
	updatedAt: number;
	errorCode?: AudioExportErrorCode;
}

export interface PlaybackSessionBase {
	sessionId: string;
	readableSurface: ReadableSurfaceKind;
	lang: string;
	status: PlaybackStatus;
	currentParagraphIndex: number;
	totalParagraphs: number;
	progressPercentage: number;
	voiceStyleId: string;
	speed: number;
	audioExportEstimate?: AudioExportEstimate;
	error?: string;
	updatedAt: number;
}

interface TabPlaybackSessionBase extends PlaybackSessionBase {
	source: { kind: 'tab'; tabId: number; title: string; url: string };
}

export type TabPlaybackSessionSnapshot =
	| (TabPlaybackSessionBase & {
			contentScope: 'article';
			readableSurface: 'website-dom' | 'document-reader' | 'none';
	  })
	| (TabPlaybackSessionBase & {
			contentScope: 'selection';
			readableSurface: 'website-dom' | 'none';
	  });

export interface ManualPlaybackSessionSnapshot extends PlaybackSessionBase {
	contentScope: 'manual';
	readableSurface: 'manual-reader';
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

export interface AudioExportStateResponse {
	job: AudioExportJobSnapshot | null;
}
