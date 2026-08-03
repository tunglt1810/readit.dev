import {
	isAudioExportEstimate,
	isAudioExportOffscreenAction,
	isInternalAudioExportOffscreenCommand,
} from '../shared/audio_export.ts';
import { deleteAudioExportHandle, takeAudioExportHandle } from '../shared/audio_export_handle_store.ts';
import { MODEL_FILES, VOICE_STYLES } from '../shared/constants';
import type { DocumentReaderSnapshot } from '../shared/document_reader.ts';
import { isPanelInstanceId } from '../shared/manual_playback';
import { buildReadableSurfaceWords } from '../shared/readable_surface.ts';
import type { PlaybackContent, PlaybackContentScope, PlaybackProgress, PlaybackStatus, ReadableSurfaceKind } from '../shared/types';
import { createSpeechAudioBuffer, synthesizeSpeechUnitSamples } from './audio';
import { createAudioExportEncoder } from './audio_export_encoder.ts';
import { AudioExportEngine } from './audio_export_engine.ts';
import { estimateSpeechUnits } from './audio_export_estimate';
import { canStartBackgroundSynthesis, type PlaybackRunway } from './audio_export_runway';
import { captureManualCheckpoint, isCheckpointOwner, type ManualCheckpoint, resumeOffsetSeconds } from './manual_checkpoint';
import { createPauseKeepalive } from './pause_keepalive';
import { METRICS_STORAGE_KEY, PlaybackMetricsRecorder, summarizePlaybackMetrics } from './playback_metrics';
import { isVietnameseLanguage, preparePlaybackUnits, VietnameseTextNormalizer } from './playback_preparation';
import { createSingleFlight } from './single_flight';
import type { SpeechUnit } from './speech_unit';
import { SynthesisArbiter } from './synthesis_arbiter';
import { loadTextToSpeech, loadVoiceStyle, Style, TextToSpeech } from './supertonic_helper';
import { IndexedSynthesisCoordinator, type SynthesisKey } from './synthesis_coordinator';
import { loadVietnameseNormalizerAssets } from './vietnamese/assets';
import { normalizeVietnameseText } from './vietnamese/normalizer';
import { computeReadableSurfaceWordTimings, findWordAtTime, type WordTimingWindow } from './word_timing';
import {
	emitAudioHostMessage,
	requestAudioHostMessage,
} from './audio_host_messages.ts';

// Global Engine State
let ttsEngine: TextToSpeech | null = null;
let currentStyle: Style | null = null;
let currentStyleId = '';

// Audio Playback State
let audioCtx: AudioContext | null = null;
let isPaused = false;
let playbackStatus: PlaybackStatus = 'stopped';
let currentSpeed = 1.05;
let playbackSession = 0;
let currentExtensionSessionId: string | null = null;
let speedVersion = 0;

// Pipelining Queue state
let speechUnits: SpeechUnit[] = [];
let currentUnitIndex = 0;
let currentSourceNode: AudioBufferSourceNode | null = null;
let currentSourceId = 0;
let currentBuffer: AudioBuffer | null = null;
let currentBufferStartedAt = 0;
let currentBufferOffsetSec = 0;
let currentManualPanelInstanceId: string | null = null;
let currentPlaybackLanguage: string | null = null;
let currentPlaybackStyle: Style | null = null;
let currentVoiceStyleId = '';
let currentWordIndex = -1;
let currentReadableSurface: ReadableSurfaceKind = 'none';
let currentReadableSurfaceContentScope: PlaybackContentScope = 'article';
let currentDocumentReader: Omit<DocumentReaderSnapshot, 'currentWordIndex'> | null = null;
const recentSynthesisMilliseconds: number[] = [];

type PendingManualPlayback = {
	sessionId: string;
	panelInstanceId: string;
	article: PlaybackContent;
	voiceStyleId: string;
	speed: number;
};

let pendingManualPlayback: PendingManualPlayback | null = null;

type RuntimeManualCheckpoint = ManualCheckpoint & {
	lang: string;
	style: Style | null;
	voiceStyleId: string;
	speed: number;
	speechUnits: SpeechUnit[];
	buffer: AudioBuffer | null;
	pendingArticle: PlaybackContent | null;
};

let manualCheckpoint: RuntimeManualCheckpoint | null = null;

const pauseKeepalive = createPauseKeepalive(
	() => new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(),
	{
		setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimeout: (handle) => window.clearTimeout(handle),
	},
);

// Initialize Storage Persistence
async function initStorage() {
	try {
		if (navigator.storage && navigator.storage.persist) {
			await navigator.storage.persist();
		}
	} catch (_error) {
		// Storage persist request failed or was denied
	}
}

// Request persistent storage on load
initStorage();

const playbackMetrics = new PlaybackMetricsRecorder();
const exportRunwayWaiters = new Set<() => void>();

type AudioExportDownload = (blob: Blob, filename: string) => Promise<void>;
let audioExportDownload: AudioExportDownload | null = null;

export function configureAudioExportDownload(download: AudioExportDownload | null): void {
	audioExportDownload = download;
}

function notifyExportRunway(): void {
	for (const resolve of exportRunwayWaiters) {
		resolve();
	}
	exportRunwayWaiters.clear();
}

