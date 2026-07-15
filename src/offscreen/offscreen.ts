import { MODEL_FILES, VOICE_STYLES } from '../shared/constants';
import { PlaybackProgress, PlaybackStatus } from '../shared/types';
import { synthesizeSpeechUnitSamples } from './audio';
import { isVietnameseLanguage, preparePlaybackUnits, VietnameseTextNormalizer } from './playback_preparation';
import { createSingleFlight } from './single_flight';
import type { SpeechUnit } from './speech_unit';
import { loadTextToSpeech, loadVoiceStyle, Style, TextToSpeech, writeWavFile } from './supertonic_helper';
import { IndexedSynthesisCoordinator, type SynthesisKey } from './synthesis_coordinator';
import { loadVietnameseNormalizerAssets } from './vietnamese/assets';
import { normalizeVietnameseText } from './vietnamese/normalizer';

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
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
	}

	const wav = await synthesizeSpeechUnitSamples(
		unit,
		lang,
		speed,
		ttsEngine.sampleRate,
		async (text, requestedLang, steps, requestedSpeed, silenceDuration) => {
			const result = await ttsEngine?.call(text, requestedLang, style, steps, requestedSpeed, silenceDuration);
			if (!result) {
				throw new Error('TTS Engine is not initialized');
			}
			return result.wav;
		},
	);

	const sampleRate = ttsEngine.sampleRate;

	// Write WAV array buffer
	const wavBuffer = writeWavFile(wav, sampleRate);

	// Decode into AudioBuffer
	return await audioCtx.decodeAudioData(wavBuffer);
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
	return key.session === playbackSession && key.unitIndex === currentUnitIndex && key.speedVersion === speedVersion;
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

/**
 * Stop active audio and clear state
 */
function stopAudio() {
	stopCurrentSource();
	isPaused = false;
	synthesisCoordinator.clear();
	reportProgress('stopped');
	speechUnits = [];
	currentUnitIndex = 0;
	currentExtensionSessionId = null;
}

/**
 * Play a synthesized AudioBuffer
 */
function playAudioBuffer(buffer: AudioBuffer, lang: string, style: Style, session: number, unitIndex: number) {
	if (!audioCtx || currentSourceNode !== null || session !== playbackSession || unitIndex !== currentUnitIndex) {
		return;
	}

	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.connect(audioCtx.destination);
	currentSourceNode = source;

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
		currentUnitIndex = unitIndex + 1;
		if (currentUnitIndex < speechUnits.length) {
			void playNextUnit(lang, style, session);
		} else {
			stopAudio();
		}
	};

	source.start(0);
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
			reportProgress('error', { error: (error as Error).message });
		}
	}
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
					const data = payload as { article: { content: string; lang: string }; voiceStyleId: string; speed: number };
					const { article, voiceStyleId, speed } = data;
					const session = ++playbackSession;
					stopAudio();
					currentExtensionSessionId = sessionId;
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
