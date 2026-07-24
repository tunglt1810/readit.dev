import { MODEL_FILES, STORAGE_KEYS } from '../shared/constants';
import { isManualPlaybackControlMessage, isManualWordTimingMessage } from '../shared/manual_playback';
import { fetchWithCache, MODEL_CACHE_NAME } from '../shared/model_cache';
import { warmCache } from '../shared/warm_cache';
import { createModelCacheWarmer } from './model_cache_warmer';
import { registerModelCacheWarmLifecycle } from './model_cache_lifecycle';
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
import { requestActionPopup } from './action_popup';
import { requestArticleFromTab } from './article_request';
import { syncPlaybackBadge } from './badge';
import { prepareManualStart } from './manual_text';
import {
	type ManualCheckpointMetadata,
	type OffscreenCommand,
	sendOffscreenCommand,
} from './offscreen_transport';
import { requestPageInfoFromTab } from './page_info';
import {
	applyPlaybackProgress,
	createPlaybackErrorSession,
	createPlaybackSession,
	isPlaybackSessionSnapshot,
	ownsTab,
} from './playback_state';
import { createSelectedTextArticle } from './selected_text';
import { prepareSelectedTextRequest } from './selected_text_request';

const DEFAULT_VOICE_STYLE_ID = 'M1';
const DEFAULT_SPEED = 1.05;

const ERROR_MESSAGES = {
	activeTab: 'Không tìm thấy trang web đang hoạt động.',
	restrictedPage: 'Tiện ích không thể chạy trên trang này. Vui lòng sử dụng trên một trang web bài viết khác.',
	extraction: 'Không thể trích xuất nội dung từ trang web này. Vui lòng tải lại trang và thử lại.',
	noSession: 'Không có phiên đọc đang hoạt động.',
	setup: 'Không thể bắt đầu đọc trang này. Vui lòng thử lại.',
	invalidSpeed: 'Tốc độ đọc không hợp lệ.',
} as const;

type StartPlaybackInput =
	| {
			contentScope: 'article' | 'selection';
			source: { kind: 'tab'; tabId: number; title: string; url: string };
			content: PlaybackContent;
	  }
	| { contentScope: 'manual'; source: { kind: 'manual'; panelInstanceId: string }; content: PlaybackContent };

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

async function ensureHydrated(): Promise<void> {
	if (hydrated) {
		return;
	}

	const result = (await chrome.storage.session.get(STORAGE_KEYS.PLAYBACK_SESSION)) as Record<string, unknown>;
	const storedSession = result[STORAGE_KEYS.PLAYBACK_SESSION];
	activeSession = isPlaybackSessionSnapshot(storedSession) ? storedSession : null;
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
	activeSession = null;

	if (session?.source.kind === 'tab') {
		try {
			await chrome.tabs.sendMessage(session.source.tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: session.sessionId });
		} catch (_error) {
			// The content script may not be listening (e.g. the tab navigated away); ignore.
		}
	}

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

async function publishExtractionFailure(tabId: number, title: string | undefined, url: string): Promise<void> {
	await publishSession(
		createPlaybackErrorSession({
			sessionId: crypto.randomUUID(),
			source: { kind: 'tab', tabId, title: title || url, url },
			voiceStyleId: DEFAULT_VOICE_STYLE_ID,
			speed: DEFAULT_SPEED,
			error: ERROR_MESSAGES.extraction,
			now: Date.now(),
		}),
	);
	activeSession = null;
	await chrome.storage.session.remove(STORAGE_KEYS.PLAYBACK_SESSION);
}