function waitForExportRunway(): Promise<void> {
	return new Promise((resolve) => exportRunwayWaiters.add(resolve));
}

/**
 * Persist the Phase 0 baseline numbers where they can be read from outside this document:
 * E2E drives the extension through the service worker and cannot reach the offscreen page.
 *
 * Called after each unit starts (not only at the end of the article) so the numbers are
 * readable mid-playback; the recorder accumulates until the next play request resets it.
 */
function flushPlaybackMetrics() {
	if (!playbackMetrics.hasSamples()) {
		return;
	}
	const summary = summarizePlaybackMetrics(playbackMetrics.snapshot());
	console.info('[readit] playback metrics', JSON.stringify(summary));
	try {
		void chrome.storage.local.set({ [METRICS_STORAGE_KEY]: summary });
	} catch (_error) {
		// Diagnostics only — a storage failure must never affect playback.
	}
}

// Readable from the offscreen document's own devtools console while playback is running.
(globalThis as unknown as { __readitPlaybackMetrics?: () => unknown }).__readitPlaybackMetrics = () =>
	summarizePlaybackMetrics(playbackMetrics.snapshot());

(globalThis as unknown as { __readitPlaybackDebug?: () => unknown }).__readitPlaybackDebug = () => ({
	sessionId: currentExtensionSessionId,
	sourceId: currentSourceId,
	bufferOffsetSec: currentBufferOffsetSec,
	audioContextTime: audioCtx?.currentTime ?? null,
	pauseKeepalive: pauseKeepalive.getDebugState(),
	backgroundSynthesisAllowed: canStartBackgroundSynthesis(playbackRunway()),
});

/**
 * Report playback progress to background/popup
 */
function reportProgress(status: PlaybackStatus, extra: Partial<PlaybackProgress> = {}) {
	playbackStatus = status;
	notifyExportRunway();
	const progress: PlaybackProgress = {
		status,
		currentParagraphIndex: currentUnitIndex,
		totalParagraphs: speechUnits.length,
		progressPercentage: speechUnits.length > 0 ? Math.round((currentUnitIndex / speechUnits.length) * 100) : 0,
		...extra,
	};

	emitAudioHostMessage({
		action: 'PLAYBACK_PROGRESS_UPDATE',
		sessionId: currentExtensionSessionId,
		progress,
	});
}

/**
 * Initialize TTS models (WebGPU with WebAssembly fallback)
 */
const loadModels = createSingleFlight(async () => {
	try {
		// Try WebGPU first
		let executionProvider = 'webgpu';

		try {
			const result = await loadTextToSpeech(
				MODEL_FILES,
				{
					executionProviders: ['webgpu'],
					graphOptimizationLevel: 'all',
				},
				(loaded, total, modelName) => {
					emitAudioHostMessage({
						action: 'MODEL_LOADING_PROGRESS',
						progress: { loaded, total, modelName },
					});
				},
			);
			ttsEngine = result.textToSpeech;
			executionProvider = 'webgpu';
		} catch (_webgpuError) {
			// Fallback to WebAssembly
			const result = await loadTextToSpeech(
				MODEL_FILES,
				{
					executionProviders: ['wasm'],
					graphOptimizationLevel: 'all',
				},
				(loaded, total, modelName) => {
					emitAudioHostMessage({
						action: 'MODEL_LOADING_PROGRESS',
						progress: { loaded, total, modelName },
					});
				},
			);
			ttsEngine = result.textToSpeech;
			executionProvider = 'wasm';
		}
		playbackMetrics.recordExecutionProvider(executionProvider);
		emitAudioHostMessage({ action: 'MODEL_LOADED', executionProvider });
	} catch (error) {
		const err = error as Error;
		emitAudioHostMessage({ action: 'MODEL_LOAD_FAILED', error: err.message });
		throw err;
	}
});

function initModels(): Promise<void> {
	if (ttsEngine) {
		emitAudioHostMessage({ action: 'MODEL_LOADED', executionProvider: 'cached' });
		return Promise.resolve();
	}
	return loadModels();
}

/**
 * Load Voice Style JSON from extension assets
 */
async function getVoiceStyle(styleId: string): Promise<Style> {
	if (currentStyle && currentStyleId === styleId) {
		return currentStyle;
	}

	const voice = VOICE_STYLES.find((v) => v.id === styleId) || VOICE_STYLES[0];
	const url = chrome.runtime.getURL(voice.path);
	currentStyle = await loadVoiceStyle([url]);
	currentStyleId = styleId;
	return currentStyle;
}

/**
 * Synthesize a single speech unit to an AudioBuffer
 */
type SynthesisOwner = 'playback' | 'export';

