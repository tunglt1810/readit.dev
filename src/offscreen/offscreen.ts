import { MODEL_FILES, VOICE_STYLES } from '../shared/constants';
import { isPanelInstanceId } from '../shared/manual_playback';
import type { PlaybackContent, PlaybackProgress, PlaybackStatus } from '../shared/types';
import { synthesizeSpeechUnitSamples } from './audio';
import { captureManualCheckpoint, isCheckpointOwner, type ManualCheckpoint, resumeOffsetSeconds } from './manual_checkpoint';
import { isVietnameseLanguage, preparePlaybackUnits, VietnameseTextNormalizer } from './playback_preparation';
import { createSingleFlight } from './single_flight';
import type { SpeechUnit } from './speech_unit';
import { loadTextToSpeech, loadVoiceStyle, Style, TextToSpeech, writeWavFile } from './supertonic_helper';
import { IndexedSynthesisCoordinator, type SynthesisKey } from './synthesis_coordinator';
import { loadVietnameseNormalizerAssets } from './vietnamese/assets';
import { normalizeVietnameseText } from './vietnamese/normalizer';
import { computeWordTimings, findWordAtTime, predictSpokenWordDurations, type WordTimingWindow } from './word_timing';

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
let currentBuffer: AudioBuffer | null = null;
const predictedWordDurationsByBuffer = new WeakMap<AudioBuffer, readonly number[]>();
let currentBufferStartedAt = 0;
let currentBufferOffsetSec = 0;
let currentManualPanelInstanceId: string | null = null;
let currentPlaybackLanguage: string | null = null;
let currentPlaybackStyle: Style | null = null;
let currentVoiceStyleId = '';
let currentWordIndex = -1;

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

/**
 * Report playback progress to background/popup
 */
function reportProgress(status: PlaybackStatus, extra: Partial<PlaybackProgress> = {}) {
	playbackStatus = status;
	const progress: PlaybackProgress = {
		status,
		currentParagraphIndex: currentUnitIndex,
		totalParagraphs: speechUnits.length,
		progressPercentage: speechUnits.length > 0 ? Math.round((currentUnitIndex / speechUnits.length) * 100) : 0,
		...extra,
	};

	chrome.runtime.sendMessage({
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
					chrome.runtime.sendMessage({
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
					chrome.runtime.sendMessage({
						action: 'MODEL_LOADING_PROGRESS',
						progress: { loaded, total, modelName },
					});
				},
			);
			ttsEngine = result.textToSpeech;
			executionProvider = 'wasm';
		}
		chrome.runtime.sendMessage({ action: 'MODEL_LOADED', executionProvider });
	} catch (error) {
		const err = error as Error;
		chrome.runtime.sendMessage({ action: 'MODEL_LOAD_FAILED', error: err.message });
		throw err;
	}
});

