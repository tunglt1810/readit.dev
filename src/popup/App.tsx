import { useEffect, useState } from 'react';

import { BUY_ME_A_COFFEE_URL, PRIVACY_POLICY_URL, STORAGE_KEYS, THEME_TRANSLATIONS, VOICE_STYLES } from '../shared/constants';
import type { PlaybackSessionSnapshot, PlaybackStateResponse, PlaybackStatus } from '../shared/types';
import { buildFeedbackUrl } from './feedback';

type CommandResponse = { success: boolean; error?: string };
type PlaybackIconName = 'read' | 'stop' | 'pause' | 'resume';

const uiLang =
	typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage
		? chrome.i18n.getUILanguage().startsWith('vi')
			? 'vi'
			: 'en'
		: 'en';

const t = (key: keyof typeof THEME_TRANSLATIONS.en) => THEME_TRANSLATIONS[uiLang][key];

function PlaybackIcon({ name }: { name: PlaybackIconName }) {
	const commonProps = {
		viewBox: '0 0 24 24',
		'aria-hidden': true,
		focusable: false,
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 2,
		strokeLinecap: 'round' as const,
		strokeLinejoin: 'round' as const,
	};

	switch (name) {
		case 'stop':
			return (
				<svg {...commonProps}>
					<rect x="7" y="7" width="10" height="10" rx="1" />
				</svg>
			);
		case 'pause':
			return (
				<svg {...commonProps}>
					<line x1="9" y1="6" x2="9" y2="18" />
					<line x1="15" y1="6" x2="15" y2="18" />
				</svg>
			);
		case 'resume':
			return (
				<svg {...commonProps}>
					<polygon points="8 5 19 12 8 19 8 5" />
				</svg>
			);
		default:
			return (
				<svg {...commonProps}>
					<path d="M5 9v6h4l5 4V5L9 9H5z" />
					<path d="M17 9a4 4 0 0 1 0 6" />
				</svg>
			);
	}
}