// Helper to check if offscreen document is already created
async function hasOffscreenDocument(): Promise<boolean> {
	if ('getContexts' in chrome.runtime) {
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
	if (await hasOffscreenDocument()) {
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
	if (!(await hasOffscreenDocument())) {
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
			(message) => chrome.runtime.sendMessage(message),
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
			? createPlaybackSession({ ...sessionInput, contentScope: 'manual', source: input.source })
			: createPlaybackSession({ ...sessionInput, contentScope: input.contentScope, source: input.source });

	activeSession = session;
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
		observeOffscreenPlay(session.sessionId, {
			action: 'PLAY',
			payload: {
				sessionId: session.sessionId,
				article: input.content,
				voiceStyleId,
				speed,
				...(input.contentScope === 'manual' ? { panelInstanceId: input.source.panelInstanceId } : {}),
			},
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
		articleResponse = await requestArticleFromTab(activeTab.id, {
			sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
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

	if (!articleResponse.success || !isArticle(articleResponse.article)) {
		if (activeSession?.contentScope === 'manual') {
			return { success: false, error: ERROR_MESSAGES.extraction };
		}
		await stopActiveSession('session-replaced');
		await publishExtractionFailure(activeTab.id, activeTab.title, url);
		return { success: false, error: ERROR_MESSAGES.extraction };
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
	});
}

async function startManualText(payload: unknown): Promise<CommandResponse> {
	const prepared = prepareManualStart(payload);
	if (!prepared) {
		return { success: false, error: 'invalidManualText' };
	}
	const { panelInstanceId, ...content } = prepared;
	return startPlayback({ contentScope: 'manual', source: { kind: 'manual', panelInstanceId }, content });
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
		const response = await sendOffscreenCommand({ action, ...(payload ? { payload } : {}) }, (message) => chrome.runtime.sendMessage(message));
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
	await publishSession(activeSession);
	try {
		const response = await sendOffscreenCommand(
			{ action: 'RESUME_MANUAL_CHECKPOINT', payload: { panelInstanceId } },
			(message) => chrome.runtime.sendMessage(message),
		);
		if (!response.success) {
			throw new Error('Manual checkpoint is unavailable');
		}
		suspendedManualCheckpoint = null;
		suspendedManualSession = null;
		await broadcastManualCheckpointState(panelInstanceId, 'active');
		return { success: true };
	} catch (_error) {
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

async function relayWordHighlightUpdate(message: Record<string, unknown>): Promise<void> {
	await ensureHydrated();
	if (
		activeSession?.source.kind !== 'tab' ||
		typeof message.sessionId !== 'string' ||
		message.sessionId !== activeSession.sessionId ||
		typeof message.word !== 'string'
	) {
		return;
	}
	try {
		await chrome.tabs.sendMessage(activeSession.source.tabId, {
			action: 'WORD_HIGHLIGHT_UPDATE',
			sessionId: activeSession.sessionId,
			word: message.word,
			contentScope: activeSession.contentScope,
		});
	} catch (_error) {
		// The content script may not be listening (e.g. the tab navigated away); ignore.
	}
}

async function relayWordHighlightClear(message: Record<string, unknown>): Promise<void> {
	await ensureHydrated();
	if (activeSession?.source.kind !== 'tab' || typeof message.sessionId !== 'string' || message.sessionId !== activeSession.sessionId) {
		return;
	}
	try {
		await chrome.tabs.sendMessage(activeSession.source.tabId, { action: 'WORD_HIGHLIGHT_CLEAR', sessionId: activeSession.sessionId });
	} catch (_error) {
		// The content script may not be listening; ignore.
	}
}

async function relayManualWordHighlight(message: Record<string, unknown>): Promise<void> {
	await ensureHydrated();
	if (activeSession?.contentScope !== 'manual' || !isManualWordTimingMessage(message) || message.sessionId !== activeSession.sessionId) {
		return;
	}
	try {
		await chrome.runtime.sendMessage({
			action: 'MANUAL_WORD_HIGHLIGHT_UPDATE',
			sessionId: activeSession.sessionId,
			word: message.word,
			wordIndex: message.wordIndex,
		});
	} catch (_error) {
		// The Side Panel may be closed between the audible word event and the relay.
	}
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

			case 'CHANGE_SPEED':
				return respondFromQueue(() => changeSpeed(msg.payload), sendResponse);

			case 'PLAYBACK_PROGRESS_UPDATE':
				void enqueue(() => applyProgressMessage(msg));
				break;

			case 'WORD_HIGHLIGHT_UPDATE':
				void enqueue(() => relayWordHighlightUpdate(msg));
				break;

			case 'WORD_HIGHLIGHT_CLEAR':
				void enqueue(() => relayWordHighlightClear(msg));
				break;

			case 'OFFSCREEN_MANUAL_WORD_TIMING':
				void enqueue(() => relayManualWordHighlight(msg));
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
	if (changeInfo.status === 'loading' || changeInfo.url !== undefined) {
		void enqueue(() => stopIfOwner(tabId, 'tab-navigation'));
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
		});
	});
});

chrome.commands.onCommand.addListener((command) => {
	if (command === 'open_side_panel') {
		void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
			if (tab?.windowId) {
				void chrome.sidePanel.open({ windowId: tab.windowId });
			}
		});
	}
});