async function synthesizeUnit(unit: SpeechUnit, lang: string, style: Style, speed: number, owner: SynthesisOwner): Promise<AudioBuffer> {
	if (!ttsEngine) {
		throw new Error('TTS Engine is not initialized');
	}
	const engine = ttsEngine;
	const synthesisStartedAtMs = performance.now();
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
	}
	const inferStartedAtMs = performance.now();
	const wav = await synthesizeSpeechUnitSamples(
		unit,
		lang,
		speed,
		async (text, requestedLang, steps, requestedSpeed, silenceDuration) => {
			const result = await engine.call(text, requestedLang, style, steps, requestedSpeed, silenceDuration);
			return result.wav;
		},
	);
	if (owner === 'playback') {
		playbackMetrics.recordInferDuration(performance.now() - inferStartedAtMs);
	}

	const buffer = createSpeechAudioBuffer(audioCtx, wav, engine.sampleRate, unit.pauseAfterMs ?? 0);
	if (owner === 'playback') {
		const synthesisMilliseconds = performance.now() - synthesisStartedAtMs;
		playbackMetrics.recordSynthDuration(synthesisMilliseconds);
		recentSynthesisMilliseconds.push(synthesisMilliseconds);
		if (recentSynthesisMilliseconds.length > 5) {
			recentSynthesisMilliseconds.shift();
		}
	}
	return buffer;
}

interface SynthesisInput {
	unit: SpeechUnit;
	lang: string;
	style: Style;
	speed: number;
	owner: SynthesisOwner;
}

const synthesisArbiter = new SynthesisArbiter<SynthesisInput, AudioBuffer>(({ unit, lang, style, speed, owner }) =>
	synthesizeUnit(unit, lang, style, speed, owner),
);

const synthesisCoordinator = new IndexedSynthesisCoordinator<SynthesisInput, AudioBuffer>(
	(input) => synthesisArbiter.foreground(input),
	{ onResolved: () => notifyExportRunway() },
);

function synthesisKey(session: number, unitIndex: number): SynthesisKey {
	return { session, unitIndex, speedVersion };
}

function isCurrentSynthesisKey(key: SynthesisKey): boolean {
	return (
		currentExtensionSessionId !== null &&
		key.session === playbackSession &&
		key.unitIndex === currentUnitIndex &&
		key.speedVersion === speedVersion
	);
}

function retainedSynthesisKeys(session: number): SynthesisKey[] {
	const keys = [synthesisKey(session, currentUnitIndex)];
	if (currentUnitIndex + 1 < speechUnits.length) {
		keys.push(synthesisKey(session, currentUnitIndex + 1));
	}
	return keys;
}

function playbackRunway(): PlaybackRunway {
	const nextUnitIndex = currentUnitIndex + 1;
	const nextBuffer =
		currentExtensionSessionId !== null && nextUnitIndex < speechUnits.length
			? (synthesisCoordinator.peekResolved(synthesisKey(playbackSession, nextUnitIndex))?.duration ?? null)
			: null;
	return {
		active: currentExtensionSessionId !== null,
		status: playbackStatus,
		currentRemainingSeconds: currentBuffer ? Math.max(currentBuffer.duration - currentBufferElapsedSec(), 0) : 0,
		nextBufferSeconds: nextBuffer,
		recentSynthesisMilliseconds,
	};
}

const audioExportEngine = new AudioExportEngine({
	takeHandle: takeAudioExportHandle,
	deleteHandle: deleteAudioExportHandle,
	createEncoder: createAudioExportEncoder,
	download: (blob, filename) => {
		if (!audioExportDownload) {
			return Promise.reject(new Error('Audio export download is unavailable'));
		}
		return audioExportDownload(blob, filename);
	},
	canDownload: () => audioExportDownload !== null,
	synthesize: ({ unit, language, style, speed }) => synthesisArbiter.background({ unit, lang: language, style, speed, owner: 'export' }),
	canStartBackgroundSynthesis: () => canStartBackgroundSynthesis(playbackRunway()),
	waitForRunway: waitForExportRunway,
	wakeRunway: notifyExportRunway,
	onProgress: (progress) => {
		emitAudioHostMessage({ action: 'AUDIO_EXPORT_PROGRESS', progress });
	},
	now: () => performance.now(),
});

function prefetchNextUnit(lang: string, style: Style, session: number): void {
	const unitIndex = currentUnitIndex + 1;
	if (unitIndex >= speechUnits.length) {
		return;
	}
	const key = synthesisKey(session, unitIndex);
	synthesisCoordinator.retain(retainedSynthesisKeys(session));
	synthesisCoordinator.prefetch(key, {
		unit: speechUnits[unitIndex],
		lang,
		style,
		speed: currentSpeed,
		owner: 'playback',
	});
}

function stopCurrentSource() {
	if (!currentSourceNode) {
		return;
	}

	const source = currentSourceNode;
	currentSourceNode = null;
	try {
		source.stop();
		source.disconnect();
	} catch (_e) {
		// already stopped or not started
	}
}

let wordHighlightTimer: ReturnType<typeof setInterval> | null = null;
let lastReadableSurfaceWordIndex = -1;
let surfaceReady = false;

function isReadableSurfaceKind(value: unknown): value is ReadableSurfaceKind {
	return value === 'website-dom' || value === 'manual-reader' || value === 'document-reader' || value === 'none';
}

function resetHighlightTimer() {
	if (wordHighlightTimer !== null) {
		clearInterval(wordHighlightTimer);
		wordHighlightTimer = null;
	}
	lastReadableSurfaceWordIndex = -1;
}

function clearWordHighlightTracking() {
	resetHighlightTimer();
	if (surfaceReady && currentExtensionSessionId) {
		emitAudioHostMessage({ action: 'READABLE_SURFACE_CLEAR', sessionId: currentExtensionSessionId });
	}
	surfaceReady = false;
}

