import { isAudioExportEstimate, isAudioExportOffscreenAction, unwrapAudioExportOffscreenCommand } from '../shared/audio_export.ts';
import { deleteAudioExportHandle, takeAudioExportHandle } from '../shared/audio_export_handle_store.ts';
import { MODEL_FILES, VOICE_STYLES } from '../shared/constants';
import type { DocumentReaderSnapshot } from '../shared/document_reader.ts';
import type { TtsProviderId } from '../shared/edge_voice_preferences.ts';
import { t } from '../shared/i18n.ts';
import { isPanelInstanceId } from '../shared/manual_playback';
import type { MediaSessionMetadata } from '../shared/media_session_metadata.ts';
import { buildReadableSurfaceInitMessage, buildReadableSurfaceWords } from '../shared/readable_surface.ts';
import { createSingleFlight } from '../shared/single_flight';
import type {
	AudioExportEstimate,
	PlaybackContent,
	PlaybackContentScope,
	PlaybackProgress,
	PlaybackStatus,
	PronunciationRule,
	ReadableSurfaceKind,
} from '../shared/types';
import { createSpeechAudioBuffer } from './audio';
import { createAudioExportEncoder } from './audio_export_encoder.ts';
import { AudioExportEngine } from './audio_export_engine.ts';
import { estimateSpeechUnits } from './audio_export_estimate';
import { canStartBackgroundSynthesis, type PlaybackRunway } from './audio_export_runway';
import { emitAudioHostMessage, requestAudioHostMessage } from './audio_host_messages.ts';
import { classifyEdgeFailure } from './edge/edge_failure.ts';
import { createEdgeProvider } from './edge/edge_provider.ts';
import { EDGE_STARVATION_GRACE_MS, retryEdgeSynthesis } from './edge/edge_retry.ts';
import { EdgeSocket } from './edge/edge_socket.ts';
import { EngineBoundaryDiagnostics } from './engine_boundary_diagnostics.ts';
import { ExportPreparationDiagnostics } from './export_prepare_diagnostics.ts';
import { ExportSnapshotDiagnostics } from './export_snapshot_diagnostics.ts';
import { captureManualCheckpoint, isCheckpointOwner, type ManualCheckpoint, resumeOffsetSeconds } from './manual_checkpoint';
import { createMediaSessionController } from './media_session';
import { createPauseKeepalive } from './pause_keepalive';
import { PlaybackMetricsRecorder, summarizePlaybackMetrics } from './playback_metrics';
import { isVietnameseLanguage, preparePlaybackUnits, replanRemainingUnits, VietnameseTextNormalizer } from './playback_preparation';
import {
	bufferedHeadroomMs,
	type PrefetchState,
	prefetchCap,
	prefetchStarts,
	prefetchTargetSeconds,
	prefetchWindow,
	shouldPrimeSuccessor,
} from './prefetch_window.ts';
import type { SpeechProvider, SynthesizedPlayback, SynthesizedUnit } from './speech_provider.ts';
import type { SpeechUnit } from './speech_unit';
import { loadTextToSpeech, loadVoiceStyle, Style, TextToSpeech } from './supertonic_helper';
import { createSupertonicProvider } from './supertonic_provider.ts';
import { SynthesisArbiter } from './synthesis_arbiter';
import { IndexedSynthesisCoordinator, type SynthesisKey } from './synthesis_coordinator';
import { loadVietnameseNormalizerAssets } from './vietnamese/assets';
import { normalizeVietnameseText } from './vietnamese/normalizer';
import { VoicedAudioError } from './voiced_audio.ts';
import { computeReadableSurfaceWordTimings, findWordAtTime, type WordTimingWindow } from './word_timing';

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
// Audio already spoken in earlier units, so the media session can report a position
// across the whole article rather than restarting at each paragraph.
let playedSecondsBeforeCurrentUnit = 0;
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

// Null outside Chrome: Firefox has no offscreen document, so this file never loads there.
const mediaSession = navigator.mediaSession
	? createMediaSessionController(navigator.mediaSession, (init) => new MediaMetadata(init))
	: null;

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
const engineBoundaryDiagnostics = new EngineBoundaryDiagnostics();
const exportSnapshotDiagnostics = new ExportSnapshotDiagnostics();
const exportPreparationDiagnostics = new ExportPreparationDiagnostics();
let forceNextExportRawFailure = false;
let lastExportProbeFailure: { name: string; reason: string | null } | null = null;
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
	// Route through the service worker: chrome.storage is not reliably available
	// inside the Chrome offscreen document (see offscreen_transport.ts).
	emitAudioHostMessage({ action: 'RECORD_PLAYBACK_METRICS', payload: summary });
}

