import { computeOpenSidePanelWindowIds, handleOpenSidePanelCommand } from '../popup/side_panel';
import {
	DEFAULT_SPEED,
	GOOGLE_DOCS_EXPORT_UNAVAILABLE,
	MODEL_FILES,
	PDF_ERROR_CODES,
	type PdfErrorCode,
	STORAGE_KEYS,
} from '../shared/constants';
import { DOCUMENT_READER_PORT_NAME } from '../shared/document_reader.ts';
import { isManualPlaybackControlMessage } from '../shared/manual_playback';
import { fetchWithCache, MODEL_CACHE_NAME } from '../shared/model_cache';
import { isReadableSurfaceClearMessage, isReadableSurfaceInitMessage, isReadableSurfaceUpdateMessage } from '../shared/readable_surface';
import type {
	Article,
	CommandResponse,
	ManualPlaybackSessionSnapshot,
	PageInfoResponse,
	PlaybackContent,
	PlaybackProgress,
	PlaybackSessionSnapshot,
	PlaybackStatus,
} from '../shared/types';
import { warmCache } from '../shared/warm_cache';
import { requestActionPopup } from './action_popup';
import { type ArticleResponse, isMissingReceiverError, requestArticleFromTab } from './article_request';
import { syncPlaybackBadge } from './badge';
import { prepareManualStart } from './manual_text';
import { registerModelCacheWarmLifecycle } from './model_cache_lifecycle';
import { createModelCacheWarmer } from './model_cache_warmer';
import {
	type ManualCheckpointMetadata,
	type OffscreenCommand,
	type OffscreenPlayPayload,
	sendOffscreenCommand,
} from './offscreen_transport';
import { requestPageInfoFromTab } from './page_info';
import { extractPdfArticle } from './pdf_extractor';
import { loadPdfJsDocument } from './pdfjs_loader';
import {
	applyPlaybackProgress,
	createPlaybackErrorSession,
	createPlaybackSession,
	isPlaybackSessionSnapshot,
	isSameDocumentUrl,
	ownsTab,
} from './playback_state';
import { createReadableSurfaceCoordinator } from './readable_surface';
import { createSelectedTextArticle } from './selected_text';
import { prepareSelectedTextRequest } from './selected_text_request';

const DEFAULT_VOICE_STYLE_ID = 'M1';

const ERROR_MESSAGES = {
	activeTab: 'Không tìm thấy trang web đang hoạt động.',
	restrictedPage: 'Tiện ích không thể chạy trên trang này. Vui lòng sử dụng trên một trang web bài viết khác.',
	extraction: 'Không thể trích xuất nội dung từ trang web này. Vui lòng tải lại trang và thử lại.',
	noSession: 'Không có phiên đọc đang hoạt động.',
	setup: 'Không thể bắt đầu đọc trang này. Vui lòng thử lại.',
	invalidSpeed: 'Tốc độ đọc không hợp lệ.',
} as const;

function getExtractionError(error: string | undefined): string {
	if (error === GOOGLE_DOCS_EXPORT_UNAVAILABLE) return error;
	if (error && Object.values(PDF_ERROR_CODES).includes(error as PdfErrorCode)) return error;
	return ERROR_MESSAGES.extraction;
}