function wordIndexBase(unitIndex: number): number {
	return speechUnits.slice(0, unitIndex).reduce((count, unit) => count + (unit.wordMap?.length ?? 0), 0);
}

async function initializeReadableSurface(session: number): Promise<void> {
	const words = currentReadableSurface === 'none' ? [] : buildReadableSurfaceWords(speechUnits);
	if (currentReadableSurface === 'document-reader' && currentDocumentReader) {
		currentDocumentReader = { ...currentDocumentReader, words };
	}
	surfaceReady = false;
	if (!currentExtensionSessionId || currentReadableSurface === 'none' || currentReadableSurface === 'document-reader' || words.length === 0) {
		return;
	}
	try {
		const response = (await requestAudioHostMessage({
			action: 'READABLE_SURFACE_INIT',
			sessionId: currentExtensionSessionId,
			contentScope: currentReadableSurfaceContentScope,
			words,
		})) as { success?: unknown };
		if (session === playbackSession) {
			surfaceReady = response?.success === true;
		}
	} catch (_error) {
		if (session === playbackSession) {
			surfaceReady = false;
		}
	}
}

function startWordHighlightTracking(windows: WordTimingWindow[], unitStartTime: number, offsetSec: number, unitIndex: number) {
	resetHighlightTimer();
	if (windows.length === 0 || !audioCtx) {
		return;
	}
	const base = wordIndexBase(unitIndex);
	playbackMetrics.beginHighlightTracking();
	wordHighlightTimer = setInterval(() => {
		if (!audioCtx) {
			return;
		}
		playbackMetrics.recordHighlightTick(performance.now());
		const elapsed = audioCtx.currentTime - unitStartTime + offsetSec;
		const wordTiming = findWordAtTime(windows, elapsed);
		if (wordTiming === null) {
			return;
		}
		const wordIndex = base + wordTiming.wordIndex;
		currentWordIndex = wordIndex;
		if (!surfaceReady || !currentExtensionSessionId || wordIndex === lastReadableSurfaceWordIndex) {
			return;
		}
		lastReadableSurfaceWordIndex = wordIndex;
		void chrome.runtime
			.sendMessage({
				action: 'READABLE_SURFACE_UPDATE',
				sessionId: currentExtensionSessionId,
				word: wordTiming.text,
				wordIndex,
			})
			.catch(() => undefined);
	}, 50);
}

/**
 * Stop active audio and clear state
 */
function stopAudio(options?: { completedNaturally?: boolean }) {
	void pauseKeepalive.stop();
	stopCurrentSource();
	clearWordHighlightTracking();
	flushPlaybackMetrics();
	isPaused = false;
	synthesisCoordinator.clear();
	recentSynthesisMilliseconds.length = 0;
	reportProgress('stopped', options?.completedNaturally ? { completedNaturally: true } : {});
	speechUnits = [];
	currentUnitIndex = 0;
	currentBuffer = null;
	currentBufferStartedAt = 0;
	currentBufferOffsetSec = 0;
	currentManualPanelInstanceId = null;
	currentReadableSurface = 'none';
	currentReadableSurfaceContentScope = 'article';
	currentDocumentReader = null;
	currentPlaybackLanguage = null;
	currentPlaybackStyle = null;
	currentVoiceStyleId = '';
	currentWordIndex = -1;
	pendingManualPlayback = null;
	currentExtensionSessionId = null;
	notifyExportRunway();
}

/**
 * Play a synthesized AudioBuffer
 */
function playAudioBuffer(
	buffer: AudioBuffer,
	lang: string,
	style: Style,
	session: number,
	unitIndex: number,
	offsetSec = 0,
) {
	// Split from one combined guard so a refusal names its cause: each of these silently drops
	// a whole unit, which is heard as missing text.
	if (!audioCtx) {
		playbackMetrics.recordDroppedStart(unitIndex, 'no-audio-context');
		return;
	}
	if (currentSourceNode !== null) {
		playbackMetrics.recordDroppedStart(unitIndex, 'source-already-playing');
		return;
	}
	if (session !== playbackSession) {
		playbackMetrics.recordDroppedStart(unitIndex, 'stale-session');
		return;
	}
	if (unitIndex !== currentUnitIndex) {
		playbackMetrics.recordDroppedStart(unitIndex, 'stale-unit-index');
		return;
	}
	const sourceOffsetSec = resumeOffsetSeconds({ bufferDurationSec: buffer.duration, elapsedSec: offsetSec });

	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.connect(audioCtx.destination);
	currentSourceNode = source;
	currentSourceId++;
	currentBuffer = buffer;
	currentBufferOffsetSec = sourceOffsetSec;
	currentBufferStartedAt = audioCtx.currentTime;

	reportProgress('playing');

	source.onended = () => {
		if (
			currentSourceNode !== source ||
			session !== playbackSession ||
			unitIndex !== currentUnitIndex ||
			playbackStatus === 'stopped' ||
			isPaused
		) {
			return;
		}

		if (audioCtx) {
			playbackMetrics.recordUnitEnded(audioCtx.currentTime);
		}
		currentSourceNode = null;
		currentBuffer = null;
		currentBufferStartedAt = 0;
		currentBufferOffsetSec = 0;
		currentUnitIndex = unitIndex + 1;
		if (currentUnitIndex < speechUnits.length) {
			void playNextUnit(lang, style, session);
		} else {
			stopAudio({ completedNaturally: true });
		}
	};

	const unit = speechUnits[unitIndex];
	const spokenDurationSec = Math.max(buffer.duration - (unit?.pauseAfterMs ?? 0) / 1000, 0);
	const windows = computeReadableSurfaceWordTimings(currentReadableSurface, unit?.wordMap ?? [], spokenDurationSec);
	const unitStartTime = audioCtx.currentTime;
	source.start(0, sourceOffsetSec);
	playbackMetrics.recordUnitStart(unitIndex, unitStartTime, performance.now(), buffer.duration, sourceOffsetSec);
	startWordHighlightTracking(windows, unitStartTime, sourceOffsetSec, unitIndex);
	// Flushed here rather than in `onended`: this point is after the gap has been measured,
	// so the write cost lands mid-unit instead of on the boundary being measured.
	flushPlaybackMetrics();
}

