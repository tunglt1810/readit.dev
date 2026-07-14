import { MODEL_FILES, VOICE_STYLES } from '../shared/constants';
import { PlaybackProgress, PlaybackStatus } from '../shared/types';
import { synthesizeSpeechUnitSamples } from './audio';
import { preparePlaybackUnits, VietnameseTextNormalizer } from './playback_preparation';
import { createSingleFlight } from './single_flight';
import { loadTextToSpeech, loadVoiceStyle, Style, TextToSpeech, writeWavFile } from './supertonic_helper';
import { loadVietnameseNormalizerAssets } from './vietnamese/assets';
import { normalizeVietnameseText } from './vietnamese/normalizer';
import { SpeechUnit } from './vietnamese/types';

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
let nextChunkBuffer: AudioBuffer | null = null;
let isPreFetching = false;
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

	const wav =
		lang === 'vi'
			? await synthesizeSpeechUnitSamples(
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
				)
			: (await ttsEngine.call(unit.text, lang, style, 8, speed, 0.3)).wav;

	const sampleRate = ttsEngine.sampleRate;

	// Write WAV array buffer
	const wavBuffer = writeWavFile(wav, sampleRate);

	// Decode into AudioBuffer
	return await audioCtx.decodeAudioData(wavBuffer);
}

/**
 * Pre-fetch and synthesize the next chunk in the background
 */
async function preFetchNextChunk(lang: string, style: Style, session: number) {
	if (isPreFetching || currentUnitIndex + 1 >= speechUnits.length) {
		return;
	}
	const requestSpeed = currentSpeed;
	const requestSpeedVersion = speedVersion;
	isPreFetching = true;

	try {
		const nextIndex = currentUnitIndex + 1;
		const unit = speechUnits[nextIndex];

		const buffer = await synthesizeUnit(unit, lang, style, requestSpeed);
		if (session !== playbackSession || requestSpeedVersion !== speedVersion) {
			return;
		}
		nextChunkBuffer = buffer;
	} catch (_error) {
		if (session === playbackSession && requestSpeedVersion === speedVersion) {
			nextChunkBuffer = null;
		}
	} finally {
		if (session === playbackSession && requestSpeedVersion === speedVersion) {
			isPreFetching = false;
		}
	}
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
	nextChunkBuffer = null;
	isPreFetching = false;
	reportProgress('stopped');
	speechUnits = [];
	currentUnitIndex = 0;
	currentExtensionSessionId = null;
}

/**
 * Play a synthesized AudioBuffer
 */
function playAudioBuffer(buffer: AudioBuffer, lang: string, style: Style, session: number) {
	if (!audioCtx || session !== playbackSession) {
		return;
	}

	stopCurrentSource();

	// Create AudioBufferSourceNode
	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.connect(audioCtx.destination);
	currentSourceNode = source;

	reportProgress('playing');

	// When current chunk ends, trigger next chunk
	source.onended = () => {
		if (currentSourceNode !== source || session !== playbackSession || playbackStatus === 'stopped' || isPaused) {
			return;
		}

		currentSourceNode = null;
		currentUnitIndex++;
		if (currentUnitIndex < speechUnits.length) {
			playNextChunk(lang, style, session);
		} else {
			stopAudio();
		}
	};

	source.start(0);
}

/**
 * Plays the current chunk index, using pre-fetched buffer if available
 */
async function playNextChunk(lang: string, style: Style, session: number) {
	if (session !== playbackSession) {
		return;
	}

	if (currentUnitIndex >= speechUnits.length) {
		stopAudio();
		return;
	}

	const unit = speechUnits[currentUnitIndex];

	// Check if we have pre-fetched buffer
	if (nextChunkBuffer) {
		const buffer = nextChunkBuffer;
		nextChunkBuffer = null;
		playAudioBuffer(buffer, lang, style, session);

		// Start pre-fetching the one after
		preFetchNextChunk(lang, style, session);
	} else {
		// If no pre-fetch, show loading state and synthesize on the fly
		reportProgress('loading');
		const requestSpeed = currentSpeed;
		const requestSpeedVersion = speedVersion;
		try {
			const buffer = await synthesizeUnit(unit, lang, style, requestSpeed);
			if (session !== playbackSession || requestSpeedVersion !== speedVersion) {
				if (session === playbackSession && requestSpeedVersion !== speedVersion) {
					playNextChunk(lang, style, session);
				}
				return;
			}
			playAudioBuffer(buffer, lang, style, session);

			// Start pre-fetching next
			preFetchNextChunk(lang, style, session);
		} catch (error) {
			const err = error as Error;
			if (session === playbackSession && requestSpeedVersion === speedVersion) {
				reportProgress('error', { error: err.message });
			}
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
					const session = ++playbackSession;
					stopAudio();
					currentExtensionSessionId = sessionId;

					(async () => {
						try {
							const data = payload as { article: { content: string; lang: string }; voiceStyleId: string; speed: number };
							const { article, voiceStyleId, speed } = data;
							let normalizer: VietnameseTextNormalizer | null = null;
							if (article.lang === 'vi') {
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

							currentSpeed = speed;
							speechUnits = preparedUnits;
							currentUnitIndex = 0;
							nextChunkBuffer = null;
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
							playNextChunk(article.lang, style, session);
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
				nextChunkBuffer = null;
				isPreFetching = false;
				reportProgress(playbackStatus);
				sendResponse({ success: true });
				break;
			}

			default:
				return undefined;
		}
	},
);
