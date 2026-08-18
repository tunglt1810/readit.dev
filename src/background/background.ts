import {
	DEFAULT_SPEED,
	isLegacySpeedPreference,
	resolveStoredPlaybackSpeed,
	GOOGLE_DOCS_EXPORT_UNAVAILABLE,
	MODEL_FILES,
	PDF_ERROR_CODES,
	STORAGE_KEYS,
	TRANSLATION_FAILED,
	WORD_ONLINE_DOWNLOAD_UNAVAILABLE,
	type PdfErrorCode,
} from '../shared/constants';
import { createChromeTranslationDependencies, type TranslatedArticleText, translateArticleText } from './translate_article.ts';
import { readTranslationTarget } from '../shared/translation_target_store.ts';
import { base64ToBytes } from '../shared/base64.ts';
import { t } from '../shared/i18n.ts';
import { buildMediaSessionMetadata } from '../shared/media_session_metadata.ts';
import { isInternalAudioExportOffscreenCommand } from '../shared/audio_export.ts';
import { deleteAudioExportHandle } from '../shared/audio_export_handle_store.ts';
import { DOCUMENT_READER_PORT_NAME } from '../shared/document_reader.ts';
import { isManualPlaybackControlMessage } from '../shared/manual_playback';
import { fetchWithCache, MODEL_CACHE_NAME } from '../shared/model_cache';
import { isReadableSurfaceClearMessage, isReadableSurfaceInitMessage, isReadableSurfaceUpdateMessage } from '../shared/readable_surface';
import { warmCache } from '../shared/warm_cache';
import { createModelCacheWarmer } from './model_cache_warmer';
import { registerModelCacheWarmLifecycle } from './model_cache_lifecycle';
import { createAudioExportCoordinator, isAudioExportPrepareRequest } from './audio_export.ts';
import { AudioExportPreparationDiagnostics } from './audio_export_prepare_diagnostics.ts';
import { isAudioExportProgressUpdate } from './audio_export_state.ts';
import { createCommandLane } from './command_queue.ts';
import { createSingleFlight } from '../shared/single_flight.ts';
import type {
	Article,
	CommandResponse,
	ManualPlaybackSessionSnapshot,
	PageInfoResponse,
	PlaybackContent,
	PlaybackProgress,
	PlaybackSessionSnapshot,
	PlaybackStatus,
	TranslationInfo,
} from '../shared/types';
import { requestActionPopup } from './action_popup';
import { isMissingReceiverError, requestArticleFromTab, type ResolvedArticleResponse } from './article_request';
import { buildWordOnlineArticle } from './word_online_article.ts';
import { syncPlaybackBadge } from './badge';
import { prepareManualStart } from './manual_text';
import {
	type ManualCheckpointMetadata,
	type OffscreenCommand,
	type OffscreenCommandResponse,
	type OffscreenPlayPayload,
	sendOffscreenCommand,
} from './offscreen_transport';
import { requestPageInfoFromTab } from './page_info';
import { extractPdfArticle, isSupportedPdfSource } from './pdf_extractor';
import { loadPdfJsDocument } from './pdfjs_loader';
import {
	applyPlaybackProgress,
	applyAudioExportEstimate,
	createPlaybackErrorSession,
	createPlaybackSession,
	isPlaybackSessionSnapshot,
	isSameDocumentUrl,
	ownsTab,
} from './playback_state';
import { createSelectedTextArticle } from './selected_text';
import { prepareSelectedTextRequest } from './selected_text_request';
import { parseReaderContentRequest } from './reader_content_request';
import { createReadableSurfaceCoordinator } from './readable_surface';
import { computeOpenSidePanelWindowIds, handleOpenSidePanelCommand } from '../popup/side_panel';
import {
	addToQueue,
	clearQueue,
	createPlaylistQueue,
	getNextPending,
	getPlayingItem,
	loadQueue,
	markDone,
	markError,
	markPlaying,
	normalizeQueueUrl,
	removeItem,
	requeueAllItems,
	requeueItem,
	saveQueue,
} from './playlist_queue.ts';
import { setupContextMenus } from './context_menu.ts';
import { checkIsFileSchemeAccessAllowed } from './file_access.ts';
import {
	createPendingQueueNavigation,
	isPendingQueueNavigation,
	matchesPendingQueueNavigation,
	selectNavigationTab,
} from './queue_navigation.ts';
import type { PendingQueueNavigation, PlaylistQueue, PronunciationRule, QueueItem } from '../shared/types.ts';

const DEFAULT_VOICE_STYLE_ID = 'M1';

const ERROR_MESSAGES = {
	activeTab: 'Không tìm thấy trang web đang hoạt động.',
	restrictedPage: 'Tiện ích không thể chạy trên trang này. Vui lòng sử dụng trên một trang web bài viết khác.',
	extraction: 'Không thể trích xuất nội dung từ trang web này. Vui lòng tải lại trang và thử lại.',
	noSession: 'Không có phiên đọc đang hoạt động.',
	setup: 'Không thể bắt đầu đọc trang này. Vui lòng thử lại.',
	startupTimeout: 'Khởi tạo phát âm thanh quá lâu. Vui lòng thử lại.',
	invalidSpeed: 'Tốc độ đọc không hợp lệ.',
	translationFailed: TRANSLATION_FAILED,
} as const;

function getExtractionError(error: string | undefined): string {
	if (error === GOOGLE_DOCS_EXPORT_UNAVAILABLE) return error;
	if (error === WORD_ONLINE_DOWNLOAD_UNAVAILABLE) return error;
	if (error && Object.values(PDF_ERROR_CODES).includes(error as PdfErrorCode)) return error;
	return ERROR_MESSAGES.extraction;
}

type StartPlaybackInput =
	| {
			contentScope: 'article';
			source: { kind: 'tab'; tabId: number; title: string; url: string };
			content: PlaybackContent;
			readableSurface: 'website-dom' | 'document-reader' | 'none';
			queueItemId?: string;
			/** Translate before speaking. Only the article scope offers it today. */
			translate?: boolean;
	  }
	| {
			contentScope: 'selection';
			source: { kind: 'tab'; tabId: number; title: string; url: string };
			content: PlaybackContent;
			readableSurface: 'website-dom' | 'none';
	  }
	| {
			contentScope: 'manual';
			source: { kind: 'manual'; panelInstanceId: string };
			content: PlaybackContent;
			readableSurface: 'manual-reader';
	  };

let activeSession: PlaybackSessionSnapshot | null = null;
let suspendedManualCheckpoint: ManualCheckpointMetadata | null = null;
let suspendedManualSession: ManualPlaybackSessionSnapshot | null = null;
let hydrated = false;
let pendingStart: Promise<void> | null = null;
const STARTUP_TIMEOUT_MS = 60_000;
let playlistQueue: PlaylistQueue = createPlaylistQueue();
let pendingQueueNavigation: PendingQueueNavigation | null = null;
/**
 * Every playback input — article, selected text, manual text, PDF, playlist — shares this one lane,
 * so session transitions stay mutually exclusive no matter which surface started them.
 */
const sessionLane = createCommandLane();
const { enqueue, runQueuedEvent } = sessionLane;

// Word-highlight relays deliberately share this lane. They look like independent per-tab UI traffic,
// but `deliverWebsiteUpdate` drops any update arriving before `READABLE_SURFACE_INIT` has set
// `websiteReady`, and that init runs as a session-lane operation. Relaying on a separate lane lets a
// relay overtake the init and silently lose the highlight.

const readableSurface = createReadableSurfaceCoordinator({
	sendTabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
	sendRuntimeMessage: (message) => chrome.runtime.sendMessage(message),
	requestDocumentReaderSnapshot: async (sessionId) => {
		const response = await sendOffscreenCommand(
			{ action: 'GET_DOCUMENT_READER_SNAPSHOT', payload: { sessionId } },
			sendAudioHostCommand,
		);
		const snapshot = response.success ? (response.snapshot ?? null) : null;
		if (!snapshot || !activeTranslation) {
			return snapshot;
		}
		// The offscreen document owns the snapshot but knows nothing about translation, so the
		// original text and the pair are attached here rather than threaded through playback.
		return { ...snapshot, originalContent: activeTranslation.originalContent, translation: activeTranslation.translation };
	},
	detachDocumentReader: async (sessionId) => {
		await sendOffscreenCommand(
			{ action: 'DETACH_DOCUMENT_READER', payload: { sessionId } },
			sendAudioHostCommand,
		);
	},
	enqueue: (operation) => {
		runQueuedEvent(operation);
	},
});