async function playNextUnit(lang: string, style: Style, session: number) {
	if (session !== playbackSession) {
		return;
	}

	if (currentUnitIndex >= speechUnits.length) {
		stopAudio({ completedNaturally: true });
		return;
	}

	const unitIndex = currentUnitIndex;
	const key = synthesisKey(session, unitIndex);
	const input: SynthesisInput = {
		unit: speechUnits[unitIndex],
		lang,
		style,
		speed: currentSpeed,
		owner: 'playback',
	};
	synthesisCoordinator.retain(retainedSynthesisKeys(session));
	reportProgress('loading');

	try {
		const buffer = await synthesisCoordinator.get(key, input);
		if (!isCurrentSynthesisKey(key)) {
			if (key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion !== speedVersion) {
				void playNextUnit(lang, style, session);
			}
			return;
		}
		playAudioBuffer(buffer, lang, style, session, unitIndex);
		prefetchNextUnit(lang, style, session);
	} catch (error) {
		if (key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion !== speedVersion) {
			void playNextUnit(lang, style, session);
			return;
		}
		playbackMetrics.recordSynthError(unitIndex, (error as Error).message);
		if (isCurrentSynthesisKey(key)) {
			void pauseKeepalive.stop();
			clearWordHighlightTracking();
			reportProgress('error', { error: (error as Error).message });
		}
	}
}

function checkpointMetadata(checkpoint: RuntimeManualCheckpoint) {
	return {
		sessionId: checkpoint.sessionId,
		panelInstanceId: checkpoint.panelInstanceId,
		lang: checkpoint.lang,
		voiceStyleId: checkpoint.voiceStyleId,
		speed: checkpoint.speed,
	};
}

function currentBufferElapsedSec(): number {
	if (!currentBuffer || !audioCtx) {
		return 0;
	}
	return resumeOffsetSeconds({
		bufferDurationSec: currentBuffer.duration,
		elapsedSec: currentBufferOffsetSec + audioCtx.currentTime - currentBufferStartedAt,
	});
}

async function resumePendingManualPlayback(checkpoint: RuntimeManualCheckpoint, session: number): Promise<void> {
	const article = checkpoint.pendingArticle;
	if (!article) {
		throw new Error('Manual checkpoint has no resumable audio state');
	}
	let normalizer: VietnameseTextNormalizer | null = null;
	if (isVietnameseLanguage(article.lang)) {
		const assets = await loadVietnameseNormalizerAssets();
		normalizer = {
			normalize: (text) => normalizeVietnameseText(text, { assets, now: () => performance.now() }),
		};
	}
	const preparedUnits = await preparePlaybackUnits(article.content, article.lang, normalizer);
	if (session !== playbackSession) {
		return;
	}
	speechUnits = preparedUnits;
	currentUnitIndex = 0;
	if (speechUnits.length === 0) {
		throw new Error('No readable text content found.');
	}
	await initializeReadableSurface(session);
	if (!ttsEngine) {
		await initModels();
	}
	const style = await getVoiceStyle(checkpoint.voiceStyleId);
	if (session !== playbackSession) {
		return;
	}
	currentPlaybackStyle = style;
	if (!audioCtx) {
		audioCtx = new (
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
		)();
	}
	if (audioCtx.state === 'suspended') {
		await audioCtx.resume();
	}
	if (session === playbackSession) {
		void playNextUnit(article.lang, style, session);
	}
}

