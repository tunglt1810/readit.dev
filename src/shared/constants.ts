import type { VoiceStyle } from './types.ts';

export const GOOGLE_DOCS_EXPORT_UNAVAILABLE = 'googleDocsExportUnavailable';

export const PDF_ERROR_CODES = {
	fileAccessRequired: 'pdfFileAccessRequired',
	passwordProtected: 'pdfPasswordProtected',
	textUnavailable: 'pdfTextUnavailable',
	extractionFailed: 'pdfExtractionFailed',
} as const;

export type PdfErrorCode = (typeof PDF_ERROR_CODES)[keyof typeof PDF_ERROR_CODES];

export const SUPERTONIC_HF_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main';

export const MODEL_FILES = {
	durationPredictor: `${SUPERTONIC_HF_BASE}/onnx/duration_predictor.onnx`,
	textEncoder: `${SUPERTONIC_HF_BASE}/onnx/text_encoder.onnx`,
	vectorEstimator: `${SUPERTONIC_HF_BASE}/onnx/vector_estimator.onnx`,
	vocoder: `${SUPERTONIC_HF_BASE}/onnx/vocoder.onnx`,
	unicodeIndexer: `${SUPERTONIC_HF_BASE}/onnx/unicode_indexer.json`,
	ttsJson: `${SUPERTONIC_HF_BASE}/onnx/tts.json`,
};

export const VOICE_STYLES: VoiceStyle[] = [
	{ id: 'M1', name: 'Nam 1 (Trầm)', path: 'assets/voice_styles/M1.json', gender: 'male' },
	{ id: 'M2', name: 'Nam 2 (Ấm)', path: 'assets/voice_styles/M2.json', gender: 'male' },
	{ id: 'M3', name: 'Nam 3 (Hùng)', path: 'assets/voice_styles/M3.json', gender: 'male' },
	{ id: 'M4', name: 'Nam 4 (Trẻ)', path: 'assets/voice_styles/M4.json', gender: 'male' },
	{ id: 'M5', name: 'Nam 5 (Dịu)', path: 'assets/voice_styles/M5.json', gender: 'male' },
	{ id: 'F1', name: 'Nữ 1 (Nhẹ)', path: 'assets/voice_styles/F1.json', gender: 'female' },
	{ id: 'F2', name: 'Nữ 2 (Trong)', path: 'assets/voice_styles/F2.json', gender: 'female' },
	{ id: 'F3', name: 'Nữ 3 (Cao)', path: 'assets/voice_styles/F3.json', gender: 'female' },
	{ id: 'F4', name: 'Nữ 4 (Mềm)', path: 'assets/voice_styles/F4.json', gender: 'female' },
	{ id: 'F5', name: 'Nữ 5 (Vang)', path: 'assets/voice_styles/F5.json', gender: 'female' },
];

export const STORAGE_KEYS = {
	ACTIVE_VOICE: 'readit_active_voice',
	SPEED: 'readit_speed',
	READ_MODE_SETTINGS: 'readit_read_mode_settings',
	PLAYBACK_SESSION: 'readit_playback_session',
	AUDIO_EXPORT_JOB: 'readit_audio_export_job',
	THEME: 'readit_active_theme',
	SELECTION_BUTTON_ENABLED: 'readit_selection_button_enabled',
	WORD_HIGHLIGHT_ENABLED: 'readit_word_highlight_enabled',
	PLAYLIST_QUEUE: 'readit_playlist_queue',
	PENDING_QUEUE_NAVIGATION: 'readit_pending_queue_navigation',
	HAS_CUSTOM_SPEED_OVERRIDE: 'readit_has_custom_speed_override',
	PRONUNCIATION_DICTIONARY: 'readit_pronunciation_dictionary',
};

export const PRIVACY_POLICY_URL = 'https://tunglt1810.github.io/readit.dev/privacy-policy/';

export const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/bbeeezzzzz';

export const DEFAULT_FALLBACK_SPEED = 1.1;
export const DEFAULT_VIETNAMESE_SPEED = 1.5;
export const DEFAULT_SPEED = DEFAULT_FALLBACK_SPEED;

export function getDefaultSpeedForLanguage(lang?: string): number {
	if (typeof lang === 'string' && /^vi(?:$|[-_])/iu.test(lang.trim())) {
		return DEFAULT_VIETNAMESE_SPEED;
	}
	return DEFAULT_FALLBACK_SPEED;
}

function isFiniteSpeed(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** A stored speed from before the explicit override marker was introduced. */
export function isLegacySpeedPreference(storedSpeed: unknown, hasCustomSpeedOverride: unknown): boolean {
	return hasCustomSpeedOverride === undefined && isFiniteSpeed(storedSpeed);
}

/** Resolve an explicit or migrated speed preference, otherwise use the content language default. */
export function resolveStoredPlaybackSpeed(
	lang: string | undefined,
	storedSpeed: unknown,
	hasCustomSpeedOverride: unknown,
): number {
	if ((hasCustomSpeedOverride === true || isLegacySpeedPreference(storedSpeed, hasCustomSpeedOverride)) && isFiniteSpeed(storedSpeed)) {
		return storedSpeed;
	}
	return getDefaultSpeedForLanguage(lang);
}