// Readable from the offscreen document's own devtools console while playback is running.
(globalThis as unknown as { __readitPlaybackMetrics?: () => unknown }).__readitPlaybackMetrics = () =>
	summarizePlaybackMetrics(playbackMetrics.snapshot());

(globalThis as unknown as { __readitPlaybackDebug?: () => unknown }).__readitPlaybackDebug = () => ({
	sessionId: currentExtensionSessionId,
	language: currentPlaybackLanguage,
	voiceStyleId: currentVoiceStyleId || null,
	hasPlaybackStyle: currentPlaybackStyle !== null,
	unitCount: speechUnits.length,
	speed: currentSpeed,
	sourceId: currentSourceId,
	bufferOffsetSec: currentBufferOffsetSec,
	audioContextTime: audioCtx?.currentTime ?? null,
	audioContextState: audioCtx?.state ?? null,
	isPaused,
	unitIndex: currentUnitIndex,
	wordHighlight: {
		...highlightDebug,
		timerActive: wordHighlightTimer !== null,
		msSinceLastTick: highlightDebug.lastTickAtMs === null ? null : performance.now() - highlightDebug.lastTickAtMs,
		surfaceReady,
		emittedWordIndex: lastReadableSurfaceWordIndex,
	},
	pauseKeepalive: pauseKeepalive.getDebugState(),
	backgroundSynthesisAllowed: canStartBackgroundSynthesis(playbackRunway()),
	mediaSession: mediaSession
		? {
				...mediaSession.getDebugState(),
				playbackState: navigator.mediaSession.playbackState,
				metadataTitle: navigator.mediaSession.metadata?.title ?? null,
			}
		: null,
});

// Test-only CDP view: there is deliberately no extension message or product UI for these records.
(
	globalThis as unknown as {
		__readitEngineBoundaryDiagnostics?: {
			read(probeId?: string | null): unknown;
			clear(probeId?: string | null): void;
		};
	}
).__readitEngineBoundaryDiagnostics = {
	read: (probeId) => engineBoundaryDiagnostics.read(probeId),
	clear: (probeId) => engineBoundaryDiagnostics.clear(probeId),
};

// Test-only CDP view of immutable export snapshot metadata. It intentionally
// cannot expose prepared units, synthesis text, style data, or output handles.
(
	globalThis as unknown as {
		__readitExportSnapshotDiagnostics?: {
			read(jobId?: string): unknown;
			clear(jobId?: string): void;
		};
	}
).__readitExportSnapshotDiagnostics = {
	read: (jobId) => exportSnapshotDiagnostics.read(jobId),
	clear: (jobId) => exportSnapshotDiagnostics.clear(jobId),
};

// Test-only CDP record of the inner offscreen preparation outcome. It has no
// extension-message or product UI route, and does not alter the public result.
(
	globalThis as unknown as {
		__readitExportPreparationDiagnostics?: {
			read(jobId?: string): unknown;
			clear(jobId?: string): void;
		};
	}
).__readitExportPreparationDiagnostics = {
	read: (jobId) => exportPreparationDiagnostics.read(jobId),
	clear: (jobId) => exportPreparationDiagnostics.clear(jobId),
};

// Test-only CDP control for one intentional unvoiced export negative control.
// It has no extension-message or product UI route and is consumed after one export engine call.
(
	globalThis as unknown as {
		__readitExportProbeControls?: {
			forceNextUnvoicedRawFailure(): void;
			readLastFailure(): { name: string; reason: string | null } | null;
		};
	}
).__readitExportProbeControls = {
	forceNextUnvoicedRawFailure: () => {
		forceNextExportRawFailure = true;
		lastExportProbeFailure = null;
	},
	readLastFailure: () => (lastExportProbeFailure ? { ...lastExportProbeFailure } : null),
};

/**
 * Report playback progress to background/popup
 */