function checkpointManual(payload: unknown): { success: boolean; checkpoint?: ReturnType<typeof checkpointMetadata> } {
	const input = payload as { sessionId?: unknown; panelInstanceId?: unknown } | undefined;
	if (
		!input ||
		typeof input.sessionId !== 'string' ||
		!isPanelInstanceId(input.panelInstanceId) ||
		input.sessionId !== currentExtensionSessionId ||
		input.panelInstanceId !== currentManualPanelInstanceId ||
		!currentPlaybackLanguage ||
		(!currentPlaybackStyle && !pendingManualPlayback)
	) {
		return { success: false };
	}

	const bufferDurationSec = currentBuffer?.duration ?? 0;
	const checkpoint = captureManualCheckpoint({
		sessionId: input.sessionId,
		panelInstanceId: input.panelInstanceId,
		unitIndex: currentUnitIndex,
		bufferDurationSec,
		elapsedSec: currentBufferElapsedSec(),
		wordIndex: currentWordIndex,
	});
	manualCheckpoint = {
		...checkpoint,
		lang: currentPlaybackLanguage,
		style: currentPlaybackStyle,
		voiceStyleId: currentVoiceStyleId,
		speed: currentSpeed,
		speechUnits,
		buffer: currentBuffer,
		pendingArticle: pendingManualPlayback?.article ?? null,
	};

	void pauseKeepalive.stop();
	stopCurrentSource();
	clearWordHighlightTracking();
	playbackMetrics.discardPendingTransition();
	playbackSession++;
	isPaused = false;
	playbackStatus = 'stopped';
	speechUnits = [];
	currentUnitIndex = 0;
	currentBuffer = null;
	currentBufferStartedAt = 0;
	currentBufferOffsetSec = 0;
	currentManualPanelInstanceId = null;
	currentReadableSurface = 'none';
	currentReadableSurfaceContentScope = 'article';
	currentPlaybackLanguage = null;
	currentPlaybackStyle = null;
	pendingManualPlayback = null;
	currentExtensionSessionId = null;
	return { success: true, checkpoint: checkpointMetadata(manualCheckpoint) };
}