type StartPlaybackInput =
	| {
			contentScope: 'article';
			source: { kind: 'tab'; tabId: number; title: string; url: string };
			content: PlaybackContent;
			readableSurface: 'website-dom' | 'document-reader' | 'none';
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
let stateQueue = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
	const next = stateQueue.then(operation);
	stateQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

const readableSurface = createReadableSurfaceCoordinator({
	sendTabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
	sendRuntimeMessage: (message) => chrome.runtime.sendMessage(message),
	requestDocumentReaderSnapshot: async (sessionId) => {
		const response = await sendOffscreenCommand({ action: 'GET_DOCUMENT_READER_SNAPSHOT', payload: { sessionId } }, (message) =>
			chrome.runtime.sendMessage(message),
		);
		return response.success ? (response.snapshot ?? null) : null;
	},
	detachDocumentReader: async (sessionId) => {
		await sendOffscreenCommand({ action: 'DETACH_DOCUMENT_READER', payload: { sessionId } }, (message) =>
			chrome.runtime.sendMessage(message),
		);
	},
	enqueue: (operation) => {
		void enqueue(operation);
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

async function requestCurrentTabArticle(tabId: number, title: string | undefined, url: string): Promise<ArticleResponse> {
	const requestPdfFallback = () =>
		extractPdfArticle(
			{ url, title: title || url },
			{
				fetchPdf: (sourceUrl, init) => globalThis.fetch(sourceUrl, init),
				isFileSchemeAccessAllowed: () => chrome.extension.isAllowedFileSchemeAccess(),
				loadDocument: loadPdfJsDocument,
			},
		);

	try {
		const articleResponse = await requestArticleFromTab(tabId, {
			sendMessage: (targetTabId, message) => chrome.tabs.sendMessage(targetTabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
		if (articleResponse.success && isArticle(articleResponse.article) && isArticleReadableSurface(articleResponse.readableSurface)) {
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

	const result = (await chrome.storage.session.get(STORAGE_KEYS.PLAYBACK_SESSION)) as Record<string, unknown>;
	const storedSession = result[STORAGE_KEYS.PLAYBACK_SESSION];
	activeSession = isPlaybackSessionSnapshot(storedSession) ? storedSession : null;
	if (activeSession) {
		readableSurface.activate(activeSession);
	}
	hydrated = true;

	if (storedSession !== undefined && activeSession === null) {
		await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
	}

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

// Helper to check if offscreen document is already created
async function hasOffscreenDocument(): Promise<boolean> {
	if (typeof chrome.offscreen === 'undefined') {
		return false;
	}
	if ('getContexts' in chrome.runtime && typeof chrome.runtime.getContexts === 'function') {
		const contexts = await chrome.runtime.getContexts({
			contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
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
async function setupOffscreen(): Promise<void> {
	if (typeof chrome.offscreen === 'undefined' || (await hasOffscreenDocument())) {
		return;
	}

	try {
		await chrome.offscreen.createDocument({
			url: 'src/offscreen/offscreen.html',
			reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
			justification: 'Local ONNX TTS model speech generation and playback.',
		});
	} catch (error) {
		if (!(await hasOffscreenDocument())) {
			throw error;
		}
	}
}

// Close offscreen document
async function closeOffscreen(): Promise<void> {
	if (typeof chrome.offscreen === 'undefined' || !(await hasOffscreenDocument())) {
		return;
	}

	try {
		await chrome.offscreen.closeDocument();
	} catch (_error) {
		// The document may already be closed.
	}
}

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
		const response = await sendOffscreenCommand({ action: 'GET_MANUAL_CHECKPOINT_METADATA' }, (message) =>
			chrome.runtime.sendMessage(message),
		);
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
	if (activeSession === null && !(await getSuspendedManualCheckpoint())) {
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
	const session = await clearSession();
	if (!session) {
		return;
	}

	try {
		await sendOffscreenCommand({ action: 'STOP' }, (message) => chrome.runtime.sendMessage(message));
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
	const manual = activeSession;
	if (manual?.contentScope !== 'manual') {
		return { success: true };
	}
	const panelInstanceId = manual.source.panelInstanceId;
	try {
		const response = await sendOffscreenCommand(
			{ action: 'CHECKPOINT_MANUAL', payload: { sessionId: manual.sessionId, panelInstanceId } },
			(message) => chrome.runtime.sendMessage(message),
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
		await sendOffscreenCommand({ action: 'DISCARD_MANUAL_CHECKPOINT', payload: { panelInstanceId } }, (message) =>
			chrome.runtime.sendMessage(message),
		);
	} catch (_error) {
		// Closing the Side Panel still needs to discard the background-only owner state.
	}
	suspendedManualCheckpoint = null;
	suspendedManualSession = null;
	await broadcastManualCheckpointState(panelInstanceId, 'discarded');
	return true;
}

async function startPlayback(input: StartPlaybackInput): Promise<CommandResponse> {
	await ensureHydrated();
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

	const preferences = (await chrome.storage.local.get([STORAGE_KEYS.ACTIVE_VOICE, STORAGE_KEYS.SPEED])) as Record<string, unknown>;
	const storedVoiceStyleId = preferences[STORAGE_KEYS.ACTIVE_VOICE];
	const storedSpeed = preferences[STORAGE_KEYS.SPEED];
	const voiceStyleId = typeof storedVoiceStyleId === 'string' ? storedVoiceStyleId : DEFAULT_VOICE_STYLE_ID;
	const speed = isFiniteNumber(storedSpeed) ? storedSpeed : DEFAULT_SPEED;
	const sessionInput = {
		sessionId: crypto.randomUUID(),
		lang: input.content.lang,
		voiceStyleId,
		speed,
		now: Date.now(),
	};
	const session =
		input.contentScope === 'manual'
			? createPlaybackSession({
					...sessionInput,
					contentScope: 'manual',
					source: input.source,
					readableSurface: input.readableSurface,
				})
			: input.contentScope === 'article'
				? createPlaybackSession({
						...sessionInput,
						contentScope: 'article',
						source: input.source,
						readableSurface: input.readableSurface,
					})
				: createPlaybackSession({
						...sessionInput,
						contentScope: 'selection',
						source: input.source,
						readableSurface: input.readableSurface,
					});

	activeSession = session;
	readableSurface.activate(session);
	await publishSession(session);

	try {
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
		await setupOffscreen();
		const playPayload: OffscreenPlayPayload = {
			sessionId: session.sessionId,
			article: input.content,
			voiceStyleId,
			speed,
			readableSurface: input.readableSurface,
			...(input.source.kind === 'tab' ? { contentScope: input.contentScope } : {}),
			...(input.contentScope === 'manual' ? { panelInstanceId: input.source.panelInstanceId } : {}),
			...(input.readableSurface === 'document-reader' && input.source.kind === 'tab' ? { documentTitle: input.source.title } : {}),
		};
		observeOffscreenPlay(session.sessionId, {
			action: 'PLAY',
			payload: playPayload,
		});
		return { success: true };
	} catch (_error) {
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreenWhenIdle();
		return { success: false, error: ERROR_MESSAGES.setup };
	}
}

async function startCurrentPage(): Promise<CommandResponse> {
	await ensureHydrated();
	const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

	if (!activeTab || typeof activeTab.id !== 'number') {
		return { success: false, error: ERROR_MESSAGES.activeTab };
	}

	const url = activeTab.url ?? '';
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

	if (!articleResponse.success || !isArticle(articleResponse.article) || !isArticleReadableSurface(articleResponse.readableSurface)) {
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
			url: articleResponse.article.url || url,
		},
		content: articleResponse.article,
		readableSurface: articleResponse.readableSurface,
	});
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

function observeOffscreenPlay(sessionId: string, command: OffscreenCommand): void {
	void sendOffscreenCommand(command, (message) => chrome.runtime.sendMessage(message)).then(
		(response) => {
			if (!response.success) {
				void failPendingStart(sessionId);
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
	if (!activeSession) {
		return { success: false, error: ERROR_MESSAGES.noSession };
	}

	const payload = action === 'PLAY' ? { sessionId: activeSession.sessionId } : undefined;
	try {
		const response = await sendOffscreenCommand({ action, ...(payload ? { payload } : {}) }, (message) =>
			chrome.runtime.sendMessage(message),
		);
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
	if (!activeSession) {
		return { success: false, error: ERROR_MESSAGES.noSession };
	}

	const speed = (payload as { speed?: unknown } | undefined)?.speed;
	if (!isFiniteNumber(speed)) {
		return { success: false, error: ERROR_MESSAGES.invalidSpeed };
	}

	try {
		const response = await sendOffscreenCommand({ action: 'CHANGE_SPEED', payload: { speed } }, (message) =>
			chrome.runtime.sendMessage(message),
		);
		if (response.success && activeSession) {
			activeSession = { ...activeSession, speed, updatedAt: Date.now() };
			await publishSession(activeSession);
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
		const response = await sendOffscreenCommand({ action: 'RESUME_MANUAL_CHECKPOINT', payload: { panelInstanceId } }, (message) =>
			chrome.runtime.sendMessage(message),
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
		await clearSession();
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

// Handle runtime messages
chrome.runtime.onMessage.addListener(
	(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
		if (!message || typeof message !== 'object') {
			return undefined;
		}

		const msg = message as Record<string, unknown>;
		const action = msg.action;

		switch (action) {
			case 'GET_PLAYBACK_STATE':
				return respondFromQueue(getPlaybackState, sendResponse);

			case 'GET_CURRENT_PAGE_INFO':
				return respondFromQueue(getCurrentPageInfo, sendResponse);

			case 'START_CURRENT_PAGE':
				return respondFromQueue(startCurrentPage, sendResponse);

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

			case 'OPEN_DOCUMENT_READER':
				return respondFromQueue(openDocumentReader, sendResponse);

			case 'CHANGE_SPEED':
				return respondFromQueue(() => changeSpeed(msg.payload), sendResponse);

			case 'PLAYBACK_PROGRESS_UPDATE':
				void enqueue(() => applyProgressMessage(msg));
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
					void enqueue(async () => {
						await ensureHydrated();
						readableSurface.advance(msg);
					});
				}
				break;

			case 'READABLE_SURFACE_CLEAR':
				if (isReadableSurfaceClearMessage(msg)) {
					void enqueue(async () => {
						await ensureHydrated();
						await readableSurface.clear(msg.sessionId);
					});
				}
				break;

			default:
				break;
		}

		return undefined;
	},
);

chrome.tabs.onRemoved.addListener((tabId) => {
	void enqueue(() => stopIfOwner(tabId, 'tab-removed'));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	// Checked on `complete` as well as `loading`: while a navigation is still loading the tab can
	// still report the URL it is leaving, and that update is the only other chance to notice.
	if (changeInfo.status !== undefined || changeInfo.url !== undefined) {
		void enqueue(() => stopIfNavigatedAway(tabId));
	}
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
	chrome.contextMenus.create({
		id: 'read-selected-text',
		title: 'Đọc phần văn bản đã chọn',
		contexts: ['selection'],
		documentUrlPatterns: ['http://*/*', 'https://*/*'],
	});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId !== 'read-selected-text' || typeof tab?.id !== 'number') {
		return;
	}

	void enqueue(async () => {
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
		return startPlayback({
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
	});
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
				void enqueue(async () => {
					await ensureHydrated();
					await readableSurface.attachDocumentReader({
						tabId,
						sessionId,
						deliver: (nextMessage) => port.postMessage(nextMessage),
					});
				});
			});
			port.onDisconnect.addListener(() => {
				void enqueue(() => readableSurface.detachDocumentReader(tabId));
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