function reportProgress(status: PlaybackStatus, extra: Partial<PlaybackProgress> = {}) {
	playbackStatus = status;
	mediaSession?.sync(status);
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

/** Which engine this reading session speaks with. A downgrade flips it for the rest of the session. */
let sessionProviderId: 'edge' | 'supertonic' = 'edge';
/**
 * The voice the current session speaks with — an edge short name or a Supertonic style id.
 * Session state rather than a parameter because a mid-article downgrade has to change it for units
 * already queued behind closures that captured the previous value.
 */
let sessionVoiceId = '';
let edgeSocket: EdgeSocket | null = null;

const supertonicProvider = createSupertonicProvider({
	engine: () => {
		if (!ttsEngine) {
			throw new Error('TTS Engine is not initialized');
		}
		return ttsEngine;
	},
	style: (voiceId) => getVoiceStyle(voiceId),
});

/**
 * The socket has to be created from this document. Opened from the service worker, Chrome never
 * applies the declarativeNetRequest User-Agent rewrite to the handshake (crbug 1285664) and
 * Microsoft answers 403.
 */
function edgeProvider(): SpeechProvider {
	edgeSocket ??= new EdgeSocket({
		createSocket: (url) => new WebSocket(url),
		now: () => Date.now(),
		requestId: () => crypto.randomUUID().replaceAll('-', ''),
	});
	return createEdgeProvider({
		socket: edgeSocket,
		decode: async (audio) => {
			if (!audioCtx) {
				audioCtx = new (
					window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
				)();
			}
			// decodeAudioData detaches the buffer it is given, so hand it a copy of the socket's bytes.
			const decoded = await audioCtx.decodeAudioData(audio.slice().buffer as ArrayBuffer);
			return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
		},
	});
}

function activeProvider(): SpeechProvider {
	return sessionProviderId === 'edge' ? edgeProvider() : supertonicProvider;
}

/** Kept so a mid-article downgrade can re-plan the tail the way the session would have. */
let sessionNormalizer: VietnameseTextNormalizer | null = null;
let sessionPronunciationRules: readonly PronunciationRule[] = [];

/**
 * Decide how this session speaks, and hand back the normalizer its text pipeline should use.
 *
 * The preference arrives on the play payload rather than being read here: `chrome.storage` is not
 * reliably available inside the Chrome offscreen document (see shared/storage.ts and
 * background/offscreen_transport.ts), and reading it here leaves the session stuck in `loading`.
 *
 * The normalizer is a step of the Supertonic flow: Microsoft's frontend expands numbers, dates and
 * abbreviations itself, so running ours first would expand the same string twice. Returning null
 * takes the plain planning branch in preparePlaybackUnits.
 */
function beginSessionProvider(
	preferred: TtsProviderId,
	edgeVoice: string | null,
	normalizer: VietnameseTextNormalizer | null,
): VietnameseTextNormalizer | null {
	sessionNormalizer = normalizer;
	sessionPronunciationRules = [];
	if (preferred === 'edge' && edgeVoice) {
		sessionProviderId = 'edge';
		sessionVoiceId = edgeVoice;
		return null;
	}
	// Either the reader chose on-device voices, or Microsoft has none for this language.
	sessionProviderId = 'supertonic';
	sessionVoiceId = currentVoiceStyleId;
	return normalizer;
}

/**
 * Move the rest of this session on-device.
 *
 * The units after the one playing were planned without the normalizer, so Supertonic would read
 * their numbers and dates wrong. They are re-planned through the normalizer and swapped in; the
 * unit currently playing is already a decoded buffer and is left to finish.
 */
async function downgradeToSupertonic(lang: string): Promise<void> {
	sessionProviderId = 'supertonic';
	sessionVoiceId = currentVoiceStyleId;
	edgeSocket?.close();
	edgeSocket = null;
	synthesisCoordinator.clear();

	if (sessionNormalizer && speechUnits.length > currentUnitIndex + 1) {
		const replanned = await replanRemainingUnits(speechUnits, currentUnitIndex, lang, sessionNormalizer, sessionPronunciationRules);
		if (replanned.length > 0) {
			speechUnits = [...speechUnits.slice(0, currentUnitIndex + 1), ...replanned];
		}
	}
	if (!ttsEngine) {
		await initModels();
	}
	reportProgress(playbackStatus, { error: t('ttsProviderFallbackNotice') });
}

/** One attempt, inside the arbiter slot. Retrying happens around it — see synthesizeWithEdgeRetry. */
async function synthesizeOnce(input: SynthesisInput): Promise<SynthesizedPlayback> {
	return await synthesizeUnit(input.unit, input.lang, input.speed, input.owner, input.probeId);
}

/**
 * Retry around the arbiter rather than inside it.
 *
 * `SynthesisArbiter.drain` awaits one task at a time, so sleeping inside the slot would stall
 * every other unit — including the prefetch that keeps the buffer deep enough to make waiting
 * safe in the first place. Each attempt therefore takes a fresh slot and the backoff happens
 * between them, leaving the queue free to advance.
 */
async function synthesizeWithEdgeRetry(input: SynthesisInput): Promise<SynthesizedPlayback> {
	if (sessionProviderId !== 'edge') {
		return await synthesisArbiter.foreground(input);
	}
	const unitIndex = input.unit.synthesisIndex ?? speechUnits.indexOf(input.unit);
	return await retryEdgeSynthesis(() => synthesisArbiter.foreground(input), {
		classify: classifyEdgeFailure,
		headroomMs: playbackHeadroomMs,
		graceMs: EDGE_STARVATION_GRACE_MS,
		now: () => performance.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		onAttemptFailed: (error, attempt) => {
			// Recorded even when a later attempt succeeds: a downgrade that leaves no trace is
			// indistinguishable from the engine simply sounding different.
			playbackMetrics.recordSynthError(
				unitIndex,
				`edge attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
			);
			// The connection is spent either way; the next attempt opens a fresh one.
			edgeSocket?.close();
			edgeSocket = null;
		},
		fallback: async (error) => {
			playbackMetrics.recordSynthError(unitIndex, `edge exhausted: ${error instanceof Error ? error.message : String(error)}`);
			await downgradeToSupertonic(input.lang);
			return await synthesisArbiter.foreground(input);
		},
	});
}

async function synthesizeUnit(
	unit: SpeechUnit,
	lang: string,
	speed: number,
	owner: SynthesisOwner,
	probeId: string | null = currentExtensionSessionId,
): Promise<SynthesizedPlayback> {
	const provider = activeProvider();
	const voiceId = sessionVoiceId || currentVoiceStyleId;
	const synthesisStartedAtMs = performance.now();
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
	}
	const inferStartedAtMs = performance.now();
	const synthesisIndex = unit.synthesisIndex ?? speechUnits.indexOf(unit);
	const unitIndex = synthesisIndex >= 0 ? synthesisIndex : null;
	let synthesized: SynthesizedUnit;
	try {
		synthesized = await provider.synthesize({
			unit,
			lang,
			voiceId,
			speed,
			onRawEngineSamples: (samples) =>
				engineBoundaryDiagnostics.record({
					probeId,
					unitIndex,
					owner: owner === 'playback' ? 'foreground' : 'export',
					canonicalText: unit.text,
					synthesisText: unit.synthesisText ?? unit.text,
					language: lang,
					requestedSpeed: speed,
					samples,
				}),
		});
	} catch (error) {
		if (owner === 'export') {
			lastExportProbeFailure = {
				name: error instanceof Error ? error.name : 'UnknownError',
				reason: error instanceof VoicedAudioError ? error.reason : null,
			};
		}
		throw error;
	}
	if (owner === 'export' && forceNextExportRawFailure) {
		// Export probe hook: prove the unvoiced-audio guard still rejects a silent export unit.
		forceNextExportRawFailure = false;
		const failure = new VoicedAudioError('materially-silent', { unitIndex: unitIndex ?? undefined, unitText: unit.text });
		lastExportProbeFailure = { name: failure.name, reason: failure.reason };
		throw failure;
	}
	if (owner === 'playback') {
		playbackMetrics.recordInferDuration(performance.now() - inferStartedAtMs);
	}

	const buffer = createSpeechAudioBuffer(audioCtx, synthesized.samples, synthesized.sampleRate, unit.pauseAfterMs ?? 0);
	if (owner === 'playback') {
		const synthesisMilliseconds = performance.now() - synthesisStartedAtMs;
		playbackMetrics.recordSynthDuration(synthesisMilliseconds);
		recentSynthesisMilliseconds.push(synthesisMilliseconds);
		if (recentSynthesisMilliseconds.length > 5) {
			recentSynthesisMilliseconds.shift();
		}
	}
	return { buffer, wordTimings: synthesized.wordTimings };
}

interface SynthesisInput {
	unit: SpeechUnit;
	lang: string;
	speed: number;
	owner: SynthesisOwner;
	probeId?: string | null;
}

const synthesisArbiter = new SynthesisArbiter<SynthesisInput, SynthesizedPlayback>((input) => synthesizeOnce(input));

const synthesisCoordinator = new IndexedSynthesisCoordinator<SynthesisInput, SynthesizedPlayback>(
	(input) => synthesizeWithEdgeRetry(input),
	{
		onResolved: () => {
			notifyExportRunway();
			refillPrefetch();
		},
	},
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
	// `currentPlaybackLanguage` is null between sessions. The estimate only sizes a buffer, and an
	// empty language means the non-Chinese words-per-minute rate, which is the right default for a
	// window nothing is playing into yet.
	const window = prefetchWindow(
		speechUnits,
		currentUnitIndex,
		currentPlaybackLanguage ?? '',
		currentSpeed,
		prefetchTargetSeconds(sessionProviderId),
	);
	for (const unitIndex of window) {
		keys.push(synthesisKey(session, unitIndex));
	}
	return keys;
}

/**
 * Audio already synthesized ahead of the playhead, in milliseconds.
 *
 * Counted over the contiguous run after the current unit: a hole means the reader reaches silence
 * there regardless of what is buffered past it, so anything beyond the hole is not headroom. A
 * reader who is already waiting has none at all — see bufferedHeadroomMs. This is what bounds how
 * patiently a failed unit may be retried.
 */
function playbackHeadroomMs(): number {
	let seconds = 0;
	for (let unitIndex = currentUnitIndex + 1; unitIndex < speechUnits.length; unitIndex += 1) {
		const resolved = synthesisCoordinator.peekResolved(synthesisKey(playbackSession, unitIndex));
		if (!resolved) {
			break;
		}
		seconds += resolved.buffer.duration;
	}
	return bufferedHeadroomMs(playbackStatus === 'loading', seconds);
}

function playbackRunway(): PlaybackRunway {
	const nextUnitIndex = currentUnitIndex + 1;
	const nextBuffer =
		currentExtensionSessionId !== null && nextUnitIndex < speechUnits.length
			? (synthesisCoordinator.peekResolved(synthesisKey(playbackSession, nextUnitIndex))?.buffer.duration ?? null)
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
	synthesize: ({ unit, language, speed, playbackSessionId }) =>
		synthesisArbiter.background({ unit, lang: language, speed, owner: 'export', probeId: playbackSessionId }),
	canStartBackgroundSynthesis: () => canStartBackgroundSynthesis(playbackRunway()),
	waitForRunway: waitForExportRunway,
	wakeRunway: notifyExportRunway,
	onProgress: (progress) => {
		emitAudioHostMessage({ action: 'AUDIO_EXPORT_PROGRESS', progress });
	},
	now: () => performance.now(),
});

function prefetchUnit(unitIndex: number, lang: string, session: number): void {
	if (unitIndex >= speechUnits.length) {
		return;
	}
	const key = synthesisKey(session, unitIndex);
	synthesisCoordinator.prefetch(key, {
		unit: speechUnits[unitIndex],
		lang,
		speed: currentSpeed,
		owner: 'playback',
		probeId: currentExtensionSessionId,
	});
}

function prefetchStateOf(session: number, unitIndex: number): PrefetchState {
	const key = synthesisKey(session, unitIndex);
	if (!synthesisCoordinator.has(key)) {
		return 'idle';
	}
	return synthesisCoordinator.peekResolved(key) === undefined ? 'inFlight' : 'resolved';
}

/**
 * Keep synthesizing forward until the buffer reaches the target, so a bad window stays inaudible.
 *
 * Only a few requests are queued at a time. The arbiter serves one at a time regardless, so the
 * bound costs no throughput, and it keeps a retry — which rejoins the queue at the back — from
 * waiting behind the whole window. Refilling happens from the coordinator's onResolved.
 */
function prefetchNextUnit(lang: string, session: number): void {
	const window = prefetchWindow(speechUnits, currentUnitIndex, lang, currentSpeed, prefetchTargetSeconds(sessionProviderId));
	// `loading` is exactly the state where the reader is on silence waiting for a unit, whether
	// that is the first one or a mid-article gap, so it is what narrows the queue.
	const cap = prefetchCap(playbackStatus === 'loading');
	for (const unitIndex of prefetchStarts(window, (candidate) => prefetchStateOf(session, candidate), cap)) {
		prefetchUnit(unitIndex, lang, session);
	}
}

/** Start the next prefetch as soon as one lands, so the bounded queue keeps refilling. */
function refillPrefetch(): void {
	if (currentPlaybackLanguage === null || playbackStatus === 'stopped') {
		return;
	}
	prefetchNextUnit(currentPlaybackLanguage, playbackSession);
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

/**
 * A frozen highlight leaves no trace anywhere else: the tick either stops firing, fires
 * too slowly, or fires with an elapsed time that has walked off the end of the unit's
 * windows. Each of those looks identical from the page, so record which one it is.
 */
const highlightDebug = {
	ticks: 0,
	lastTickAtMs: null as number | null,
	lastElapsedSec: null as number | null,
	windowEndSec: null as number | null,
	lastMatchedWordIndex: null as number | null,
	unmatchedTicks: 0,
};

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
	const initMessage = buildReadableSurfaceInitMessage(
		currentReadableSurface,
		currentExtensionSessionId,
		currentReadableSurfaceContentScope,
		words,
	);
	if (!initMessage) {
		return;
	}
	try {
		const response = (await requestAudioHostMessage(initMessage)) as { success?: unknown };
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
	highlightDebug.ticks = 0;
	highlightDebug.unmatchedTicks = 0;
	highlightDebug.windowEndSec = windows[windows.length - 1]?.endSec ?? null;
	wordHighlightTimer = setInterval(() => {
		if (!audioCtx) {
			return;
		}
		playbackMetrics.recordHighlightTick(performance.now());
		const elapsed = audioCtx.currentTime - unitStartTime + offsetSec;
		highlightDebug.ticks++;
		highlightDebug.lastTickAtMs = performance.now();
		highlightDebug.lastElapsedSec = elapsed;
		const wordTiming = findWordAtTime(windows, elapsed);
		if (wordTiming === null) {
			highlightDebug.unmatchedTicks++;
			return;
		}
		const wordIndex = base + wordTiming.wordIndex;
		highlightDebug.lastMatchedWordIndex = wordIndex;
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
	// After the 'stopped' report, so the tile is not cleared while it still reads as playing.
	mediaSession?.clear();
	mediaSession?.setNextTrack(null);
	mediaSession?.setPosition(null);
	playedSecondsBeforeCurrentUnit = 0;
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
 * Resume a suspended context.
 *
 * These three exist so the message handlers and the system media controls share one
 * body each, instead of the controls growing a second copy of the same transition.
 */
async function resumePlayback(): Promise<void> {
	await pauseKeepalive.stop();
	await audioCtx?.resume();
	isPaused = false;
	reportProgress('playing');
}

/** Returns false when there is no running context to pause. */
async function pausePlayback(): Promise<boolean> {
	if (!audioCtx || audioCtx.state !== 'running') {
		return false;
	}
	await audioCtx.suspend();
	playbackMetrics.discardPendingTransition();
	isPaused = true;
	await pauseKeepalive.start().catch(() => undefined);
	reportProgress('paused');
	return true;
}

function stopPlayback(): void {
	playbackSession++;
	stopAudio();
}

/**
 * A session with no duration reads to the OS as an incidental sound rather than
 * something worth a Now Playing entry, so report where we are in the whole article.
 * The total is an estimate over units that have not been synthesised yet; the
 * controller clamps an overrun rather than letting it throw.
 */
function reportMediaSessionPosition(offsetInUnitSec: number): void {
	if (!mediaSession || speechUnits.length === 0) {
		return;
	}
	const durationSeconds = estimateSpeechUnits(speechUnits, currentPlaybackLanguage ?? '', currentSpeed).durationSeconds;
	mediaSession.setPosition({
		duration: durationSeconds,
		position: playedSecondsBeforeCurrentUnit + offsetInUnitSec,
		playbackRate: currentSpeed,
	});
}

/**
 * Play a synthesized AudioBuffer
 */
function playAudioBuffer(
	buffer: AudioBuffer,
	lang: string,
	session: number,
	unitIndex: number,
	offsetSec = 0,
	providerWordTimings: WordTimingWindow[] | null = null,
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
		playedSecondsBeforeCurrentUnit += buffer.duration;
		currentUnitIndex = unitIndex + 1;
		if (currentUnitIndex < speechUnits.length) {
			void playNextUnit(lang, session);
		} else {
			stopAudio({ completedNaturally: true });
		}
	};

	const unit = speechUnits[unitIndex];
	const spokenDurationSec = Math.max(buffer.duration - (unit?.pauseAfterMs ?? 0) / 1000, 0);
	// Real timings only exist when the provider reported them and they reconciled with the word
	// map; otherwise they are estimated from syllable weights as they always were.
	const windows =
		currentReadableSurface === 'none'
			? []
			: (providerWordTimings ?? computeReadableSurfaceWordTimings(currentReadableSurface, unit?.wordMap ?? [], spokenDurationSec));
	const unitStartTime = audioCtx.currentTime;
	source.start(0, sourceOffsetSec);
	reportMediaSessionPosition(sourceOffsetSec);
	playbackMetrics.recordUnitStart(unitIndex, unitStartTime, performance.now(), buffer.duration, sourceOffsetSec);
	startWordHighlightTracking(windows, unitStartTime, sourceOffsetSec, unitIndex);
	// Flushed here rather than in `onended`: this point is after the gap has been measured,
	// so the write cost lands mid-unit instead of on the boundary being measured.
	flushPlaybackMetrics();
}

async function playNextUnit(lang: string, session: number) {
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
		speed: currentSpeed,
		owner: 'playback',
		probeId: currentExtensionSessionId,
	};
	synthesisCoordinator.retain(retainedSynthesisKeys(session));
	reportProgress('loading');

	try {
		const playback = await synthesisCoordinator.get(key, input);
		if (!isCurrentSynthesisKey(key)) {
			if (key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion !== speedVersion) {
				void playNextUnit(lang, session);
			}
			return;
		}

		// Prime exactly one successor before the initial source starts, so its audio is not left
		// uncovered while the second unit is still being produced. On the on-device path that
		// production is WASM inference on this document's main thread, which a short first source
		// cannot cover: the `onended` callback arrives late and leaves audible silence. On the
		// cloud path it is a socket round trip, and a first unit long enough to absorb the worst
		// case does not need the insurance — paying for it there costs the reader an extra round
		// trip before they hear anything. Normal one-unit look-ahead continues for all later units
		// without changing speed or pause ownership.
		if (unitIndex === 0 && speechUnits.length > 1 && shouldPrimeSuccessor(sessionProviderId, playback.buffer.duration)) {
			prefetchNextUnit(lang, session);
			const successorKey = synthesisKey(session, 1);
			const successorInput: SynthesisInput = {
				unit: speechUnits[1],
				lang,
				speed: currentSpeed,
				owner: 'playback',
				probeId: currentExtensionSessionId,
			};
			await synthesisCoordinator.get(successorKey, successorInput);
			if (!isCurrentSynthesisKey(key)) {
				if (key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion !== speedVersion) {
					void playNextUnit(lang, session);
				}
				return;
			}
		}
		playAudioBuffer(playback.buffer, lang, session, unitIndex, 0, playback.wordTimings);
		prefetchNextUnit(lang, session);
	} catch (error) {
		if (key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion !== speedVersion) {
			void playNextUnit(lang, session);
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
	// A resumed manual checkpoint keeps whatever the session was already using.
	const planningNormalizer = beginSessionProvider(sessionProviderId, sessionProviderId === 'edge' ? sessionVoiceId : null, normalizer);
	const preparedUnits = await preparePlaybackUnits(article.content, article.lang, planningNormalizer);
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
		audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
	}
	if (audioCtx.state === 'suspended') {
		await audioCtx.resume();
	}
	if (session === playbackSession) {
		void playNextUnit(article.lang, session);
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
		audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
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
		playAudioBuffer(checkpoint.buffer, checkpoint.lang, session, checkpoint.unitIndex, checkpoint.sourceOffsetSec);
	} else if (checkpoint.style && checkpoint.speechUnits.length > 0) {
		if (checkpoint.buffer) {
			currentUnitIndex++;
		}
		void playNextUnit(checkpoint.lang, session);
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

function exportPreparationRejectionReason(
	input: { jobId?: unknown; playbackSessionId?: unknown; outputFilename?: unknown; estimate?: unknown } | undefined,
	jobId: string | null,
	playbackSessionId: string | null,
): string | null {
	if (!input) {
		return 'missing-payload';
	}
	if (jobId === null) {
		return 'missing-job-id';
	}
	if (playbackSessionId === null) {
		return 'missing-playback-session-id';
	}
	if (playbackSessionId !== currentExtensionSessionId) {
		return 'playback-session-mismatch';
	}
	if (typeof input.outputFilename !== 'string' || input.outputFilename.length === 0) {
		return 'missing-output-filename';
	}
	if (!isAudioExportEstimate(input.estimate)) {
		return 'invalid-estimate';
	}
	if (!currentPlaybackLanguage) {
		return 'missing-playback-language';
	}
	if (!currentPlaybackStyle) {
		return 'missing-playback-style';
	}
	if (!currentVoiceStyleId) {
		return 'missing-voice-style-id';
	}
	if (speechUnits.length === 0) {
		return 'no-speech-units';
	}
	return null;
}

function prepareAudioExport(payload: unknown): { success: boolean; error?: string } {
	const input = payload as { jobId?: unknown; playbackSessionId?: unknown; outputFilename?: unknown; estimate?: unknown } | undefined;
	const jobId = typeof input?.jobId === 'string' && input.jobId.length > 0 ? input.jobId : null;
	const playbackSessionId =
		typeof input?.playbackSessionId === 'string' && input.playbackSessionId.length > 0 ? input.playbackSessionId : null;
	const payloadKeys = input && typeof input === 'object' ? Object.keys(input).sort() : [];
	const rejectionReason = exportPreparationRejectionReason(input, jobId, playbackSessionId);
	if (rejectionReason !== null) {
		exportPreparationDiagnostics.record({
			jobId,
			playbackSessionId,
			outcome: 'rejected',
			innerError: 'Audio export session is unavailable',
			reason: rejectionReason,
			payloadKeys,
		});
		return { success: false, error: 'Audio export session is unavailable' };
	}
	const acceptedInput = input!;
	const acceptedJobId = jobId!;
	const acceptedPlaybackSessionId = playbackSessionId!;
	try {
		const snapshot = {
			jobId: acceptedJobId,
			playbackSessionId: acceptedPlaybackSessionId,
			outputFilename: acceptedInput.outputFilename as string,
			units: speechUnits,
			language: currentPlaybackLanguage!,
			voiceStyleId: currentVoiceStyleId,
			speed: currentSpeed,
			estimate: acceptedInput.estimate as AudioExportEstimate,
		};
		audioExportEngine.prepare(snapshot);
		exportSnapshotDiagnostics.record(snapshot);
		exportPreparationDiagnostics.record({
			jobId,
			playbackSessionId,
			outcome: 'prepared',
			innerError: null,
			reason: null,
			payloadKeys,
		});
		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		exportPreparationDiagnostics.record({
			jobId,
			playbackSessionId,
			outcome: 'rejected',
			innerError: message,
			reason: 'engine-prepare',
			payloadKeys,
		});
		return { success: false, error: message };
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
	const internalAudioExportCommand = unwrapAudioExportOffscreenCommand(message);
	const msg = (internalAudioExportCommand ?? message) as { action: string; payload?: unknown };
	const { action, payload } = msg;
	if (isAudioExportOffscreenAction(action) && internalAudioExportCommand === null) {
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
			void (async () => {
				try {
					const res = await fetch(targetUrl);
					const blob = await res.blob();
					const reader = new FileReader();
					reader.onloadend = () => {
						const dataUrl = reader.result as string;
						const base64 = dataUrl ? (dataUrl.split(',')[1] ?? '') : '';
						sendResponse({ success: true, base64 });
					};
					reader.onerror = () => {
						sendResponse({ success: false, error: 'Failed to read file blob' });
					};
					reader.readAsDataURL(blob);
				} catch (err) {
					sendResponse({ success: false, error: (err as Error).message });
				}
			})();
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
			void (async () => {
				try {
					await audioExportEngine.cancel(jobId);
					sendResponse({ success: true });
				} catch (error) {
					sendResponse({ success: false, error: (error as Error).message });
				}
			})();
			return true;
		}

		case 'DISCARD_AUDIO_EXPORT': {
			const jobId = exportJobId(payload);
			if (!jobId) {
				sendResponse({ success: false, error: 'Missing audio export job ID' });
				break;
			}
			void (async () => {
				try {
					await audioExportEngine.discard(jobId);
					sendResponse({ success: true });
				} catch (error) {
					sendResponse({ success: false, error: (error as Error).message });
				}
			})();
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
					mediaSession?: MediaSessionMetadata;
					hasNextQueueItem?: boolean;
					pronunciationRules?: PronunciationRule[];
					ttsProvider?: TtsProviderId;
					edgeVoiceId?: string | null;
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
				// After stopAudio(), which clears the previous session's tile.
				mediaSession?.setMetadata(data.mediaSession);
				mediaSession?.setNextTrack(
					data.hasNextQueueItem ? () => void chrome.runtime.sendMessage({ action: 'SKIP_TO_NEXT_QUEUE_ITEM' }) : null,
				);
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
						const planningNormalizer = beginSessionProvider(
							data.ttsProvider === 'supertonic' ? 'supertonic' : 'edge',
							typeof data.edgeVoiceId === 'string' ? data.edgeVoiceId : null,
							normalizer,
						);
						sessionPronunciationRules = data.pronunciationRules ?? [];
						const preparedUnits = await preparePlaybackUnits(
							article.content,
							article.lang,
							planningNormalizer,
							data.pronunciationRules ?? [],
						);

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
								window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
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
						void playNextUnit(article.lang, session);
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
					await resumePlayback();
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
				try {
					if (!(await pausePlayback())) {
						sendResponse({ success: false, error: 'Audio is not running' });
						return;
					}
					sendResponse({ success: true });
				} catch (error) {
					sendResponse({ success: false, error: (error as Error).message });
				}
			})();
			return true;

		case 'STOP':
			stopPlayback();
			sendResponse({ success: true });
			break;

		case 'CHECKPOINT_MANUAL':
			sendResponse(checkpointManual(payload));
			break;

		case 'RESUME_MANUAL_CHECKPOINT':
			void (async () => {
				try {
					const response = await resumeManualCheckpoint(payload);
					sendResponse(response);
				} catch {
					sendResponse({ success: false });
				}
			})();
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
			if (playbackStatus === 'playing' && currentPlaybackLanguage && currentPlaybackStyle) {
				synthesisCoordinator.retain(retainedSynthesisKeys(playbackSession));
				prefetchNextUnit(currentPlaybackLanguage, playbackSession);
			}
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
	mediaSession?.install({
		play: () => void resumePlayback(),
		pause: () => void pausePlayback(),
		stop: () => stopPlayback(),
	});
}