async function resumeManualCheckpoint(payload: unknown): Promise<{ success: boolean; checkpoint?: ReturnType<typeof checkpointMetadata> }> {
	const panelInstanceId = (payload as { panelInstanceId?: unknown } | undefined)?.panelInstanceId;
	if (!isPanelInstanceId(panelInstanceId) || !isCheckpointOwner(manualCheckpoint, panelInstanceId) || currentSourceNode !== null) {
		return { success: false };
	}
	const checkpoint = manualCheckpoint;
	if (!checkpoint) {
		return { success: false };
	}
	if (!audioCtx) {
		audioCtx = new (
			window.AudioContext ||
			(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
		)();
	}
	if (audioCtx.state === 'suspended') {
		await audioCtx.resume();
	}

	manualCheckpoint = null;
	currentExtensionSessionId = checkpoint.sessionId;
	currentManualPanelInstanceId = checkpoint.panelInstanceId;
	currentReadableSurface = 'manual-reader';
	currentReadableSurfaceContentScope = 'manual';
	currentPlaybackLanguage = checkpoint.lang;
	currentPlaybackStyle = checkpoint.style;
	currentVoiceStyleId = checkpoint.voiceStyleId;
	currentSpeed = checkpoint.speed;
	speechUnits = checkpoint.speechUnits;
	currentUnitIndex = checkpoint.unitIndex;
	currentWordIndex = checkpoint.wordIndex;
	isPaused = false;
	const session = ++playbackSession;

	if (!checkpoint.pendingArticle) {
		await initializeReadableSurface(session);
	}

	if (checkpoint.buffer && checkpoint.style && checkpoint.sourceOffsetSec < checkpoint.buffer.duration) {
		playAudioBuffer(
			checkpoint.buffer,
			checkpoint.lang,
			checkpoint.style,
			session,
			checkpoint.unitIndex,
			checkpoint.sourceOffsetSec,
		);
	} else if (checkpoint.style && checkpoint.speechUnits.length > 0) {
		if (checkpoint.buffer) {
			currentUnitIndex++;
		}
		void playNextUnit(checkpoint.lang, checkpoint.style, session);
	} else if (checkpoint.pendingArticle) {
		void resumePendingManualPlayback(checkpoint, session).catch((error: Error) => {
			if (session === playbackSession) {
				reportProgress('error', { error: error.message });
			}
		});
	} else {
		return { success: false };
	}
	return { success: true, checkpoint: checkpointMetadata(checkpoint) };
}

function discardManualCheckpoint(payload: unknown): boolean {
	const panelInstanceId = (payload as { panelInstanceId?: unknown } | undefined)?.panelInstanceId;
	if (!isPanelInstanceId(panelInstanceId) || !isCheckpointOwner(manualCheckpoint, panelInstanceId)) {
		return false;
	}
	manualCheckpoint = null;
	return true;
}

function exportJobId(payload: unknown): string | null {
	const jobId = (payload as { jobId?: unknown } | undefined)?.jobId;
	return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

function prepareAudioExport(payload: unknown): { success: boolean; error?: string } {
	const input = payload as { jobId?: unknown; playbackSessionId?: unknown; outputFilename?: unknown; estimate?: unknown } | undefined;
	if (
		!input ||
		typeof input.jobId !== 'string' ||
		input.jobId.length === 0 ||
		typeof input.playbackSessionId !== 'string' ||
		input.playbackSessionId !== currentExtensionSessionId ||
		typeof input.outputFilename !== 'string' ||
		input.outputFilename.length === 0 ||
		!isAudioExportEstimate(input.estimate) ||
		!currentPlaybackLanguage ||
		!currentPlaybackStyle ||
		!currentVoiceStyleId ||
		speechUnits.length === 0
	) {
		return { success: false, error: 'Audio export session is unavailable' };
	}
	try {
		audioExportEngine.prepare({
			jobId: input.jobId,
			playbackSessionId: input.playbackSessionId,
			outputFilename: input.outputFilename,
			units: speechUnits,
			language: currentPlaybackLanguage,
			voiceStyleId: currentVoiceStyleId,
			style: currentPlaybackStyle,
			speed: currentSpeed,
			estimate: input.estimate,
		});
		return { success: true };
	} catch (error) {
		return { success: false, error: (error as Error).message };
	}
}

export const handleOffscreenMessage = (
	message: unknown,
	_sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void,
) => {
		if (!message || typeof message !== 'object') {
			return undefined;
		}
		const msg = message as { action: string; payload?: unknown };
		const { action, payload } = msg;
		if (isAudioExportOffscreenAction(action) && !isInternalAudioExportOffscreenCommand(message)) {
			return undefined;
		}

		switch (action) {
			case 'FETCH_FILE_BYTES': {
				const fileUrl = (payload as { url?: unknown } | undefined)?.url;
				if (typeof fileUrl !== 'string') {
					sendResponse({ success: false, error: 'Missing file URL' });
					break;
				}
				let targetUrl = fileUrl;
				try {
					targetUrl = encodeURI(decodeURI(fileUrl));
				} catch {
					// fallback to original fileUrl
				}
				fetch(targetUrl)
					.then((res) => res.blob())
					.then((blob) => {
						const reader = new FileReader();
						reader.onloadend = () => {
							const dataUrl = reader.result as string;
							const base64 = dataUrl ? dataUrl.split(',')[1] ?? '' : '';
							sendResponse({ success: true, base64 });
						};
						reader.onerror = () => {
							sendResponse({ success: false, error: 'Failed to read file blob' });
						};
						reader.readAsDataURL(blob);
					})
					.catch((err) => {
						sendResponse({ success: false, error: (err as Error).message });
					});
				return true;
			}

			case 'PREPARE_AUDIO_EXPORT':
				sendResponse(prepareAudioExport(payload));
				break;

			case 'START_AUDIO_EXPORT': {
				const jobId = exportJobId(payload);
				if (!jobId) {
					sendResponse({ success: false, error: 'Missing audio export job ID' });
					break;
				}
				try {
					void audioExportEngine.start(jobId).catch(() => undefined);
					sendResponse({ success: true });
				} catch (error) {
					sendResponse({ success: false, error: (error as Error).message });
				}
				break;
			}

			case 'CANCEL_AUDIO_EXPORT': {
				const jobId = exportJobId(payload);
				if (!jobId) {
					sendResponse({ success: false, error: 'Missing audio export job ID' });
					break;
				}
				void audioExportEngine.cancel(jobId).then(
					() => sendResponse({ success: true }),
					(error: Error) => sendResponse({ success: false, error: error.message }),
				);
				return true;
			}

			case 'DISCARD_AUDIO_EXPORT': {
				const jobId = exportJobId(payload);
				if (!jobId) {
					sendResponse({ success: false, error: 'Missing audio export job ID' });
					break;
				}
				void audioExportEngine.discard(jobId).then(
					() => sendResponse({ success: true }),
					(error: Error) => sendResponse({ success: false, error: error.message }),
				);
				return true;
			}

			case 'INIT_MODELS':
				initModels().catch(() => {
					// The failure is reported through MODEL_LOAD_FAILED.
				});
				sendResponse({ status: 'starting' });
				break;

			case 'PLAY': {
				const sessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId;
				if (typeof sessionId !== 'string' || sessionId.length === 0) {
					sendResponse({ success: false, error: 'Missing playback session ID' });
					break;
				}

				const isResume = isPaused && audioCtx && playbackStatus === 'paused';
				if (!isResume) {
					const data = payload as {
						article: { content: string; lang: string };
						voiceStyleId: string;
						speed: number;
						panelInstanceId?: unknown;
						contentScope?: unknown;
						readableSurface?: unknown;
						documentTitle?: unknown;
					};
					const { article, voiceStyleId, speed } = data;
					if (!isReadableSurfaceKind(data.readableSurface)) {
						sendResponse({ success: false, error: 'Invalid readable surface' });
						break;
					}
					if (data.panelInstanceId !== undefined && !isPanelInstanceId(data.panelInstanceId)) {
						sendResponse({ success: false, error: 'Invalid Side Panel owner ID' });
						break;
					}
					if (data.readableSurface === 'document-reader' && typeof data.documentTitle !== 'string') {
						sendResponse({ success: false, error: 'Missing document reader title' });
						break;
					}
					const session = ++playbackSession;
					stopAudio();
					currentExtensionSessionId = sessionId;
					currentManualPanelInstanceId = data.panelInstanceId ?? null;
					currentReadableSurface = data.readableSurface;
					currentReadableSurfaceContentScope =
						data.readableSurface === 'manual-reader' ? 'manual' : data.contentScope === 'selection' ? 'selection' : 'article';
					currentDocumentReader =
						data.readableSurface === 'document-reader'
							? {
									sessionId,
									title: data.documentTitle as string,
									content: article.content,
									words: [],
								}
							: null;
					currentPlaybackLanguage = article.lang;
					currentVoiceStyleId = voiceStyleId;
					currentWordIndex = -1;
					if (currentManualPanelInstanceId) {
						manualCheckpoint = null;
						pendingManualPlayback = {
							sessionId,
							panelInstanceId: currentManualPanelInstanceId,
							article,
							voiceStyleId,
							speed,
						};
					}
					currentSpeed = speed;
					playbackMetrics.markPlayRequested(performance.now());
					reportProgress('loading');

					(async () => {
						try {
							let normalizer: VietnameseTextNormalizer | null = null;
							if (isVietnameseLanguage(article.lang)) {
								const assets = await loadVietnameseNormalizerAssets();
								normalizer = {
									normalize: (text) => normalizeVietnameseText(text, { assets, now: () => performance.now() }),
								};
							}
							const preparedUnits = await preparePlaybackUnits(article.content, article.lang, normalizer);

							if (session !== playbackSession) {
								sendResponse({ success: false, error: 'Playback superseded' });
								return;
							}

							speechUnits = preparedUnits;
							const audioExportEstimate = estimateSpeechUnits(speechUnits, article.lang, speed);
							currentUnitIndex = 0;
							isPaused = false;
							playbackMetrics.recordTotalUnits(speechUnits.length);

							if (speechUnits.length === 0) {
								sendResponse({ success: false, error: 'No readable text content found.' });
								return;
							}

							await initializeReadableSurface(session);

							if (session !== playbackSession) {
								sendResponse({ success: false, error: 'Playback superseded' });
								return;
							}

							if (!ttsEngine) {
								await initModels();
							}
							const style = await getVoiceStyle(voiceStyleId);
							if (session !== playbackSession) {
								sendResponse({ success: false, error: 'Playback superseded' });
								return;
							}

							if (!audioCtx) {
								audioCtx = new (
									window.AudioContext ||
									(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
								)();
							}
							if (audioCtx.state === 'suspended') {
								await audioCtx.resume();
							}

							if (session !== playbackSession) {
								sendResponse({ success: false, error: 'Playback superseded' });
								return;
							}
							currentPlaybackStyle = style;
							pendingManualPlayback = null;

							sendResponse({ success: true, audioExportEstimate });

							// Trigger first chunk playback
							void playNextUnit(article.lang, style, session);
						} catch (err) {
							const error = err as Error;
							if (session === playbackSession) {
								reportProgress('error', { error: error.message });
							}
							sendResponse({ success: false, error: error.message });
						}
					})();
					return true; // async sendResponse
				}

				(async () => {
					try {
						await pauseKeepalive.stop();
						await audioCtx?.resume();
						isPaused = false;
						reportProgress('playing');
						sendResponse({ success: true });
					} catch (err) {
						const error = err as Error;
						sendResponse({ success: false, error: error.message });
					}
				})();
				return true; // async sendResponse
			}

			case 'PAUSE':
				(async () => {
					if (!audioCtx || audioCtx.state !== 'running') {
						sendResponse({ success: false, error: 'Audio is not running' });
						return;
					}
					try {
						await audioCtx.suspend();
						playbackMetrics.discardPendingTransition();
						isPaused = true;
						await pauseKeepalive.start().catch(() => undefined);
						reportProgress('paused');
						sendResponse({ success: true });
					} catch (error) {
						sendResponse({ success: false, error: (error as Error).message });
					}
				})();
				return true;

			case 'STOP':
				playbackSession++;
				stopAudio();
				sendResponse({ success: true });
				break;

			case 'CHECKPOINT_MANUAL':
				sendResponse(checkpointManual(payload));
				break;

			case 'RESUME_MANUAL_CHECKPOINT':
				void resumeManualCheckpoint(payload).then(
					(response) => sendResponse(response),
					() => sendResponse({ success: false }),
				);
				return true;

			case 'DISCARD_MANUAL_CHECKPOINT':
				sendResponse({ success: discardManualCheckpoint(payload) });
				break;

			case 'GET_MANUAL_CHECKPOINT_METADATA':
				sendResponse(manualCheckpoint ? { success: true, checkpoint: checkpointMetadata(manualCheckpoint) } : { success: false });
				break;

			case 'GET_DOCUMENT_READER_SNAPSHOT': {
				const sessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId;
				if (
					typeof sessionId !== 'string' ||
					currentReadableSurface !== 'document-reader' ||
					currentDocumentReader?.sessionId !== sessionId
				) {
					sendResponse({ success: false });
					break;
				}
				surfaceReady = true;
				sendResponse({
					success: true,
					snapshot: { ...currentDocumentReader, currentWordIndex },
				});
				break;
			}

			case 'DETACH_DOCUMENT_READER': {
				const sessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId;
				if (sessionId === currentDocumentReader?.sessionId) {
					surfaceReady = false;
				}
				sendResponse({ success: true });
				break;
			}

			case 'CHANGE_SPEED': {
				const speed = (payload as { speed?: unknown })?.speed;
				if (typeof speed !== 'number' || !Number.isFinite(speed)) {
					sendResponse({ success: false, error: 'Invalid speed' });
					break;
				}
				currentSpeed = speed;
				speedVersion++;
				synthesisCoordinator.clear();
				reportProgress(playbackStatus);
				sendResponse({ success: true, audioExportEstimate: estimateSpeechUnits(speechUnits, currentPlaybackLanguage ?? '', speed) });
				break;
			}

			default:
				return undefined;
		}
};

export function registerOffscreenMessageHandler(): void {
	chrome.runtime.onMessage.addListener(handleOffscreenMessage);
}