export default function App() {
	// Playback state is owned by the background coordinator.
	const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
	const [currentTabId, setCurrentTabId] = useState<number | undefined>();
	const [activeTheme, setActiveTheme] = useState<'default' | 'winamp' | 'wmp12'>('default');

	// Settings States
	const [activeVoice, setActiveVoice] = useState('M1');
	const [speed, setSpeed] = useState(1.05);
	const speedProgress = ((speed - 0.7) / (1.8 - 0.7)) * 100;

	// Model Loading States
	const [modelLoading, setModelLoading] = useState(false);
	const [loadingProgress, setLoadingProgress] = useState({ loaded: 0, total: 0, modelName: '' });
	const [modelError, setModelError] = useState('');
	const [commandError, setCommandError] = useState('');
	const status: PlaybackStatus = session?.status ?? 'stopped';
	const isSessionOnAnotherTab = session?.tabId !== currentTabId;
	const errorMsg = commandError || session?.error || modelError;
	const sessionHost = session ? getHost(session.url) : '';
	const manifestVersion = chrome.runtime.getManifest().version;
	const feedbackUrl = buildFeedbackUrl(manifestVersion);

	// Fetch initial states on mount
	useEffect(() => {
		// Get stored voice, speed and theme
		chrome.storage.local.get(
			[STORAGE_KEYS.ACTIVE_VOICE, STORAGE_KEYS.SPEED, STORAGE_KEYS.THEME],
			(result: { [key: string]: unknown }) => {
				if (result[STORAGE_KEYS.ACTIVE_VOICE]) {
					setActiveVoice(result[STORAGE_KEYS.ACTIVE_VOICE] as string);
				}
				if (result[STORAGE_KEYS.SPEED]) {
					setSpeed(result[STORAGE_KEYS.SPEED] as number);
				}
				if (result[STORAGE_KEYS.THEME]) {
					setActiveTheme(result[STORAGE_KEYS.THEME] as 'default' | 'winamp' | 'wmp12');
				}
			},
		);

		chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, (response: PlaybackStateResponse | undefined) => {
			if (!response) {
				return;
			}

			setSession(response.session);
			setCurrentTabId(response.currentTabId);
			if (response.session === null) {
				setModelError('');
				setCommandError('');
			}
		});

		// Listen to messages from background/offscreen
		const messageListener = (message: unknown) => {
			const msg = message as {
				action: string;
				session?: PlaybackSessionSnapshot | null;
				progress?: { loaded: number; total: number; modelName: string };
				error?: string;
			};
			const { action, progress, error } = msg;

			if (action === 'PLAYBACK_STATE_UPDATE') {
				setSession(msg.session ?? null);
				setCommandError('');
				if (msg.session === null) {
					setModelError('');
				}
			}

			if (action === 'MODEL_LOADING_PROGRESS' && progress) {
				const p = progress as { loaded: number; total: number; modelName: string };
				setModelLoading(true);
				setLoadingProgress(p);
				setModelError('');
			}

			if (action === 'MODEL_LOADED') {
				setModelLoading(false);
			}

			if (action === 'MODEL_LOAD_FAILED') {
				setModelLoading(false);
				setModelError(`Không thể tải model: ${error || 'Unknown error'}`);
			}
		};

		chrome.runtime.onMessage.addListener(messageListener);
		return () => chrome.runtime.onMessage.removeListener(messageListener);
	}, []);

	// Handler: Start/Stop Reading Page
	const handleStartCurrentPage = () => {
		setCommandError('');
		chrome.runtime.sendMessage({ action: 'START_CURRENT_PAGE' }, (response: CommandResponse | undefined) => {
			if (response?.success === false) {
				setCommandError(response.error || 'Không thể bắt đầu đọc trang này. Vui lòng thử lại.');
				return;
			}
			setCommandError('');
		});
	};

	const handleReadPage = () => {
		if (status === 'stopped' || status === 'error') {
			setModelError('');
			handleStartCurrentPage();
		} else {
			chrome.runtime.sendMessage({ action: 'STOP_READING' });
		}
	};

	// Handler: Play/Pause Audio
	const handlePlayPause = () => {
		if (status === 'playing') {
			chrome.runtime.sendMessage({ action: 'PAUSE_READING' });
		} else if (status === 'paused') {
			chrome.runtime.sendMessage({ action: 'RESUME_READING' });
		}
	};

	const handleReadCurrentPage = () => {
		setModelError('');
		handleStartCurrentPage();
	};

	// Handler: Change Voice
	const handleVoiceChange = (val: string) => {
		setActiveVoice(val);
		chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_VOICE]: val });
	};

	// Handler: Change Speed
	const handleSpeedChange = (val: number) => {
		setSpeed(val);
		chrome.storage.local.set({ [STORAGE_KEYS.SPEED]: val });
		chrome.runtime.sendMessage({ action: 'CHANGE_SPEED', payload: { speed: val } });
	};

	// Handler: Change Theme
	const handleThemeChange = (newTheme: 'default' | 'winamp' | 'wmp12') => {
		setActiveTheme(newTheme);
		chrome.storage.local.set({ [STORAGE_KEYS.THEME]: newTheme });
	};

	// Display text for active status
	const getStatusText = () => {
		if (!session) {
			return t('readyStatus');
		}

		switch (status) {
			case 'loading':
				return modelLoading
					? `Đang tải model: ${loadingProgress.modelName} (${Math.round((loadingProgress.loaded / loadingProgress.total) * 100)}%)`
					: t('preparingState');
			case 'playing':
				return `${t('playingStatus')} ${session.currentParagraphIndex + 1}/${session.totalParagraphs}`;
			case 'paused':
				return t('pauseState');
			case 'error':
				return t('errorState');
			default:
				return t('readyStatus');
		}
	};

	return (
		<div className="app-container" data-theme={activeTheme}>
			{activeTheme === 'winamp' && (
				<div className="winamp-titlebar">
					<span className="winamp-title-text">{t('winampTitle')}</span>
					<div className="winamp-window-controls">
						<span className="winamp-win-btn">_</span>
						<span className="winamp-win-btn">⬜</span>
						<span className="winamp-win-btn">X</span>
					</div>
				</div>
			)}
			{/* Header */}
			<header className="app-header">
				<div className="logo-group">
					<h1 className="logo-text">
						readit<span>.dev</span>
					</h1>
				</div>
				<span className="extension-version">v{manifestVersion}</span>
				<div className="theme-selector-container">
					<button className="theme-selector-btn" aria-label={t('selectTheme')}>
						🎨
					</button>
					<div className="theme-dropdown">
						<button
							className={`theme-opt-btn ${activeTheme === 'default' ? 'active' : ''}`}
							onClick={() => handleThemeChange('default')}
						>
							{t('themeDefault')}
						</button>
						<button
							className={`theme-opt-btn ${activeTheme === 'winamp' ? 'active' : ''}`}
							onClick={() => handleThemeChange('winamp')}
						>
							{t('themeWinamp')}
						</button>
						<button
							className={`theme-opt-btn ${activeTheme === 'wmp12' ? 'active' : ''}`}
							onClick={() => handleThemeChange('wmp12')}
						>
							{t('themeWmp12')}
						</button>
					</div>
				</div>
			</header>

			{/* Main Playback Area */}
			<main className="app-main">
				{/* Error Message */}
				{errorMsg && <div className="alert alert-danger">{errorMsg}</div>}

				{/* Status Indicator */}
				<div className="status-display" data-status={status} role="status">
					<div className="status-dot-pulse" data-status={status} />
					<span className="status-text">{getStatusText()}</span>
					{activeTheme === 'winamp' && status === 'playing' && (
						<div className="winamp-visualizer">
							<div className="v-bar" />
							<div className="v-bar" />
							<div className="v-bar" />
							<div className="v-bar" />
							<div className="v-bar" />
							<div className="v-bar" />
							<div className="v-bar" />
							<div className="v-bar" />
						</div>
					)}
				</div>

				{session && (
					<div className="session-meta">
						<span className="session-title" title={session.title}>
							{session.title}
						</span>
						<span className="session-host">{sessionHost}</span>
						<div className="session-context">
							<span>
								{session.totalParagraphs > 0
									? `Đoạn ${session.currentParagraphIndex + 1}/${session.totalParagraphs} • ${Math.round(session.progressPercentage)}%`
									: 'Đang chuẩn bị nội dung'}
							</span>
							<span>{isSessionOnAnotherTab ? 'Đang đọc ở tab khác' : 'Đang đọc ở tab này'}</span>
						</div>
					</div>
				)}

				{/* Playback Progress Bar */}
				{status !== 'stopped' && status !== 'error' && (
					<div className="progress-bar-container">
						<div className="progress-bar" style={{ width: `${session?.progressPercentage ?? 0}%` }} />
					</div>
				)}

				{/* CTA Controls */}
				<div className={`controls-group ${activeTheme === 'wmp12' ? 'wmp-dock' : ''}`}>
					<div className="playback-controls">
						{(status === 'playing' || status === 'paused') && (
							<button
								className="btn btn-secondary btn-icon-only btn-playpause"
								onClick={handlePlayPause}
								aria-label={status === 'playing' ? t('pauseState') : t('resumeStatus')}
								title={status === 'playing' ? t('pauseState') : t('resumeStatus')}
							>
								<PlaybackIcon name={status === 'playing' ? 'pause' : 'resume'} />
							</button>
						)}

						<button
							className={`btn btn-primary btn-icon-only btn-read ${status !== 'stopped' && status !== 'error' ? 'active' : ''}`}
							onClick={handleReadPage}
							aria-label={status === 'stopped' || status === 'error' ? t('readPage') : t('stopReading')}
							title={status === 'stopped' || status === 'error' ? t('readPage') : t('stopReading')}
						>
							<PlaybackIcon name={status === 'stopped' || status === 'error' ? 'read' : 'stop'} />
						</button>
					</div>

					{session && isSessionOnAnotherTab && (
						<button className="btn btn-secondary btn-read-current-page" onClick={handleReadCurrentPage}>
							{t('readCurrentPage')}
						</button>
					)}

					<div className="privacy-disclosure" role="note">
						<span aria-hidden="true">🔒</span>
						<span>
							Nội dung được xử lý trên thiết bị, không gửi lên server.{' '}
							<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
								Tìm hiểu thêm
							</a>
						</span>
					</div>
				</div>
			</main>

			{/* Settings Section */}
			<section className="app-section">
				<h2 className="section-title">{t('voiceConfig')}</h2>

				<div className="form-group">
					<label className="form-label">{t('selectVoice')}</label>
					<select
						className="form-select"
						value={activeVoice}
						onChange={(e) => handleVoiceChange(e.target.value)}
						disabled={status === 'playing' || status === 'loading'}
					>
						{VOICE_STYLES.map((voice) => (
							<option key={voice.id} value={voice.id}>
								{voice.gender === 'male' ? '♂️' : '♀️'} {voice.name}
							</option>
						))}
					</select>
				</div>

				<div className="form-group">
					<div className="slider-label-group">
						<span className="form-label">{t('readingSpeed')}</span>
						<span className="slider-value">{speed.toFixed(2)}x</span>
					</div>
					<input
						type="range"
						className="form-slider"
						min="0.7"
						max="1.8"
						step="0.05"
						value={speed}
						style={{
							background: `linear-gradient(90deg, #008771 0%, #008771 ${speedProgress}%, rgba(255, 255, 255, 0.1) ${speedProgress}%)`,
						}}
						onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
					/>
				</div>
			</section>

			{/* Footer */}
			<footer className="app-footer">
				<div className="footer-links">
					<a className="support-link" href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noreferrer">
						<span aria-hidden="true">☕</span> Buy me a coffee
					</a>
					<a className="support-link feedback-link" href={feedbackUrl} target="_blank" rel="noreferrer">
						Feedback
					</a>
					<a className="privacy-link" href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
						Privacy Policy
					</a>
				</div>
			</footer>
		</div>
	);
}

function getHost(url: string): string {
	try {
		return new URL(url).hostname;
	} catch (_error) {
		return url;
	}
}
