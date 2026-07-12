import { STORAGE_KEYS } from '../shared/constants';
import type { Article, PlaybackProgress, PlaybackSessionSnapshot, PlaybackStatus } from '../shared/types';
import { requestArticleFromTab } from './article_request';
import { applyPlaybackProgress, createPlaybackErrorSession, createPlaybackSession, ownsTab } from './playback_state';

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

type CommandResponse = { success: boolean; error?: string };
type OffscreenCommand = { action: string; payload?: unknown };

let activeSession: PlaybackSessionSnapshot | null = null;
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

function isPlaybackSessionSnapshot(value: unknown): value is PlaybackSessionSnapshot {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const session = value as Record<string, unknown>;
	return (
		typeof session.sessionId === 'string' &&
		isFiniteNumber(session.tabId) &&
		typeof session.title === 'string' &&
		typeof session.url === 'string' &&
		typeof session.lang === 'string' &&
		isPlaybackStatus(session.status) &&
		isFiniteNumber(session.currentParagraphIndex) &&
		isFiniteNumber(session.totalParagraphs) &&
		isFiniteNumber(session.progressPercentage) &&
		typeof session.voiceStyleId === 'string' &&
		isFiniteNumber(session.speed) &&
		(session.error === undefined || typeof session.error === 'string') &&
		isFiniteNumber(session.updatedAt)
	);
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
}

async function broadcastSession(session: PlaybackSessionSnapshot | null): Promise<void> {
	try {
		await chrome.runtime.sendMessage({ action: 'PLAYBACK_STATE_UPDATE', session });
	} catch (_error) {
		// The popup may be closed, so there may be no receiver for this broadcast.
	}
}

async function publishSession(session: PlaybackSessionSnapshot): Promise<void> {
	await chrome.storage.session.set({ [STORAGE_KEYS.PLAYBACK_SESSION]: session });
	await broadcastSession(session);
}

async function clearSession(): Promise<PlaybackSessionSnapshot | null> {
	const session = activeSession;
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
			tabId,
			title: title || url,
			url,
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

async function sendOffscreenCommand(message: OffscreenCommand): Promise<CommandResponse> {
	const response = (await chrome.runtime.sendMessage(message)) as CommandResponse | undefined;
	return response ?? { success: true };
}

async function stopActiveSession(_reason: string): Promise<void> {
	const session = await clearSession();
	if (!session) {
		return;
	}

	try {
		await sendOffscreenCommand({ action: 'STOP' });
	} catch (_error) {
		// Session state is already invalidated; tolerate a missing offscreen receiver.
	} finally {
		await closeOffscreen();
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

	await stopActiveSession('session-replaced');

	let articleResponse;
	try {
		articleResponse = await requestArticleFromTab(activeTab.id, {
			sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
			executeScript: (options) => chrome.scripting.executeScript(options),
		});
	} catch (_error) {
		await publishExtractionFailure(activeTab.id, activeTab.title, url);
		return { success: false, error: ERROR_MESSAGES.extraction };
	}

	if (!articleResponse.success || !isArticle(articleResponse.article)) {
		await publishExtractionFailure(activeTab.id, activeTab.title, url);
		return { success: false, error: ERROR_MESSAGES.extraction };
	}

	const voiceResult = (await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_VOICE)) as Record<string, unknown>;
	const speedResult = (await chrome.storage.local.get(STORAGE_KEYS.SPEED)) as Record<string, unknown>;
	const storedVoiceStyleId = voiceResult[STORAGE_KEYS.ACTIVE_VOICE];
	const storedSpeed = speedResult[STORAGE_KEYS.SPEED];
	const voiceStyleId = typeof storedVoiceStyleId === 'string' ? storedVoiceStyleId : DEFAULT_VOICE_STYLE_ID;
	const speed = isFiniteNumber(storedSpeed) ? storedSpeed : DEFAULT_SPEED;
	const session = createPlaybackSession({
		sessionId: crypto.randomUUID(),
		tabId: activeTab.id,
		title: articleResponse.article.title || activeTab.title || url,
		url: articleResponse.article.url || url,
		lang: articleResponse.article.lang,
		voiceStyleId,
		speed,
		now: Date.now(),
	});

	activeSession = session;
	await publishSession(session);

	try {
		await setupOffscreen();
		observeOffscreenPlay(session.sessionId, {
			action: 'PLAY',
			payload: { sessionId: session.sessionId, article: articleResponse.article, voiceStyleId, speed },
		});
		return { success: true };
	} catch (_error) {
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreen();
		return { success: false, error: ERROR_MESSAGES.setup };
	}
}

function observeOffscreenPlay(sessionId: string, command: OffscreenCommand): void {
	void sendOffscreenCommand(command).then(
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
		await closeOffscreen();
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
		return await sendOffscreenCommand({ action, ...(payload ? { payload } : {}) });
	} catch (_error) {
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreen();
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
		const response = await sendOffscreenCommand({ action: 'CHANGE_SPEED', payload: { speed } });
		if (response.success && activeSession) {
			activeSession = { ...activeSession, speed, updatedAt: Date.now() };
			await publishSession(activeSession);
		}
		return response;
	} catch (_error) {
		await failSession(ERROR_MESSAGES.setup);
		await closeOffscreen();
		return { success: false, error: ERROR_MESSAGES.setup };
	}
}

async function stopReading(): Promise<CommandResponse> {
	await ensureHydrated();
	await stopActiveSession('user-stop');
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
		await closeOffscreen();
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
	(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
		if (!message || typeof message !== 'object') {
			return undefined;
		}

		const msg = message as Record<string, unknown>;
		const action = msg.action;

		switch (action) {
			case 'GET_PLAYBACK_STATE':
				return respondFromQueue(getPlaybackState, sendResponse);

			case 'START_CURRENT_PAGE':
				return respondFromQueue(startCurrentPage, sendResponse);

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
