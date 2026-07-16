import type { VoiceStyle } from './types.ts';

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
	THEME: 'readit_active_theme',
};

export const PRIVACY_POLICY_URL = 'https://tunglt1810.github.io/readit.dev/privacy-policy/';

export const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/bbeeezzzzz';

export const THEME_TRANSLATIONS = {
	vi: {
		selectTheme: 'Chọn giao diện',
		themeDefault: '📱 Hiện đại',
		themeWinamp: '🕹️ Classic (1998)',
		themeWmp12: '💿 Vista Aero (2006)',
		winampTitle: 'WINAMP CỔ ĐIỂN',
		voiceConfig: 'CẤU HÌNH GIỌNG ĐỌC',
		readCurrentPage: 'Đọc trang này thay thế',
		readPage: 'Đọc trang hiện tại',
		stopReading: 'Dừng đọc bài',
		nowPlaying: 'Đang phát',
		playingStatus: 'Đang đọc đoạn',
		readyStatus: 'Sẵn sàng đọc trang web',
		preparingState: 'Đang chuẩn bị giọng đọc...',
		pauseState: 'Tạm dừng',
		errorState: 'Lỗi hoạt động',
		resumeStatus: 'Tiếp tục',
		selectVoice: 'Chọn giọng (Supertonic 3)',
		readingSpeed: 'Tốc độ đọc',
		loadingModel: 'Đang tải model',
		modelLoadFailed: 'Không thể tải model',
		unknownError: 'Lỗi không xác định',
		startReadingFailed: 'Không thể bắt đầu đọc trang này. Vui lòng thử lại.',
		paragraphLabel: 'Đoạn',
		preparingContent: 'Đang chuẩn bị nội dung',
		readingOtherTab: 'Đang đọc ở tab khác',
		readingThisTab: 'Đang đọc ở tab này',
		privacyDisclosure: 'Nội dung được xử lý trên thiết bị, không gửi lên server.',
		learnMore: 'Tìm hiểu thêm',
		buyMeCoffee: 'Ủng hộ tôi một ly cà phê',
		feedback: 'Phản hồi',
		privacyPolicy: 'Chính sách quyền riêng tư',
	},
	en: {
		selectTheme: 'Select Theme',
		themeDefault: '📱 Modern',
		themeWinamp: '🕹️ Classic (1998)',
		themeWmp12: '💿 Vista Aero (2006)',
		winampTitle: 'WINAMP CLASSIC',
		voiceConfig: 'VOICE CONFIGURATION',
		readCurrentPage: 'Read this page instead',
		readPage: 'Read current page',
		stopReading: 'Stop reading',
		nowPlaying: 'Now Playing',
		playingStatus: 'Reading paragraph',
		readyStatus: 'Ready to read page',
		preparingState: 'Preparing voice...',
		pauseState: 'Paused',
		errorState: 'Playback Error',
		resumeStatus: 'Resume',
		selectVoice: 'Select Voice (Supertonic 3)',
		readingSpeed: 'Reading Speed',
		loadingModel: 'Loading model',
		modelLoadFailed: 'Unable to load model',
		unknownError: 'Unknown error',
		startReadingFailed: 'Unable to start reading this page. Please try again.',
		paragraphLabel: 'Paragraph',
		preparingContent: 'Preparing content',
		readingOtherTab: 'Reading in another tab',
		readingThisTab: 'Reading in this tab',
		privacyDisclosure: 'Content is processed on your device and is not sent to a server.',
		learnMore: 'Learn more',
		buyMeCoffee: 'Buy me a coffee',
		feedback: 'Feedback',
		privacyPolicy: 'Privacy Policy',
	},
} as const;

export const VOICE_STYLE_TRANSLATIONS = {
	vi: {
		M1: 'Nam 1 (Trầm)',
		M2: 'Nam 2 (Ấm)',
		M3: 'Nam 3 (Hùng)',
		M4: 'Nam 4 (Trẻ)',
		M5: 'Nam 5 (Dịu)',
		F1: 'Nữ 1 (Nhẹ)',
		F2: 'Nữ 2 (Trong)',
		F3: 'Nữ 3 (Cao)',
		F4: 'Nữ 4 (Mềm)',
		F5: 'Nữ 5 (Vang)',
	},
	en: {
		M1: 'Male 1 (Deep)',
		M2: 'Male 2 (Warm)',
		M3: 'Male 3 (Strong)',
		M4: 'Male 4 (Young)',
		M5: 'Male 5 (Gentle)',
		F1: 'Female 1 (Light)',
		F2: 'Female 2 (Clear)',
		F3: 'Female 3 (High)',
		F4: 'Female 4 (Soft)',
		F5: 'Female 5 (Resonant)',
	},
} as const;