function isPlaybackStatus(value: unknown): value is PlaybackStatus {
	return value === 'stopped' || value === 'loading' || value === 'playing' || value === 'paused' || value === 'error';
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isPlaybackProgress(value: unknown): value is PlaybackProgress {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const progress = value as Record<string, unknown>;
	return (
		isPlaybackStatus(progress.status) &&
		isFiniteNumber(progress.currentParagraphIndex) &&
		isFiniteNumber(progress.totalParagraphs) &&
		isFiniteNumber(progress.progressPercentage) &&
		(progress.duration === undefined || isFiniteNumber(progress.duration)) &&
		(progress.currentTime === undefined || isFiniteNumber(progress.currentTime)) &&
		(progress.error === undefined || typeof progress.error === 'string')
	);
}

function isArticle(value: unknown): value is Article {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const article = value as Record<string, unknown>;
	return (
		typeof article.title === 'string' &&
		typeof article.content === 'string' &&
		typeof article.url === 'string' &&
		typeof article.lang === 'string'
	);
}

function isArticleReadableSurface(value: unknown): value is 'website-dom' | 'document-reader' | 'none' {
	return value === 'website-dom' || value === 'document-reader' || value === 'none';
}

function getQueueItemId(session: PlaybackSessionSnapshot | null): string | undefined {
	if (!session || session.source.kind !== 'tab') {
		return undefined;
	}
	return 'queueItemId' in session && typeof session.queueItemId === 'string' ? session.queueItemId : undefined;
}

async function requestCurrentTabArticle(tabId: number, title: string | undefined, url: string): Promise<ResolvedArticleResponse> {
	const requestPdfFallback = () =>
		extractPdfArticle(
			{ url, title: title || url },
			{
				fetchPdf: (sourceUrl, init) => globalThis.fetch(sourceUrl, init),
				isFileSchemeAccessAllowed: checkIsFileSchemeAccessAllowed,
				loadDocument: loadPdfJsDocument,
				fetchFileBytesViaOffscreen: async (fileUrl) => {
					await setupOffscreen();
					const response = (await dispatchOffscreenCommand({
						action: 'FETCH_FILE_BYTES',
						payload: { url: fileUrl },
					})) as { success: boolean; base64?: string; error?: string };
					if (response?.success && typeof response.base64 === 'string' && response.base64.length > 0) {
						return base64ToBytes(response.base64);
					}
					return null;
				},
			},
		);

	try {
		const articleResponse = await requestArticleFromTab(tabId, {
			sendMessage: (targetTabId, message) => chrome.tabs.sendMessage(targetTabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
		// A recognized Word Online page is a final answer either way. Falling through would send the
		// OneDrive page URL into the PDF fallback, which cannot succeed and only costs a request.
		if ('docxBase64' in articleResponse) {
			return await buildWordOnlineArticle(articleResponse.docxBase64, articleResponse.source);
		}
		if (
			articleResponse.success &&
			isArticle(articleResponse.article) &&
			isArticleReadableSurface(articleResponse.readableSurface)
		) {
			return articleResponse;
		}
		return (await requestPdfFallback()) ?? articleResponse;
	} catch (error) {
		if (!isMissingReceiverError(error)) throw error;
		const pdfResponse = await requestPdfFallback();
		if (pdfResponse !== null) return pdfResponse;
		throw error;
	}
}

async function ensureHydrated(): Promise<void> {
	if (hydrated) {
		return;
	}

	const result = (await chrome.storage.session.get([
		STORAGE_KEYS.PLAYBACK_SESSION,
		STORAGE_KEYS.PENDING_QUEUE_NAVIGATION,
	])) as Record<string, unknown>;
	const storedSession = result[STORAGE_KEYS.PLAYBACK_SESSION];
	const storedPendingNavigation = result[STORAGE_KEYS.PENDING_QUEUE_NAVIGATION];
	activeSession = isPlaybackSessionSnapshot(storedSession) ? storedSession : null;
	pendingQueueNavigation = isPendingQueueNavigation(storedPendingNavigation) ? storedPendingNavigation : null;
	if (activeSession) {
		// Restored, not started: this worker is replacing an evicted one, and the page it
		// was projecting into is still there.
		readableSurface.restore(activeSession);
	}
	playlistQueue = await loadQueue();
	let queueChanged = false;
	const activeQueueItemId = getQueueItemId(activeSession);
	const retainedPlayingItemIds = new Set(
		[pendingQueueNavigation?.itemId, activeQueueItemId].filter((itemId): itemId is string => typeof itemId === 'string'),
	);

	if (pendingQueueNavigation) {
		const pendingItem = playlistQueue.items.find((item) => item.id === pendingQueueNavigation?.itemId);
		if (!pendingItem || pendingItem.status !== 'playing') {
			if (pendingItem && pendingItem.status !== 'error') {
				playlistQueue = markError(playlistQueue, pendingItem.id);
				queueChanged = true;
			}
			pendingQueueNavigation = null;
			await chrome.storage.session.remove(STORAGE_KEYS.PENDING_QUEUE_NAVIGATION);
			retainedPlayingItemIds.delete(pendingItem?.id ?? '');
		}
	}
	if (activeQueueItemId) {
		const activeQueueItem = playlistQueue.items.find((item) => item.id === activeQueueItemId);
		if (activeQueueItem && activeQueueItem.status !== 'playing' && activeQueueItem.status !== 'error') {
			playlistQueue = markError(playlistQueue, activeQueueItem.id);
			queueChanged = true;
		}
	}

	for (const item of playlistQueue.items) {
		if (item.status === 'playing' && !retainedPlayingItemIds.has(item.id)) {
			playlistQueue = markError(playlistQueue, item.id);
			queueChanged = true;
		}
	}

	if (storedSession !== undefined && activeSession === null) {
		await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
	}
	if (storedPendingNavigation !== undefined && pendingQueueNavigation === null) {
		await chrome.storage.session.remove(STORAGE_KEYS.PENDING_QUEUE_NAVIGATION);
	}
	if (queueChanged) {
		await saveAndBroadcastQueue();
	}
	hydrated = true;

	await audioExportCoordinator.hydrate();
	await updateBadge(activeSession);
}

async function updateBadge(session: PlaybackSessionSnapshot | null): Promise<void> {
	try {
		await syncPlaybackBadge(session?.status ?? null, chrome.action);
	} catch (_error) {
		// Badge rendering must not corrupt playback state or suppress popup updates.
	}
}

async function broadcastSession(session: PlaybackSessionSnapshot | null): Promise<void> {
	await updateBadge(session);
	try {
		await chrome.runtime.sendMessage({ action: 'PLAYBACK_STATE_UPDATE', session });
	} catch (_error) {
		// The popup may be closed, so there may be no receiver for this broadcast.
	}
}

async function broadcastQueue(queue: PlaylistQueue): Promise<void> {
	try {
		await chrome.runtime.sendMessage({ action: 'PLAYLIST_QUEUE_UPDATE', queue });
	} catch (_error) {
		// Side Panel may be closed.
	}
}

async function saveAndBroadcastQueue(): Promise<void> {
	await saveQueue(playlistQueue);
	await broadcastQueue(playlistQueue);
}

async function persistPendingQueueNavigation(pending: PendingQueueNavigation): Promise<void> {
	pendingQueueNavigation = pending;
	await chrome.storage.session.set({ [STORAGE_KEYS.PENDING_QUEUE_NAVIGATION]: pending });
}

async function clearPendingQueueNavigation(itemId?: string): Promise<void> {
	if (itemId !== undefined && pendingQueueNavigation?.itemId !== itemId) {
		return;
	}
	pendingQueueNavigation = null;
	await chrome.storage.session.remove(STORAGE_KEYS.PENDING_QUEUE_NAVIGATION);
}

async function markQueueItemStatus(id: string, status: 'pending' | 'error' | 'done'): Promise<boolean> {
	const item = playlistQueue.items.find((candidate) => candidate.id === id);
	if (!item || item.status === status) {
		return false;
	}
	playlistQueue =
		status === 'pending' ? requeueItem(playlistQueue, id) : status === 'done' ? markDone(playlistQueue, id) : markError(playlistQueue, id);
	await saveAndBroadcastQueue();
	return true;
}

async function failPendingQueueNavigation(itemId: string): Promise<void> {
	await clearPendingQueueNavigation(itemId);
	await markQueueItemStatus(itemId, 'error');
}

async function cancelPendingQueueNavigation(): Promise<void> {
	const itemId = pendingQueueNavigation?.itemId;
	if (!itemId) {
		return;
	}
	await clearPendingQueueNavigation(itemId);
	await markQueueItemStatus(itemId, 'pending');
}

async function broadcastManualCheckpointState(
	panelInstanceId: string,
	state: 'suspended' | 'active' | 'discarded' | 'unavailable',
): Promise<void> {
	try {
		await chrome.runtime.sendMessage({ action: 'MANUAL_CHECKPOINT_STATE_UPDATE', panelInstanceId, state });
	} catch (_error) {
		// The Side Panel may be closed while its owner-scoped state is cleaned up.
	}
}

async function publishSession(session: PlaybackSessionSnapshot): Promise<void> {
	await chrome.storage.session.set({ [STORAGE_KEYS.PLAYBACK_SESSION]: session });
	await broadcastSession(session);
}

async function clearSession(): Promise<PlaybackSessionSnapshot | null> {
	const session = activeSession;
	if (session) {
		await readableSurface.clear(session.sessionId);
	}
	activeSession = null;

	if (session) {
		const stoppedSession: PlaybackSessionSnapshot = {
			...session,
			status: 'stopped',
			error: undefined,
			updatedAt: Date.now(),
		};
		await publishSession(stoppedSession);
	}

	await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
	await broadcastSession(null);
	return session;
}

async function failSession(error: string): Promise<void> {
	const session = activeSession;
	if (session) {
		await readableSurface.clear(session.sessionId);
	}
	activeSession = null;

	if (session) {
		await publishSession({
			...session,
			status: 'error',
			error,
			updatedAt: Date.now(),
		});
	}

	await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
}

async function publishExtractionFailure(
	tabId: number,
	title: string | undefined,
	url: string,
	error: string = ERROR_MESSAGES.extraction,
): Promise<void> {
	await publishSession(
		createPlaybackErrorSession({
			sessionId: crypto.randomUUID(),
			source: { kind: 'tab', tabId, title: title || url, url },
			voiceStyleId: DEFAULT_VOICE_STYLE_ID,
			speed: DEFAULT_SPEED,
			error,
			now: Date.now(),
		}),
	);
	activeSession = null;
	await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
}

export type AudioHost = {
	ensure(): Promise<void>;
	close(): Promise<void>;
	send(command: unknown): Promise<unknown>;
};

let configuredAudioHost: AudioHost | null = null;

export function configureAudioHost(audioHost: AudioHost): void {
	configuredAudioHost = audioHost;
}

// Helper to check if offscreen document is already created
async function hasOffscreenDocument(): Promise<boolean> {
	if (typeof chrome === 'undefined' || typeof chrome.offscreen === 'undefined') {
		return false;
	}

	const offscreenContextType = chrome.runtime.ContextType?.OFFSCREEN_DOCUMENT;
	if (typeof chrome.runtime.getContexts === 'function' && offscreenContextType) {
		const contexts = await chrome.runtime.getContexts({
			contextTypes: [offscreenContextType],
		});
		return contexts.length > 0;
	}

	// Fallback check
	try {
		const clients = await (globalThis as unknown as ServiceWorkerGlobalScope).clients.matchAll();
		return clients.some((client) => client.url.includes('offscreen.html'));
	} catch (_error) {
		return false;
	}
}

// Create offscreen document if needed
async function setupChromeOffscreen(): Promise<void> {
	if (typeof chrome === 'undefined' || typeof chrome.offscreen === 'undefined') {
		throw new Error('This browser does not support the offscreen document required for local audio playback.');
	}

	if (await hasOffscreenDocument()) {
		return;
	}

	try {
		await chrome.offscreen.createDocument({
			url: 'src/offscreen/offscreen.html',
			reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
			justification: 'Local ONNX TTS speech playback and local MP3 worker/WASM encoding.',
		});
	} catch (error) {
		if (!(await hasOffscreenDocument())) {
			throw error;
		}
	}
}

// Close offscreen document
async function closeChromeOffscreen(): Promise<void> {
	if (typeof chrome === 'undefined' || typeof chrome.offscreen === 'undefined') {
		return;
	}

	if (!(await hasOffscreenDocument())) {
		return;
	}

	try {
		await chrome.offscreen.closeDocument();
	} catch (_error) {
		// The document may already be closed.
	}
}

/**
 * Single-flighted because document creation is no longer serialized by the session lane: the
 * detached start phase and `dispatchOffscreenCommand`'s retries can now ask for it concurrently, and
 * `chrome.offscreen.createDocument` has no dedupe of its own.
 */
const setupOffscreen = createSingleFlight(async (): Promise<void> => {
	if (configuredAudioHost) {
		await configuredAudioHost.ensure();
		return;
	}
	await setupChromeOffscreen();
});

async function closeOffscreen(): Promise<void> {
	if (configuredAudioHost) {
		await configuredAudioHost.close();
		return;
	}
	await closeChromeOffscreen();
}

function sendAudioHostCommand(command: unknown): Promise<unknown> {
	return configuredAudioHost ? configuredAudioHost.send(command) : chrome.runtime.sendMessage(command);
}

const audioExportPreparationDiagnostics = new AudioExportPreparationDiagnostics();

// Test-only CDP view. There is deliberately no extension message or product UI
// route to preparation diagnostics, so public export behavior remains unchanged.
(globalThis as unknown as {
	__readitAudioExportPreparationDiagnostics?: {
		read(jobId?: string): unknown;
		clear(jobId?: string): void;
	};
}).__readitAudioExportPreparationDiagnostics = {
	read: (jobId) => audioExportPreparationDiagnostics.read(jobId),
	clear: (jobId) => audioExportPreparationDiagnostics.clear(jobId),
};

const audioExportCoordinator = createAudioExportCoordinator({
	storage: {
		async get() {
			const result = await chrome.storage.session.get(STORAGE_KEYS.AUDIO_EXPORT_JOB);
			return result[STORAGE_KEYS.AUDIO_EXPORT_JOB];
		},
		set: async (job) => {
			await chrome.storage.session.set({ [STORAGE_KEYS.AUDIO_EXPORT_JOB]: job });
		},
		remove: async () => {
			await chrome.storage.session.remove(STORAGE_KEYS.AUDIO_EXPORT_JOB);
		},
	},
	getPlaybackSession: () => activeSession,
	ensureOffscreen: setupOffscreen,
	sendOffscreen: (command) => sendOffscreenCommand(command, sendAudioHostCommand),
	preparationDiagnostics: audioExportPreparationDiagnostics,
	deleteHandle: deleteAudioExportHandle,
	broadcast: async (job) => {
		try {
			await chrome.runtime.sendMessage({ action: 'AUDIO_EXPORT_STATE_UPDATE', job });
		} catch (_error) {
			// The Popup or Side Panel may not be open while export state changes.
		}
	},
	now: () => Date.now(),
	setTimeout: (callback, delayMs) =>
		setTimeout(() => {
			runQueuedEvent(callback);
		}, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
});

function snapshotFromCheckpoint(checkpoint: ManualCheckpointMetadata): ManualPlaybackSessionSnapshot {
	return createPlaybackSession({
		sessionId: checkpoint.sessionId,
		contentScope: 'manual',
		source: { kind: 'manual', panelInstanceId: checkpoint.panelInstanceId },
		readableSurface: 'manual-reader',
		lang: checkpoint.lang,
		voiceStyleId: checkpoint.voiceStyleId,
		speed: checkpoint.speed,
		now: Date.now(),
	}) as ManualPlaybackSessionSnapshot;
}

async function getSuspendedManualCheckpoint(): Promise<ManualCheckpointMetadata | null> {
	if (suspendedManualCheckpoint) {
		return suspendedManualCheckpoint;
	}
	if (!(await hasOffscreenDocument())) {
		return null;
	}
	try {
		const response = await sendOffscreenCommand({ action: 'GET_MANUAL_CHECKPOINT_METADATA' }, sendAudioHostCommand);
		if (!response.success || !response.checkpoint) {
			return null;
		}
		suspendedManualCheckpoint = response.checkpoint;
		suspendedManualSession = snapshotFromCheckpoint(response.checkpoint);
		return response.checkpoint;
	} catch (_error) {
		return null;
	}
}

async function closeOffscreenWhenIdle(): Promise<void> {
	if (activeSession === null && !audioExportCoordinator.hasWork() && !(await getSuspendedManualCheckpoint())) {
		await closeOffscreen();
	}
}

function keepServiceWorkerAlive<T>(operation: Promise<T>): Promise<T> {
	const intervalId = setInterval(() => {
		void chrome.runtime.getPlatformInfo().catch(() => undefined);
	}, 20_000);

	return operation.finally(() => {
		clearInterval(intervalId);
	});
}

const modelCacheWarmer = createModelCacheWarmer(async () => {
	await keepServiceWorkerAlive(
		warmCache({
			urls: Object.values(MODEL_FILES),
			isCached: async (url) => {
				const cache = await caches.open(MODEL_CACHE_NAME);
				return (await cache.match(url)) !== undefined;
			},
			fetchAndCache: async (url, progressCallback) => {
				await fetchWithCache(url, progressCallback);
			},
			onProgress: (url, loaded, total) => {
				void chrome.runtime
					.sendMessage({
						action: 'MODEL_LOADING_PROGRESS',
						progress: { loaded, total, modelName: url.split('/').pop() },
					})
					.catch(() => undefined);
			},
			onComplete: () => {},
		}),
	);
});

async function stopActiveSession(_reason: string): Promise<void> {
	await settlePendingStart();
	// The pre-translation text belongs to the session being torn down. Cleared before the early
	// return below, so it cannot outlive its session and leak onto the next one's snapshot.
	activeTranslation = null;
	const activePlaybackSession = activeSession;
	const queueItemId = getQueueItemId(activePlaybackSession);
	// 'queue-skipped' leaves the queue alone: advanceQueueAfter owns that item's next
	// status, and releasing it to 'pending' here would overwrite the markDone and make
	// getNextPending hand back the article the user just skipped.
	if (queueItemId && _reason !== 'queue-skipped') {
		const releaseStatus = _reason === 'tab-removed' ? 'error' : 'pending';
		await markQueueItemStatus(queueItemId, releaseStatus);
	}
	const session = await clearSession();
	if (!session) {
		return;
	}

	try {
		await sendOffscreenCommand({ action: 'STOP' }, sendAudioHostCommand);
	} catch (_error) {
		// Session state is already invalidated; tolerate a missing offscreen receiver.
	} finally {
		await closeOffscreenWhenIdle();
	}
}

async function stopIfOwner(tabId: number, reason: string): Promise<void> {
	await ensureHydrated();
	if (ownsTab(activeSession, tabId)) {
		await stopActiveSession(reason);
	}
}

/**
 * Stops playback only when the owning tab actually left the document being read.
 *
 * `changeInfo` reports a fragment change, a `pushState`, a reload and a real navigation all as the
 * same `status: "loading"` update, so it cannot tell them apart on its own. The document the tab is
 * on now is compared against the one the session started on. Google Docs rewrites `#heading=…`
 * every time the caret moves, which used to stop playback on each click into the document.
 *
 * The URL comes from the content script rather than `chrome.tabs.get`, which reports no URL without
 * the broad `tabs` permission this extension deliberately does not request. A document that has
 * gone away takes its content script with it, so a silent tab is itself the answer.
 */
async function stopIfNavigatedAway(tabId: number): Promise<void> {
	await ensureHydrated();
	if (!ownsTab(activeSession, tabId)) {
		return;
	}
	const startedOn = activeSession?.source.kind === 'tab' ? activeSession.source.url : null;
	const currentUrl = await liveDocumentUrl(tabId);
	if (startedOn !== null && currentUrl !== null && isSameDocumentUrl(startedOn, currentUrl)) {
		return;
	}
	await stopActiveSession('tab-navigation');
}

async function liveDocumentUrl(tabId: number): Promise<string | null> {
	try {
		// Frame 0 only: Google Docs and other embedders would otherwise answer from an iframe.
		const info = (await chrome.tabs.sendMessage(tabId, { action: 'GET_PAGE_INFO' }, { frameId: 0 })) as { url?: unknown };
		return typeof info?.url === 'string' ? info.url : null;
	} catch (_error) {
		// No content script answered, so the document that was being read is gone.
		return null;
	}
}

function isRestrictedUrl(url: string): boolean {
	return (
		url.startsWith('chrome://') ||
		url.startsWith('chrome-extension://') ||
		url.startsWith('https://chrome.google.com/webstore') ||
		url.startsWith('https://chromewebstore.google.com') ||
		url.startsWith('about:') ||
		url.startsWith('view-source:')
	);
}

async function preemptManualForWeb(): Promise<CommandResponse> {
	await settlePendingStart();
	const manual = activeSession;
	if (manual?.contentScope !== 'manual') {
		return { success: true };
	}
	const panelInstanceId = manual.source.panelInstanceId;
	try {
		const response = await sendOffscreenCommand(
			{ action: 'CHECKPOINT_MANUAL', payload: { sessionId: manual.sessionId, panelInstanceId } },
			sendAudioHostCommand,
		);
		if (!response.success || !response.checkpoint) {
			return { success: false, error: 'manualCheckpointFailed' };
		}
		suspendedManualCheckpoint = response.checkpoint;
		suspendedManualSession = manual;
		await readableSurface.clear(manual.sessionId);
		activeSession = null;
		await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
		await broadcastSession(null);
		await broadcastManualCheckpointState(panelInstanceId, 'suspended');
		return { success: true };
	} catch (_error) {
		return { success: false, error: 'manualCheckpointFailed' };
	}
}

async function discardManualCheckpoint(panelInstanceId: string): Promise<boolean> {
	const checkpoint = await getSuspendedManualCheckpoint();
	if (!checkpoint || checkpoint.panelInstanceId !== panelInstanceId) {
		return false;
	}
	try {
		await sendOffscreenCommand(
			{ action: 'DISCARD_MANUAL_CHECKPOINT', payload: { panelInstanceId } },
			sendAudioHostCommand,
		);
	} catch (_error) {
		// Closing the Side Panel still needs to discard the background-only owner state.
	}
	suspendedManualCheckpoint = null;
	suspendedManualSession = null;
	await broadcastManualCheckpointState(panelInstanceId, 'discarded');
	return true;
}

/**
 * The pre-translation text for the active session. The offscreen document builds reader snapshots
 * and knows nothing about translation, so the background attaches this on the way out.
 */
let activeTranslation: { originalContent: string; translation: TranslationInfo } | null = null;

/**
 * Produces the text a translated session should speak. `null` means read the original: either the
 * browser has no Translator, or the source is already in the target language, or the detector was
 * not confident enough to name a source at all.
 */
async function translateForPlayback(content: PlaybackContent): Promise<TranslatedArticleText | null | 'failed'> {
	const dependencies = createChromeTranslationDependencies();
	if (!dependencies) {
		return null;
	}
	try {
		return await translateArticleText(content.content, await readTranslationTarget(), dependencies);
	} catch {
		return 'failed';
	}
}

async function startPlayback(initialInput: StartPlaybackInput): Promise<CommandResponse> {
	await ensureHydrated();

	// Translated before anything is torn down, so a failure leaves the current session playing.
	let input = initialInput;
	let translationForSession: { originalContent: string; translation: TranslationInfo } | null = null;
	const translationRequested = initialInput.contentScope === 'article' && initialInput.translate === true;
	if (input.contentScope === 'article' && input.translate) {
		const translated = await translateForPlayback(input.content);
		if (translated === 'failed') {
			return { success: false, error: ERROR_MESSAGES.translationFailed };
		}
		if (translated) {
			translationForSession = { originalContent: input.content.content, translation: translated.translation };
			input = {
				...input,
				content: { ...input.content, content: translated.content, lang: translated.translation.targetLanguage },
				// A translation cannot be highlighted onto the original page DOM, so it always reads
				// in the Document Reader.
				readableSurface: 'document-reader',
			};
		}
	}

	if (input.contentScope === 'manual') {
		const checkpoint = await getSuspendedManualCheckpoint();
		if (checkpoint) {
			await discardManualCheckpoint(checkpoint.panelInstanceId);
		}
		await stopActiveSession('session-replaced');
	} else {
		const preemption = await preemptManualForWeb();
		if (!preemption.success) {
			return preemption;
		}
		await stopActiveSession('session-replaced');
	}

	// Set after the teardown above, which clears it along with the session it belonged to.
	activeTranslation = translationForSession;

	if (
		input.contentScope === 'article' &&
		input.queueItemId &&
		playlistQueue.items.some((item) => item.id === input.queueItemId)
	) {
		playlistQueue = markPlaying(playlistQueue, input.queueItemId);
		await saveAndBroadcastQueue();
	}

	const preferences = (await chrome.storage.local.get([
		STORAGE_KEYS.ACTIVE_VOICE,
		STORAGE_KEYS.SPEED,
		STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE,
	])) as Record<string, unknown>;
	const storedVoiceStyleId = preferences[STORAGE_KEYS.ACTIVE_VOICE];
	const storedSpeed = preferences[STORAGE_KEYS.SPEED];
	const speedOverrideMarker = preferences[STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE];
	if (isLegacySpeedPreference(storedSpeed, speedOverrideMarker)) {
		try {
			await chrome.storage.local.set({ [STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE]: true });
		} catch (_error) {
			// A failed best-effort migration must not prevent playback at the saved speed.
		}
	}
	const voiceStyleId = typeof storedVoiceStyleId === 'string' ? storedVoiceStyleId : DEFAULT_VOICE_STYLE_ID;
	const speed = resolveStoredPlaybackSpeed(input.content.lang, storedSpeed, speedOverrideMarker);
	const sessionInput = {
		sessionId: crypto.randomUUID(),
		lang: input.content.lang,
		voiceStyleId,
		speed,
		now: Date.now(),
	};
	let session: PlaybackSessionSnapshot;
	if (input.contentScope === 'manual') {
		session = createPlaybackSession({
			...sessionInput,
			contentScope: 'manual',
			source: input.source,
			readableSurface: input.readableSurface,
		});
	} else if (input.contentScope === 'article') {
		session = createPlaybackSession({
			...sessionInput,
			contentScope: 'article',
			source: input.source,
			readableSurface: input.readableSurface,
			queueItemId: input.queueItemId,
		});
	} else {
		session = createPlaybackSession({
			...sessionInput,
			contentScope: 'selection',
			source: input.source,
			readableSurface: input.readableSurface,
		});
	}

	activeSession = session;
	readableSurface.activate(session);
	await publishSession(session);

	if (translationForSession) {
		// The translated text exists nowhere but the Document Reader — the original page's DOM holds
		// the untranslated words, so it cannot be highlighted. Unlike a Google Doc or a PDF, whose
		// own page stays in front of the reader, a translated session has no other visible surface,
		// so opening it is part of starting rather than a separate command. The reader can attach
		// before the offscreen document has words; `initialize()` delivers the snapshot when it does.
		await openDocumentReader();
	}

	// Read here, not in the offscreen document: `chrome.storage` is not reliably available
	// inside the Chrome offscreen document (see storage.ts).
	const pronunciationStorageResult = await chrome.storage.local.get(STORAGE_KEYS.PRONUNCIATION_DICTIONARY);
	const pronunciationRules: PronunciationRule[] = (pronunciationStorageResult[STORAGE_KEYS.PRONUNCIATION_DICTIONARY] as PronunciationRule[] | undefined) ?? [];

	const playPayload: OffscreenPlayPayload = {
		sessionId: session.sessionId,
		article: input.content,
		voiceStyleId,
		speed,
		readableSurface: input.readableSurface,
		pronunciationRules,
		...(input.source.kind === 'tab' ? { contentScope: input.contentScope } : {}),
		...(input.contentScope === 'manual' ? { panelInstanceId: input.source.panelInstanceId } : {}),
		...(input.readableSurface === 'document-reader'
			? { documentTitle: input.source.title?.trim() || (input.content as { title?: string }).title?.trim() || 'Document' }
			: {}),
		mediaSession: buildMediaSessionMetadata(
			{
				contentScope: input.contentScope,
				title: input.source.kind === 'tab' ? input.source.title : undefined,
				url: input.source.kind === 'tab' ? input.source.url : undefined,
			},
			{ selection: t('mediaSessionSelectedText'), manual: t('mediaSessionManualText') },
		),
		// Computed once at start: editing the queue mid-article can leave the OS next
		// button stale until the following item begins.
		hasNextQueueItem: getNextPending(playlistQueue) !== null,
	};
	// The session is live and published, so the command is answered here. Everything below waits on
	// the model cache and the offscreen document — seconds on a cold start — and must not hold the
	// session lane, or every surface's state read and control command would block behind it.
	pendingStart = loadAndPlay(session, playPayload, input).catch(() => undefined);
	return { success: true, ...(translationRequested ? { translated: translationForSession !== null } : {}) };
}

/**
 * Waits for the detached phase of the previous start. A read or a PAUSE never needs this, but a
 * session *transition* does: stopping or checkpointing talks to the offscreen document, and that
 * document may still be loading for the start this transition is about to replace.
 */
async function settlePendingStart(): Promise<void> {
	const inFlight = pendingStart;
	if (!inFlight) {
		return;
	}
	await inFlight;
	if (pendingStart === inFlight) {
		pendingStart = null;
	}
}

/**
 * Runs outside the session lane. `activeSession` may have moved on by the time each await settles —
 * a newer start or a STOP can win — so every step is guarded by the session id it was started for.
 */
async function loadAndPlay(
	session: PlaybackSessionSnapshot,
	playPayload: OffscreenPlayPayload,
	input: StartPlaybackInput,
): Promise<void> {
	if (input.contentScope === 'selection' && input.source.kind === 'tab') {
		try {
			await chrome.tabs.sendMessage(input.source.tabId, {
				action: 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE',
				sessionId: session.sessionId,
				selectionText: input.content.content,
			});
		} catch (_error) {
			// Selected-text audio still plays when the page cannot bind a safe DOM range.
		}
	}
	try {
		await modelCacheWarmer.waitForCurrentWarm();
	} catch (_error) {
		// A failed best-effort warm must not prevent the normal offscreen load path.
	}
	try {
		await setupOffscreen();
	} catch (_error) {
		await failPendingStart(session.sessionId);
		return;
	}
	if (activeSession?.sessionId !== session.sessionId) {
		// A newer session or a stop won while the offscreen document was loading. Tearing down reads
		// and closes shared state, so it belongs back on the session lane.
		runQueuedEvent(() => closeOffscreenWhenIdle());
		return;
	}
	observeOffscreenPlay(session.sessionId, {
		action: 'PLAY',
		payload: playPayload,
	});

	// Guard against offscreen never reporting back — if the session is still loading
	// after STARTUP_TIMEOUT_MS, transition to error rather than hanging indefinitely.
	setTimeout(() => {
		if (activeSession?.sessionId === session.sessionId && activeSession?.status === 'loading') {
			void failPendingStart(session.sessionId);
		}
	}, STARTUP_TIMEOUT_MS);
}

async function startCurrentPage(
	targetTabId?: number,
	queueItemId?: string,
	fallbackUrl?: string,
	translate = false,
): Promise<CommandResponse> {
	await ensureHydrated();
	if (!queueItemId) {
		await cancelPendingQueueNavigation();
	}
	const tabId = await findTargetTabForNavigation(targetTabId);
	if (!tabId) {
		return { success: false, error: ERROR_MESSAGES.activeTab };
	}
	let activeTab: chrome.tabs.Tab | undefined;
	try {
		activeTab = await chrome.tabs.get(tabId);
	} catch {
		return { success: false, error: ERROR_MESSAGES.activeTab };
	}

	if (!activeTab || typeof activeTab.id !== 'number') {
		return { success: false, error: ERROR_MESSAGES.activeTab };
	}

	const url = activeTab.url || (await readCurrentTabUrl(activeTab.id)) || fallbackUrl || '';
	if (isRestrictedUrl(url)) {
		return { success: false, error: ERROR_MESSAGES.restrictedPage };
	}

	let articleResponse;
	try {
		articleResponse = await requestCurrentTabArticle(activeTab.id, activeTab.title, url);
	} catch (_error) {
		if (!url) {
			return { success: false, error: ERROR_MESSAGES.restrictedPage };
		}
		if (activeSession?.contentScope === 'manual') {
			return { success: false, error: ERROR_MESSAGES.extraction };
		}
		await stopActiveSession('session-replaced');
		await publishExtractionFailure(activeTab.id, activeTab.title, url);
		return { success: false, error: ERROR_MESSAGES.extraction };
	}

	if (
		!articleResponse.success ||
		!isArticle(articleResponse.article) ||
		!isArticleReadableSurface(articleResponse.readableSurface)
	) {
		const extractionError = getExtractionError(articleResponse.success ? undefined : articleResponse.error);
		if (activeSession?.contentScope === 'manual') {
			return { success: false, error: extractionError };
		}
		await stopActiveSession('session-replaced');
		await publishExtractionFailure(activeTab.id, activeTab.title, url, extractionError);
		return { success: false, error: extractionError };
	}

	return startPlayback({
		contentScope: 'article',
		source: {
			kind: 'tab',
			tabId: activeTab.id,
			title: articleResponse.article.title || activeTab.title || url,
			url: queueItemId ? url : articleResponse.article.url || url,
		},
		content: articleResponse.article,
		readableSurface: articleResponse.readableSurface,
		translate,
		...(queueItemId ? { queueItemId } : {}),
	});
}

async function playQueueItem(item: QueueItem, preferredTabId?: number): Promise<CommandResponse> {
	const targetTabId = await findTargetTabForNavigation(preferredTabId);
	if (!targetTabId) {
		await markQueueItemStatus(item.id, 'error');
		return { success: false, error: ERROR_MESSAGES.activeTab };
	}

	let targetTabUrl = '';
	try {
		const targetTab = await chrome.tabs.get(targetTabId);
		targetTabUrl = targetTab.url ?? '';
	} catch {
		// Treat an unavailable URL as a navigation that still needs to be started.
	}

	let isAlreadyOnPage = false;
	try {
		isAlreadyOnPage = normalizeQueueUrl(targetTabUrl) === item.normalizedUrl;
	} catch {
		// Invalid current URL means the target needs navigation.
	}
	playlistQueue = markPlaying(playlistQueue, item.id);
	await saveAndBroadcastQueue();

	if (isAlreadyOnPage) {
		const result = await startCurrentPage(targetTabId, item.id, item.url);
		if (!result.success) {
			await markQueueItemStatus(item.id, 'error');
		}
		return result;
	}

	try {
		await persistPendingQueueNavigation(createPendingQueueNavigation(item.id, targetTabId, item.url));
		await chrome.tabs.update(targetTabId, { url: item.url });
		return { success: true };
	} catch {
		await failPendingQueueNavigation(item.id);
		return { success: false, error: t('queueErrorNavigationFailed') };
	}
}

async function startManualText(payload: unknown): Promise<CommandResponse> {
	const prepared = prepareManualStart(payload);
	if (!prepared) {
		return { success: false, error: 'invalidManualText' };
	}
	const { panelInstanceId, ...content } = prepared;
	return startPlayback({
		contentScope: 'manual',
		source: { kind: 'manual', panelInstanceId },
		content,
		readableSurface: 'manual-reader',
	});
}

async function getCurrentPageInfo(): Promise<PageInfoResponse> {
	const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!activeTab || typeof activeTab.id !== 'number' || isRestrictedUrl(activeTab.url ?? '')) {
		return { available: false };
	}

	try {
		return await requestPageInfoFromTab(activeTab.id, {
			sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
	} catch (_error) {
		return { available: false };
	}
}

async function dispatchOffscreenCommand(command: OffscreenCommand): Promise<OffscreenCommandResponse> {
	let retries = 3;
	while (retries > 0) {
		try {
			const res = await sendOffscreenCommand(command, sendAudioHostCommand);
			if (res.success || retries === 1) return res;
			retries--;
			await new Promise((resolve) => setTimeout(resolve, 150));
			await setupOffscreen();
		} catch (error) {
			retries--;
			if (retries > 0 && isMissingReceiverError(error)) {
				await new Promise((resolve) => setTimeout(resolve, 150));
				await setupOffscreen();
			} else {
				throw error;
			}
		}
	}
	return { success: false };
}

function observeOffscreenPlay(sessionId: string, command: OffscreenCommand): void {
	void dispatchOffscreenCommand(command).then(
		(response) => {
			if (!response.success) {
				void failPendingStart(sessionId);
				return;
			}
			const audioExportEstimate = response.audioExportEstimate;
			if (audioExportEstimate) {
				runQueuedEvent(async () => {
					await ensureHydrated();
					const updatedSession = applyAudioExportEstimate(activeSession, sessionId, audioExportEstimate, Date.now());
					if (!updatedSession) {
						return;
					}
					activeSession = updatedSession;
					await publishSession(updatedSession);
				});
			}
		},
		() => {
			void failPendingStart(sessionId);
		},
	);
}

async function failPendingStart(sessionId: string): Promise<void> {
	await enqueue(async () => {
		await ensureHydrated();
		if (activeSession?.sessionId !== sessionId) {
			return;
		}
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreenWhenIdle();
	});
}

async function getPlaybackState(): Promise<{ session: PlaybackSessionSnapshot | null; currentTabId?: number }> {
	await ensureHydrated();
	const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return {
		session: activeSession,
		...(typeof activeTab?.id === 'number' ? { currentTabId: activeTab.id } : {}),
	};
}

async function routeSessionCommand(action: 'PAUSE' | 'PLAY'): Promise<CommandResponse> {
	await ensureHydrated();
	// Pausing a session that is still preparing must reach the offscreen document rather than fail,
	// so wait for the start it belongs to.
	await settlePendingStart();
	if (!activeSession) {
		return { success: false, error: ERROR_MESSAGES.noSession };
	}

	const payload = action === 'PLAY' ? { sessionId: activeSession.sessionId } : undefined;
	try {
		const response = await sendOffscreenCommand({ action, ...(payload ? { payload } : {}) }, sendAudioHostCommand);
		if (!response.success) {
			await failSession(ERROR_MESSAGES.setup);
			await closeOffscreenWhenIdle();
			return { success: false, error: ERROR_MESSAGES.setup };
		}
		return response;
	} catch (_error) {
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreenWhenIdle();
		return { success: false, error: ERROR_MESSAGES.setup };
	}
}

async function openDocumentReader(): Promise<CommandResponse> {
	await ensureHydrated();
	if (!activeSession || activeSession.readableSurface !== 'document-reader') {
		return { success: false, error: 'documentReaderUnavailable' };
	}
	const existingTabId = readableSurface.documentReaderTabId();
	try {
		if (existingTabId !== null) {
			await chrome.tabs.update(existingTabId, { active: true });
		} else {
			await chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/reader.html') });
		}
		return { success: true };
	} catch {
		return { success: false, error: 'documentReaderOpenFailed' };
	}
}

async function changeSpeed(payload: unknown): Promise<CommandResponse> {
	await ensureHydrated();
	await settlePendingStart();
	if (!activeSession) {
		return { success: false, error: ERROR_MESSAGES.noSession };
	}

	const speed = (payload as { speed?: unknown } | undefined)?.speed;
	if (!isFiniteNumber(speed)) {
		return { success: false, error: ERROR_MESSAGES.invalidSpeed };
	}

	try {
		const response = await sendOffscreenCommand({ action: 'CHANGE_SPEED', payload: { speed } }, sendAudioHostCommand);
		const session = activeSession;
		if (response.success && session) {
			await chrome.storage.local.set({
				[STORAGE_KEYS.SPEED]: speed,
				[STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE]: true,
			});
			const speedChangedSession = { ...session, speed, updatedAt: Date.now() };
			const audioExportEstimate = response.audioExportEstimate;
			const updatedSession = audioExportEstimate
				? (applyAudioExportEstimate(speedChangedSession, speedChangedSession.sessionId, audioExportEstimate, Date.now()) ?? speedChangedSession)
				: speedChangedSession;
			activeSession = updatedSession;
			await publishSession(updatedSession);
			return response;
		}
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreenWhenIdle();
		return { success: false, error: ERROR_MESSAGES.setup };
	} catch (_error) {
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreenWhenIdle();
		return { success: false, error: ERROR_MESSAGES.setup };
	}
}

async function stopReading(): Promise<CommandResponse> {
	await ensureHydrated();
	await cancelPendingQueueNavigation();
	await stopActiveSession('user-stop');
	await closeOffscreenWhenIdle();
	return { success: true };
}

async function resumeManualCheckpoint(panelInstanceId: string): Promise<CommandResponse> {
	await ensureHydrated();
	const checkpoint = await getSuspendedManualCheckpoint();
	if (!checkpoint) {
		await broadcastManualCheckpointState(panelInstanceId, 'unavailable');
		return { success: false, error: 'manualCheckpointUnavailable' };
	}
	if (checkpoint.panelInstanceId !== panelInstanceId) {
		return { success: true };
	}
	const manual = suspendedManualSession ?? snapshotFromCheckpoint(checkpoint);
	if (activeSession) {
		await stopActiveSession('manual-resume');
	}
	activeSession = {
		...manual,
		status: 'loading',
		currentParagraphIndex: 0,
		totalParagraphs: 0,
		progressPercentage: 0,
		error: undefined,
		updatedAt: Date.now(),
	};
	readableSurface.activate(activeSession);
	await publishSession(activeSession);
	try {
		const response = await sendOffscreenCommand(
			{ action: 'RESUME_MANUAL_CHECKPOINT', payload: { panelInstanceId } },
			sendAudioHostCommand,
		);
		if (!response.success) {
			throw new Error('Manual checkpoint is unavailable');
		}
		suspendedManualCheckpoint = null;
		suspendedManualSession = null;
		await broadcastManualCheckpointState(panelInstanceId, 'active');
		return { success: true };
	} catch (_error) {
		await readableSurface.clear(activeSession.sessionId);
		activeSession = null;
		await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
		await broadcastSession(null);
		suspendedManualCheckpoint = null;
		suspendedManualSession = null;
		await broadcastManualCheckpointState(panelInstanceId, 'unavailable');
		await closeOffscreen();
		return { success: false, error: 'manualCheckpointUnavailable' };
	}
}

async function discardManualCheckpointForOwner(panelInstanceId: string): Promise<CommandResponse> {
	await ensureHydrated();
	const checkpoint = await getSuspendedManualCheckpoint();
	if (!checkpoint) {
		await broadcastManualCheckpointState(panelInstanceId, 'discarded');
		return { success: true };
	}
	if (checkpoint.panelInstanceId !== panelInstanceId) {
		return { success: true };
	}
	await discardManualCheckpoint(panelInstanceId);
	await closeOffscreenWhenIdle();
	return { success: true };
}

async function stopSidePanelAudio(panelInstanceId: string): Promise<CommandResponse> {
	await ensureHydrated();
	const checkpoint = await getSuspendedManualCheckpoint();
	const ownsActiveManual = activeSession?.contentScope === 'manual' && activeSession.source.panelInstanceId === panelInstanceId;
	const ownsCheckpoint = checkpoint?.panelInstanceId === panelInstanceId;
	if (!ownsActiveManual && !ownsCheckpoint) {
		return { success: true };
	}
	if (activeSession) {
		await stopActiveSession('side-panel-closed');
	}
	if (ownsCheckpoint) {
		await discardManualCheckpoint(panelInstanceId);
	}
	await closeOffscreen();
	return { success: true };
}

async function findTargetTabForNavigation(preferredTabId?: number): Promise<number | undefined> {
	if (typeof preferredTabId === 'number') {
		try {
			const tab = await chrome.tabs.get(preferredTabId);
			const preferred = selectNavigationTab([tab], preferredTabId);
			if (preferred !== undefined) {
				return preferred;
			}
		} catch {
			// Preferred tab no longer exists
		}
	}

	try {
		const tabs = await chrome.tabs.query({ currentWindow: true });
		const currentWindowTabId = selectNavigationTab(tabs, preferredTabId);
		if (currentWindowTabId !== undefined) {
			return currentWindowTabId;
		}
	} catch {
		// Ignore error querying tabs
	}

	try {
		const tabs = await chrome.tabs.query({});
		const anyWindowTabId = selectNavigationTab(tabs, preferredTabId);
		if (anyWindowTabId !== undefined) {
			return anyWindowTabId;
		}
	} catch {
		// Ignore error querying tabs
	}

	return undefined;
}

/** Retire a queue item and start whatever is next. Shared by natural completion and skip. */
async function advanceQueueAfter(queueItemId: string, tabId?: number): Promise<void> {
	playlistQueue = markDone(playlistQueue, queueItemId);
	await saveAndBroadcastQueue();

	const nextItem = getNextPending(playlistQueue);
	if (nextItem) {
		await playQueueItem(nextItem, tabId);
	}
}

/**
 * The system "next track" control. Unlike natural completion this runs with a live
 * session, so the audio has to be torn down first — see stopActiveSession for why the
 * reason matters.
 */
async function skipToNextQueueItem(): Promise<CommandResponse> {
	await ensureHydrated();
	const queueItemId = getQueueItemId(activeSession);
	if (!queueItemId || !getPlayingItem(playlistQueue, queueItemId)) {
		return { success: false, error: ERROR_MESSAGES.noSession };
	}
	const tabId = activeSession?.source.kind === 'tab' ? activeSession.source.tabId : undefined;

	await stopActiveSession('queue-skipped');
	await advanceQueueAfter(queueItemId, tabId);
	return { success: true };
}

async function applyProgressMessage(message: Record<string, unknown>): Promise<void> {
	await ensureHydrated();
	if (!activeSession || typeof message.sessionId !== 'string' || !isPlaybackProgress(message.progress)) {
		return;
	}

	const updatedSession = applyPlaybackProgress(activeSession, message.sessionId, message.progress, Date.now());
	if (!updatedSession) {
		return;
	}

	if (updatedSession.status === 'stopped') {
		// Tearing the audio down always reports `stopped`, so after a failure that report arrives a
		// few frames behind the error. Clearing here would broadcast `stopped` and then `null` over
		// the error, and the only surface carrying the message loses it before it can be read. The
		// failure teardown does the same cleanup while leaving the error as the last word.
		if (activeSession.status === 'error') {
			await failSession(activeSession.error ?? ERROR_MESSAGES.setup);
			await closeOffscreenWhenIdle();
			return;
		}

		const completedNaturally = (message.progress as unknown as Record<string, unknown>)?.completedNaturally === true;
		const completedSession = activeSession;
		const currentSessionTabId = completedSession?.source.kind === 'tab' ? completedSession.source.tabId : undefined;
		const queueItemId = getQueueItemId(completedSession);
		await clearSession();

		if (completedNaturally && completedSession?.readableSurface === 'document-reader') {
			try {
				await chrome.runtime.sendMessage({ action: 'DOCUMENT_READER_COMPLETED', sessionId: completedSession.sessionId });
			} catch (_error) {
				// The Reader may be closed, so there may be no receiver for this broadcast.
			}
		}

		if (completedNaturally && queueItemId && getPlayingItem(playlistQueue, queueItemId)) {
			await advanceQueueAfter(queueItemId, currentSessionTabId);
		}

		await closeOffscreenWhenIdle();
		return;
	}

	activeSession = updatedSession;
	await publishSession(updatedSession);
}

function respondFromQueue<T>(operation: () => Promise<T>, sendResponse: (response?: unknown) => void): true {
	void enqueue(operation).then(
		(response) => sendResponse(response),
		() => sendResponse({ success: false, error: ERROR_MESSAGES.setup }),
	);
	return true;
}

async function readCurrentTabUrl(tabId: number): Promise<string | null> {
	try {
		const tab = await chrome.tabs.get(tabId);
		if (typeof tab.url === 'string' && tab.url.length > 0) {
			return tab.url;
		}
	} catch {
		// Fall back to the content script when the tabs API redacts the URL.
	}
	return liveDocumentUrl(tabId);
}

async function handlePendingQueueNavigationUpdate(tabId: number, changeInfo: { status?: string; url?: string }): Promise<void> {
	await ensureHydrated();
	const pending = pendingQueueNavigation;
	if (!pending || pending.tabId !== tabId) {
		return;
	}
	if (typeof changeInfo.url === 'string' && !matchesPendingQueueNavigation(pending, tabId, changeInfo.url)) {
		await failPendingQueueNavigation(pending.itemId);
		return;
	}
	if (changeInfo.status !== 'complete') {
		return;
	}

	const currentUrl = typeof changeInfo.url === 'string' ? changeInfo.url : await readCurrentTabUrl(tabId);
	if (!currentUrl || !matchesPendingQueueNavigation(pending, tabId, currentUrl)) {
		await failPendingQueueNavigation(pending.itemId);
		return;
	}

	const pendingItem = playlistQueue.items.find((item) => item.id === pending.itemId);
	if (!pendingItem || pendingItem.status !== 'playing') {
		await failPendingQueueNavigation(pending.itemId);
		return;
	}
	await clearPendingQueueNavigation(pending.itemId);
	let result = await startCurrentPage(tabId, pending.itemId, pending.expectedUrl);
	if (!result.success && pendingItem && isSupportedPdfSource(pendingItem.url)) {
		// Retry nhẹ cho file PDF local phòng trường hợp Chrome PDF Viewer chưa kịp ready.
		await new Promise((resolve) => setTimeout(resolve, 350));
		result = await startCurrentPage(tabId, pending.itemId, pending.expectedUrl);
	}
	if (!result.success) {
		await markQueueItemStatus(pending.itemId, 'error');
	}
}

// Handle runtime messages
export const handleBackgroundMessage = (
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void,
) => {
		if (!message || typeof message !== 'object') {
			return undefined;
		}

		const msg = message as Record<string, unknown>;
		if (isInternalAudioExportOffscreenCommand(msg)) {
			return undefined;
		}
		const action = msg.action;

		switch (action) {
			case 'GET_AUDIO_EXPORT_STATE':
				return respondFromQueue(async () => {
					await ensureHydrated();
					return { job: audioExportCoordinator.snapshot() };
				}, sendResponse);

			case 'PREPARE_AUDIO_EXPORT': {
				if (!isAudioExportPrepareRequest(msg.payload)) {
					sendResponse({ success: false, error: 'snapshot-unavailable' });
					return undefined;
				}
				const prepareRequest = msg.payload;
				return respondFromQueue(async () => {
					await ensureHydrated();
					return audioExportCoordinator.prepare(prepareRequest);
				}, sendResponse);
			}

			case 'START_AUDIO_EXPORT':
				return respondFromQueue(async () => {
					await ensureHydrated();
					const jobId = (msg.payload as { jobId?: unknown } | undefined)?.jobId;
					return typeof jobId === 'string' ? audioExportCoordinator.start(jobId) : { success: false, error: 'snapshot-unavailable' };
				}, sendResponse);

			case 'CANCEL_AUDIO_EXPORT':
				return respondFromQueue(async () => {
					await ensureHydrated();
					const jobId = (msg.payload as { jobId?: unknown } | undefined)?.jobId;
					const response = typeof jobId === 'string' ? await audioExportCoordinator.cancel(jobId) : { success: false, error: 'snapshot-unavailable' };
					await closeOffscreenWhenIdle();
					return response;
				}, sendResponse);

			case 'DISCARD_AUDIO_EXPORT':
				return respondFromQueue(async () => {
					await ensureHydrated();
					const jobId = (msg.payload as { jobId?: unknown } | undefined)?.jobId;
					const response = typeof jobId === 'string' ? await audioExportCoordinator.discard(jobId) : { success: false, error: 'snapshot-unavailable' };
					await closeOffscreenWhenIdle();
					return response;
				}, sendResponse);

			case 'GET_PLAYBACK_STATE':
				return respondFromQueue(getPlaybackState, sendResponse);

			case 'GET_CURRENT_PAGE_INFO':
				return respondFromQueue(getCurrentPageInfo, sendResponse);

			case 'START_CURRENT_PAGE':
				return respondFromQueue(startCurrentPage, sendResponse);

			case 'START_CURRENT_PAGE_TRANSLATED':
				return respondFromQueue(() => startCurrentPage(undefined, undefined, undefined, true), sendResponse);

			case 'START_READER_CONTENT': {
				const readerRequest = parseReaderContentRequest(msg.payload, sender.tab?.id);
				if (!readerRequest) {
					sendResponse({ success: false, error: ERROR_MESSAGES.noSession });
					return undefined;
				}
				return respondFromQueue(async () => {
					const response = await startPlayback({
						contentScope: 'article',
						source: { kind: 'tab', tabId: readerRequest.tabId, title: readerRequest.title, url: readerRequest.title },
						content: { content: readerRequest.content, lang: readerRequest.lang },
						readableSurface: 'document-reader',
					});
					// The Reader chains chapters on natural completion, so it has to recognise the
					// session it just started: a completion for any other session is not its own.
					return response.success && activeSession ? { ...response, sessionId: activeSession.sessionId } : response;
				}, sendResponse);
			}

			case 'CLOSE_SIDEPANEL': {
				const targetWindowId = (msg.payload as Record<string, unknown> | undefined)?.windowId as number | undefined;
				if (targetWindowId) {
					const port = openSidePanelPorts.get(targetWindowId);
					if (port) {
						try {
							port.postMessage({ action: 'CLOSE_SIDEPANEL' });
						} catch (_e) {
							// ignore
						}
						openSidePanelPorts.delete(targetWindowId);
						void updateOpenSidePanelWindowsStorage();
						sendResponse?.({ success: true });
					} else {
						void updateOpenSidePanelWindowsStorage();
						sendResponse?.({ success: false, reason: 'NOT_FOUND' });
					}
				} else {
					sendResponse?.({ success: false, reason: 'INVALID_WINDOW_ID' });
				}
				return true;
			}

			case 'START_SELECTED_TEXT': {
				const request = prepareSelectedTextRequest(
					{ selectionText: msg.selectionText, pageLanguage: msg.pageLanguage },
					{
						frameId: sender.frameId,
						tabId: sender.tab?.id,
						windowId: sender.tab?.windowId,
						title: sender.tab?.title,
						url: sender.url,
					},
				);
				if (!request) {
					sendResponse({ success: true });
					return undefined;
				}

				void requestActionPopup(request.windowId, chrome.action);
				return respondFromQueue(
					() =>
						startPlayback({
							contentScope: 'selection',
							source: {
								kind: 'tab',
								tabId: request.tabId,
								title: request.article.title || request.title || request.url,
								url: request.article.url || request.url,
							},
							content: request.article,
							readableSurface: 'website-dom',
						}),
					sendResponse,
				);
			}

			case 'START_MANUAL_TEXT':
				return respondFromQueue(() => startManualText(msg.payload), sendResponse);

			case 'RESUME_MANUAL_CHECKPOINT':
				if (!isManualPlaybackControlMessage(msg)) {
					sendResponse({ success: false });
					return undefined;
				}
				return respondFromQueue(() => resumeManualCheckpoint(msg.panelInstanceId), sendResponse);

			case 'DISCARD_MANUAL_CHECKPOINT':
				if (!isManualPlaybackControlMessage(msg)) {
					sendResponse({ success: false });
					return undefined;
				}
				return respondFromQueue(() => discardManualCheckpointForOwner(msg.panelInstanceId), sendResponse);

			case 'STOP_SIDE_PANEL_AUDIO':
				if (!isManualPlaybackControlMessage(msg)) {
					sendResponse({ success: false });
					return undefined;
				}
				return respondFromQueue(() => stopSidePanelAudio(msg.panelInstanceId), sendResponse);

			case 'PAUSE_READING':
				return respondFromQueue(() => routeSessionCommand('PAUSE'), sendResponse);

			case 'RESUME_READING':
				return respondFromQueue(() => routeSessionCommand('PLAY'), sendResponse);

			case 'STOP_READING':
				return respondFromQueue(stopReading, sendResponse);

			case 'SKIP_TO_NEXT_QUEUE_ITEM':
				return respondFromQueue(skipToNextQueueItem, sendResponse);

			case 'OPEN_DOCUMENT_READER':
				return respondFromQueue(openDocumentReader, sendResponse);

			case 'CHANGE_SPEED':
				return respondFromQueue(() => changeSpeed(msg.payload), sendResponse);

			case 'PLAYBACK_PROGRESS_UPDATE':
				runQueuedEvent(() => applyProgressMessage(msg));
				break;

			case 'AUDIO_EXPORT_PROGRESS':
				if (isAudioExportProgressUpdate(msg.progress)) {
					const progress = msg.progress;
					runQueuedEvent(async () => {
						await ensureHydrated();
						await audioExportCoordinator.handleProgress(progress);
						await closeOffscreenWhenIdle();
					});
				}
				break;

			case 'READABLE_SURFACE_INIT':
				if (!isReadableSurfaceInitMessage(msg)) {
					sendResponse({ success: false });
					return undefined;
				}
				return respondFromQueue(async () => {
					await ensureHydrated();
					return readableSurface.initialize(msg);
				}, sendResponse);

			case 'READABLE_SURFACE_UPDATE':
				if (isReadableSurfaceUpdateMessage(msg)) {
					runQueuedEvent(async () => {
						await ensureHydrated();
						readableSurface.advance(msg);
					});
				}
				break;

			case 'READABLE_SURFACE_CLEAR':
				if (isReadableSurfaceClearMessage(msg)) {
					runQueuedEvent(async () => {
						await ensureHydrated();
						await readableSurface.clear(msg.sessionId);
					});
				}
				break;

			case 'GET_PLAYLIST_QUEUE':
				return respondFromQueue(async () => {
					await ensureHydrated();
					return { queue: playlistQueue };
				}, sendResponse);

			case 'ADD_TAB_TO_QUEUE': {
				return respondFromQueue(async () => {
					await ensureHydrated();
					const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
					if (!activeTab?.id) {
						return { success: false, error: 'No active tab' };
					}
					let tabUrl = activeTab.url;
					let tabTitle = activeTab.title;
					if (!tabUrl) {
						const info = await requestPageInfoFromTab(activeTab.id, {
							sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
							executeScript: (options) => chrome.scripting.executeScript(options),
						}).catch(() => null);
						if (info?.available) {
							tabUrl = info.url;
							tabTitle = info.title;
						}
					}
					if (!tabUrl || isRestrictedUrl(tabUrl)) {
						return { success: false, error: 'No active tab' };
					}
					const result = addToQueue(playlistQueue, {
						url: tabUrl,
						title: tabTitle ?? '',
					});
					if ('error' in result) {
						return { success: false, error: result.error };
					}
					playlistQueue = result;
					await saveQueue(playlistQueue);
					await broadcastQueue(playlistQueue);
					return { success: true };
				}, sendResponse);
			}

			case 'ADD_URL_TO_QUEUE': {
				const urlPayload = (msg.payload as { url?: unknown } | undefined)?.url;
				if (typeof urlPayload !== 'string') {
					sendResponse({ success: false, error: 'Invalid URL' });
					return undefined;
				}
				const rawUrl = urlPayload;
				return respondFromQueue(async () => {
					await ensureHydrated();
					let url: URL;
					try {
						url = new URL(rawUrl);
					} catch {
						return { success: false, error: 'Invalid URL' };
					}
					const result = addToQueue(playlistQueue, {
						url: rawUrl,
						title: url.hostname,
					});
					if ('error' in result) {
						return { success: false, error: result.error };
					}
					playlistQueue = result;
					await saveQueue(playlistQueue);
					await broadcastQueue(playlistQueue);
					return { success: true };
				}, sendResponse);
			}

			case 'REMOVE_QUEUE_ITEM': {
				const removeId = (msg.payload as { id?: unknown } | undefined)?.id;
				if (typeof removeId !== 'string') {
					sendResponse({ success: false });
					return undefined;
				}
				return respondFromQueue(async () => {
					await ensureHydrated();
					if (pendingQueueNavigation?.itemId === removeId) {
						await clearPendingQueueNavigation(removeId);
					}
					playlistQueue = removeItem(playlistQueue, removeId);
					await saveAndBroadcastQueue();
					return { success: true };
				}, sendResponse);
			}

			case 'REQUEUE_ITEM': {
				const requeueId = (msg.payload as { id?: unknown } | undefined)?.id;
				if (typeof requeueId !== 'string') {
					sendResponse({ success: false });
					return undefined;
				}
				return respondFromQueue(async () => {
					await ensureHydrated();
					if (pendingQueueNavigation?.itemId === requeueId) {
						await clearPendingQueueNavigation(requeueId);
					}
					playlistQueue = requeueItem(playlistQueue, requeueId);
					await saveAndBroadcastQueue();
					return { success: true };
				}, sendResponse);
			}

			case 'CLEAR_QUEUE':
				return respondFromQueue(async () => {
					await ensureHydrated();
					await clearPendingQueueNavigation();
					playlistQueue = clearQueue(playlistQueue);
					await saveAndBroadcastQueue();
					return { success: true };
				}, sendResponse);

			case 'PLAY_QUEUE':
				return respondFromQueue(async () => {
					await ensureHydrated();
					const nextItem = getNextPending(playlistQueue);
					if (!nextItem) {
						return { success: false, error: t('queueErrorNoPending') };
					}
					return playQueueItem(nextItem);
				}, sendResponse);

			case 'REPLAY_QUEUE':
				return respondFromQueue(async () => {
					await ensureHydrated();
					if (playlistQueue.items.length === 0) {
						return { success: false, error: t('queueErrorEmpty') };
					}
					playlistQueue = requeueAllItems(playlistQueue);
					await saveAndBroadcastQueue();
					const nextItem = getNextPending(playlistQueue);
					if (!nextItem) {
						return { success: false, error: t('queueErrorReplayFailed') };
					}
					return playQueueItem(nextItem);
				}, sendResponse);

			default:
				break;
		}

		return undefined;
	};

chrome.runtime.onMessage.addListener(handleBackgroundMessage);

chrome.tabs.onRemoved.addListener((tabId) => {
	runQueuedEvent(async () => {
		await ensureHydrated();
		if (pendingQueueNavigation?.tabId === tabId) {
			await failPendingQueueNavigation(pendingQueueNavigation.itemId);
		}
		await stopIfOwner(tabId, 'tab-removed');
	});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	runQueuedEvent(async () => {
		// Checked on `complete` as well as `loading`: while a navigation is still loading the tab can
		// still report the URL it is leaving, and that update is the only other chance to notice.
		if (changeInfo.status !== undefined || changeInfo.url !== undefined) {
			await stopIfNavigatedAway(tabId);
		}
		if (changeInfo.status === 'complete' || changeInfo.url !== undefined) {
			await handlePendingQueueNavigationUpdate(tabId, changeInfo);
		}
	});
});

const beginModelCacheWarm = async (): Promise<void> => {
	try {
		await modelCacheWarmer.warm();
	} catch (_error) {
		// Non-critical: a later lifecycle event or normal Play may fetch the model.
	}
};

registerModelCacheWarmLifecycle(
	{
		onInstalled: chrome.runtime.onInstalled,
		onStartup: chrome.runtime.onStartup,
	},
	() => {
		void beginModelCacheWarm();
	},
);

chrome.runtime.onInstalled.addListener(() => {
	void setupContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === 'readit-read-selection') {
		if (typeof tab?.id !== 'number') return;
		runQueuedEvent(async () => {
			const [{ result: pageLanguage } = { result: undefined }] = await chrome.scripting
				.executeScript({
					target: { tabId: tab.id as number },
					func: () => document.documentElement.lang,
				})
				.catch(() => []);
			const url = info.pageUrl || tab.url || '';
			const article = createSelectedTextArticle({
				selectionText: info.selectionText,
				title: tab.title || url,
				url,
				pageLanguage,
			});
			if (!article) {
				return { success: true };
			}
			const response = await startPlayback({
				contentScope: 'selection',
				source: {
					kind: 'tab',
					tabId: tab.id as number,
					title: article.title || tab.title || url,
					url: article.url || url,
				},
				content: article,
				readableSurface: 'website-dom',
			});
			// Nothing carries this response back to a caller, so a failed start would otherwise leave an
			// open popup or Side Panel showing the previous state. Publishing the error keeps every open
			// surface in sync without opening one.
			if (!response.success) {
				await publishExtractionFailure(tab.id as number, tab.title, url, response.error || ERROR_MESSAGES.setup);
			}
			return response;
		});
		return;
	}

	if (info.menuItemId === 'readit-add-to-queue') {
		const url = info.pageUrl || tab?.url || '';
		const title = tab?.title || '';
		if (!url || isRestrictedUrl(url)) return;
		runQueuedEvent(async () => {
			await ensureHydrated();
			const result = addToQueue(playlistQueue, {
				url,
				title: title || new URL(url).hostname,
			});
			if ('error' in result) return { success: false, error: result.error };
			playlistQueue = result;
			await saveQueue(playlistQueue);
			await broadcastQueue(playlistQueue);
			return { success: true };
		});
		return;
	}

	if (info.menuItemId === 'readit-play-queue') {
		runQueuedEvent(async () => {
			await ensureHydrated();
			const nextItem = getNextPending(playlistQueue);
			if (!nextItem) return { success: false, error: 'Queue trống.' };
			return playQueueItem(nextItem);
		});
		return;
	}

	if (info.menuItemId === 'readit-replay-queue') {
		runQueuedEvent(async () => {
			await ensureHydrated();
			if (playlistQueue.items.length === 0) return { success: false, error: 'Queue trống.' };
			playlistQueue = requeueAllItems(playlistQueue);
			await saveAndBroadcastQueue();
			const nextItem = getNextPending(playlistQueue);
			if (!nextItem) return { success: false, error: 'Không thể phát lại queue.' };
			return playQueueItem(nextItem);
		});
		return;
	}

	if (info.menuItemId === 'readit-add-pronunciation-rule') {
		const selectedText = (info.selectionText ?? '').trim();
		if (!selectedText) return;
		const settingsUrl = chrome.runtime.getURL(
			`src/settings/settings.html?match=${encodeURIComponent(selectedText)}`,
		);
		void chrome.tabs.create({ url: settingsUrl });
	}
});

chrome.commands.onCommand.addListener((command, tab) => {
	handleOpenSidePanelCommand(command, tab);
});

const openSidePanelPorts = new Map<number, chrome.runtime.Port>();

async function updateOpenSidePanelWindowsStorage() {
	const openWindowIds = computeOpenSidePanelWindowIds(openSidePanelPorts.keys());
	if (typeof chrome !== 'undefined' && chrome.storage?.local) {
		await chrome.storage.local.set({ readit_open_sidepanel_windows: openWindowIds });
	}
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name === DOCUMENT_READER_PORT_NAME) {
			const tabId = port.sender?.tab?.id;
			if (typeof tabId !== 'number') {
				port.disconnect();
				return;
			}
			port.onMessage.addListener((message: unknown) => {
				const sessionId =
					message && typeof message === 'object' && (message as { action?: unknown }).action === 'DOCUMENT_READER_ATTACH'
						? (message as { sessionId?: unknown }).sessionId
						: undefined;
				if (typeof sessionId !== 'string') {
					return;
				}
				runQueuedEvent(async () => {
					await ensureHydrated();
					await readableSurface.attachDocumentReader({
						tabId,
						sessionId,
						deliver: (nextMessage) => port.postMessage(nextMessage),
					});
				});
			});
			port.onDisconnect.addListener(() => {
				runQueuedEvent(() => readableSurface.detachDocumentReader(tabId));
			});
			return;
		}
		if (port.name === 'sidepanel-port') {
			const registerPort = (wId: number) => {
				openSidePanelPorts.set(wId, port);
				void updateOpenSidePanelWindowsStorage();
				port.onDisconnect.addListener(() => {
					if (openSidePanelPorts.get(wId) === port) {
						openSidePanelPorts.delete(wId);
						void updateOpenSidePanelWindowsStorage();
					}
				});
			};

			port.onMessage.addListener((msg: unknown) => {
				const message = msg as { action?: string; payload?: { windowId?: number } };
				if (message?.action === 'REGISTER_SIDEPANEL' && typeof message.payload?.windowId === 'number') {
					registerPort(message.payload.windowId);
				}
			});

			const tabWindowId = port.sender?.tab?.windowId;
			if (tabWindowId !== undefined && tabWindowId !== null && tabWindowId > 0) {
				registerPort(tabWindowId);
			} else if (typeof chrome !== 'undefined' && chrome.windows?.getCurrent) {
				chrome.windows.getCurrent((win) => {
					if (win?.id) {
						registerPort(win.id);
					}
				});
			}
		}
	});
}