function initModels(): Promise<void> {
	if (ttsEngine) {
		chrome.runtime.sendMessage({ action: 'MODEL_LOADED', executionProvider: 'cached' });
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
async function synthesizeUnit(unit: SpeechUnit, lang: string, style: Style, speed: number): Promise<AudioBuffer> {
	if (!ttsEngine) {
		throw new Error('TTS Engine is not initialized');
	}
	const engine = ttsEngine;
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
	}
	const predictedWordDurations = await predictSpokenWordDurations(unit.text, unit.wordMap ?? [], (prefixes) =>
		engine.predictDurations(
			[...prefixes],
			prefixes.map(() => lang),
			style,
			speed,
		),
	);

	const wav = await synthesizeSpeechUnitSamples(
		unit,
		lang,
		speed,
		engine.sampleRate,
		async (text, requestedLang, steps, requestedSpeed, silenceDuration) => {
			const result = await engine.call(text, requestedLang, style, steps, requestedSpeed, silenceDuration);
			return result.wav;
		},
	);

	const sampleRate = engine.sampleRate;

	// Write WAV array buffer
	const wavBuffer = writeWavFile(wav, sampleRate);

	// Decode into AudioBuffer
	const buffer = await audioCtx.decodeAudioData(wavBuffer);
	if (predictedWordDurations) {
		predictedWordDurationsByBuffer.set(buffer, predictedWordDurations);
	}
	return buffer;
}

interface SynthesisInput {
	unit: SpeechUnit;
	lang: string;
	style: Style;
	speed: number;
}

const synthesisCoordinator = new IndexedSynthesisCoordinator<SynthesisInput, AudioBuffer>(({ unit, lang, style, speed }) =>
	synthesizeUnit(unit, lang, style, speed),
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
let lastHighlightedWord: string | null = null;
let lastHighlightedManualWordIndex = -1;

function clearWordHighlightTracking() {
	if (wordHighlightTimer !== null) {
		clearInterval(wordHighlightTimer);
		wordHighlightTimer = null;
	}
	const hadGenericHighlight = lastHighlightedWord !== null;
	lastHighlightedWord = null;
	lastHighlightedManualWordIndex = -1;
	if (hadGenericHighlight) {
		chrome.runtime.sendMessage({ action: 'WORD_HIGHLIGHT_CLEAR', sessionId: currentExtensionSessionId });
	}
}

function wordIndexBase(unitIndex: number): number {
	return speechUnits.slice(0, unitIndex).reduce((count, unit) => count + (unit.wordMap?.length ?? 0), 0);
}

function startWordHighlightTracking(windows: WordTimingWindow[], unitStartTime: number, offsetSec: number, unitIndex: number) {
	clearWordHighlightTracking();
	if (windows.length === 0 || !audioCtx) {
		return;
	}
	const base = wordIndexBase(unitIndex);
	wordHighlightTimer = setInterval(() => {
		if (!audioCtx) {
			return;
		}
		const elapsed = audioCtx.currentTime - unitStartTime + offsetSec;
		const wordTiming = findWordAtTime(windows, elapsed);
		if (wordTiming === null) {
			return;
		}
		const wordIndex = base + wordTiming.wordIndex;
		if (currentManualPanelInstanceId) {
			if (wordIndex === lastHighlightedManualWordIndex) {
				return;
			}
			lastHighlightedManualWordIndex = wordIndex;
			currentWordIndex = wordIndex;
			chrome.runtime.sendMessage({
				action: 'OFFSCREEN_MANUAL_WORD_TIMING',
				sessionId: currentExtensionSessionId,
				word: wordTiming.text,
				wordIndex,
			});
			return;
		}
		if (wordTiming.text !== lastHighlightedWord) {
			lastHighlightedWord = wordTiming.text;
			chrome.runtime.sendMessage({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: currentExtensionSessionId, word: wordTiming.text });
		}
	}, 50);
}

/**
 * Stop active audio and clear state
 */
function stopAudio() {
	stopCurrentSource();
	clearWordHighlightTracking();
	isPaused = false;
	synthesisCoordinator.clear();
	reportProgress('stopped');
	speechUnits = [];
	currentUnitIndex = 0;
	currentBuffer = null;
	currentBufferStartedAt = 0;
	currentBufferOffsetSec = 0;
	currentManualPanelInstanceId = null;
	currentPlaybackLanguage = null;
	currentPlaybackStyle = null;
	currentVoiceStyleId = '';
	currentWordIndex = -1;
	pendingManualPlayback = null;
	currentExtensionSessionId = null;
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
	if (!audioCtx || currentSourceNode !== null || session !== playbackSession || unitIndex !== currentUnitIndex) {
		return;
	}
	const sourceOffsetSec = resumeOffsetSeconds({ bufferDurationSec: buffer.duration, elapsedSec: offsetSec });

	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.connect(audioCtx.destination);
	currentSourceNode = source;
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

		currentSourceNode = null;
		currentBuffer = null;
		currentBufferStartedAt = 0;
		currentBufferOffsetSec = 0;
		currentUnitIndex = unitIndex + 1;
		if (currentUnitIndex < speechUnits.length) {
			void playNextUnit(lang, style, session);
		} else {
			stopAudio();
		}
	};

	const unit = speechUnits[unitIndex];
	const spokenDurationSec = Math.max(buffer.duration - (unit?.pauseAfterMs ?? 0) / 1000, 0);
	const windows = computeWordTimings(unit?.wordMap ?? [], spokenDurationSec, predictedWordDurationsByBuffer.get(buffer));
	const unitStartTime = audioCtx.currentTime;
	source.start(0, sourceOffsetSec);
	startWordHighlightTracking(windows, unitStartTime, sourceOffsetSec, unitIndex);
}

async function playNextUnit(lang: string, style: Style, session: number) {
	if (session !== playbackSession) {
		return;
	}

	if (currentUnitIndex >= speechUnits.length) {
		stopAudio();
		return;
	}

	const unitIndex = currentUnitIndex;
	const key = synthesisKey(session, unitIndex);
	const input: SynthesisInput = {
		unit: speechUnits[unitIndex],
		lang,
		style,
		speed: currentSpeed,
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
		if (isCurrentSynthesisKey(key)) {
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

	stopCurrentSource();
	clearWordHighlightTracking();
	playbackSession++;
	isPaused = false;
	playbackStatus = 'stopped';
	speechUnits = [];
	currentUnitIndex = 0;
	currentBuffer = null;
	currentBufferStartedAt = 0;
	currentBufferOffsetSec = 0;
	currentManualPanelInstanceId = null;
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
	currentPlaybackLanguage = checkpoint.lang;
	currentPlaybackStyle = checkpoint.style;
	currentVoiceStyleId = checkpoint.voiceStyleId;
	currentSpeed = checkpoint.speed;
	speechUnits = checkpoint.speechUnits;
	currentUnitIndex = checkpoint.unitIndex;
	currentWordIndex = checkpoint.wordIndex;
	isPaused = false;
	const session = ++playbackSession;

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

// Runtime Message Listener
chrome.runtime.onMessage.addListener(
	(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
		const msg = message as { action: string; payload?: unknown };
		const { action, payload } = msg;

		switch (action) {
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
					};
					const { article, voiceStyleId, speed } = data;
					if (data.panelInstanceId !== undefined && !isPanelInstanceId(data.panelInstanceId)) {
						sendResponse({ success: false, error: 'Invalid Side Panel owner ID' });
						break;
					}
					const session = ++playbackSession;
					stopAudio();
					currentExtensionSessionId = sessionId;
					currentManualPanelInstanceId = data.panelInstanceId ?? null;
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
							currentUnitIndex = 0;
							isPaused = false;

							if (speechUnits.length === 0) {
								sendResponse({ success: false, error: 'No readable text content found.' });
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

							sendResponse({ success: true });

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
					if (audioCtx && audioCtx.state === 'running') {
						await audioCtx.suspend();
						isPaused = true;
						reportProgress('paused');
						sendResponse({ success: true });
					} else {
						sendResponse({ success: false, error: 'Audio is not running' });
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
				sendResponse({ success: true });
				break;
			}

			default:
				return undefined;
		}
	},
);
