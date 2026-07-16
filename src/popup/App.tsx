import { useEffect, useRef, useState } from 'react';

import {
	BUY_ME_A_COFFEE_URL,
	PRIVACY_POLICY_URL,
	STORAGE_KEYS,
	THEME_TRANSLATIONS,
	VOICE_STYLE_TRANSLATIONS,
	VOICE_STYLES,
} from '../shared/constants';
import type { PlaybackSessionSnapshot, PlaybackStateResponse, PlaybackStatus } from '../shared/types';
import { buildFeedbackUrl } from './feedback';

type CommandResponse = { success: boolean; error?: string };
type PlaybackIconName = 'read' | 'stop' | 'pause' | 'resume';
type ThemeName = 'default' | 'winamp' | 'wmp12';

type ReadingSpeedControlProps = {
	theme: ThemeName;
	compact?: boolean;
	speed: number;
	speedProgress: number;
	onSpeedChange: (value: number) => void;
};

type VoiceControlProps = {
	className?: string;
	voice: string;
	disabled: boolean;
	onVoiceChange: (value: string) => void;
};

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

function ReadingSpeedControl({ theme, compact = false, speed, speedProgress, onSpeedChange }: ReadingSpeedControlProps) {
	const activeColor = theme === 'wmp12' ? '#1776b9' : theme === 'winamp' ? '#8fdf53' : '#008771';
	const inactiveColor = theme === 'wmp12' ? '#3c454a' : theme === 'winamp' ? '#141414' : 'rgba(255, 255, 255, 0.1)';

	return (
		<div className={`form-group ${compact ? 'wmp-speed-control' : ''}`}>
			<div className="slider-label-group">
				<span className={compact ? 'wmp-speed-value' : 'form-label'}>{compact ? `${speed.toFixed(2)}x` : t('readingSpeed')}</span>
				{!compact && <span className="slider-value">{speed.toFixed(2)}x</span>}
			</div>
			<input
				type="range"
				className="form-slider"
				aria-label={t('readingSpeed')}
				min="0.7"
				max="1.8"
				step="0.05"
				value={speed}
				style={{
					background: `linear-gradient(90deg, ${activeColor} 0%, ${activeColor} ${speedProgress}%, ${inactiveColor} ${speedProgress}%)`,
				}}
				onChange={(event) => onSpeedChange(Number.parseFloat(event.target.value))}
			/>
		</div>
	);
}

function VoiceControl({ className, voice, disabled, onVoiceChange }: VoiceControlProps) {
	return (
		<div className={className ? `form-group ${className}` : 'form-group'}>
			<label className="form-label">{t('selectVoice')}</label>
			<select className="form-select" value={voice} onChange={(event) => onVoiceChange(event.target.value)} disabled={disabled}>
				{VOICE_STYLES.map((voiceStyle) => (
					<option key={voiceStyle.id} value={voiceStyle.id}>
						{voiceStyle.gender === 'male' ? '♂️' : '♀️'}{' '}
						{VOICE_STYLE_TRANSLATIONS[uiLang][voiceStyle.id as keyof typeof VOICE_STYLE_TRANSLATIONS.en]}
					</option>
				))}
			</select>
		</div>
	);
}

export default function App() {
	// Playback state is owned by the background coordinator.
	const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
	const [currentTabId, setCurrentTabId] = useState<number | undefined>();
	const [activeTheme, setActiveTheme] = useState<ThemeName>('default');
	const [themeMenuOpen, setThemeMenuOpen] = useState(false);
	const themeSelectorButtonRef = useRef<HTMLButtonElement>(null);

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
					setActiveTheme(result[STORAGE_KEYS.THEME] as ThemeName);
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
				setModelError(`${t('modelLoadFailed')}: ${error || t('unknownError')}`);
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
				setCommandError(response.error || t('startReadingFailed'));
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

	const handleThemedPrimaryPlayback = () => {
		if (status === 'stopped' || status === 'error') {
			setModelError('');
			handleStartCurrentPage();
		} else if (status === 'playing') {
			chrome.runtime.sendMessage({ action: 'PAUSE_READING' });
		} else if (status === 'paused') {
			chrome.runtime.sendMessage({ action: 'RESUME_READING' });
		}
	};

	const handleStopReading = () => chrome.runtime.sendMessage({ action: 'STOP_READING' });

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
	const handleThemeChange = (newTheme: ThemeName) => {
		setActiveTheme(newTheme);
		setThemeMenuOpen(false);
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
					? `${t('loadingModel')}: ${loadingProgress.modelName} (${Math.round((loadingProgress.loaded / loadingProgress.total) * 100)}%)`
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

	const usesThemedTransport = activeTheme !== 'default';
	const isThemedPrimaryDisabled = status === 'loading';
	const canStopThemedPlayback = status === 'loading' || status === 'playing' || status === 'paused';
	const themedPrimaryLabel = status === 'playing' ? t('pauseState') : status === 'paused' ? t('resumeStatus') : t('readPage');

	return (
		<div className="app-container" data-theme={activeTheme}>
			{/* Header */}
			<header className="app-header">
				<div className="logo-group">
					<h1 className="logo-text">
						readit<span>.dev</span>
					</h1>
				</div>
				<span className="extension-version">v{manifestVersion}</span>
				<div
					className="theme-selector-container"
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) {
							setThemeMenuOpen(false);
						}
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							setThemeMenuOpen(false);
							themeSelectorButtonRef.current?.focus();
						}
					}}
				>
					<button
						ref={themeSelectorButtonRef}
						className="theme-selector-btn"
						aria-label={t('selectTheme')}
						aria-controls="theme-options"
						aria-expanded={themeMenuOpen}
						onClick={() => setThemeMenuOpen((open) => !open)}
					>
						🎨
					</button>
					<div id="theme-options" className={`theme-dropdown ${themeMenuOpen ? 'open' : ''}`} hidden={!themeMenuOpen}>
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
				{activeTheme === 'wmp12' && (
					<>
						<div className="wmp-artwork" aria-hidden="true">
							♪
						</div>
						<span className="wmp-now-playing-label">{t('nowPlaying')}</span>
					</>
				)}
				{/* Error Message */}
				{errorMsg && <div className="alert alert-danger">{errorMsg}</div>}

				{/* Status Indicator */}
				<div className="status-display" data-status={status} role="status">
					<div className="status-dot-pulse" data-status={status} />
					<span className="status-text">{getStatusText()}</span>
					{activeTheme === 'winamp' && status === 'playing' && (
						<div className="winamp-visualizer" aria-hidden="true">
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
									? `${t('paragraphLabel')} ${session.currentParagraphIndex + 1}/${session.totalParagraphs} • ${Math.round(session.progressPercentage)}%`
									: t('preparingContent')}
							</span>
							<span>{isSessionOnAnotherTab ? t('readingOtherTab') : t('readingThisTab')}</span>
						</div>
					</div>
				)}

				{activeTheme === 'wmp12' && (
					<VoiceControl
						className="wmp-voice-control"
						voice={activeVoice}
						disabled={status === 'playing' || status === 'loading'}
						onVoiceChange={handleVoiceChange}
					/>
				)}

				{/* Playback Progress Bar */}
				{status !== 'stopped' && status !== 'error' && (
					<div className="progress-bar-container">
						<div className="progress-bar" style={{ width: `${session?.progressPercentage ?? 0}%` }} />
					</div>
				)}

				{/* CTA Controls */}
				<div className={`controls-group ${activeTheme === 'wmp12' ? 'wmp-dock' : ''}`}>
					{usesThemedTransport ? (
						<div className={`theme-transport ${activeTheme === 'wmp12' ? 'wmp-transport' : 'winamp-deck'}`}>
							<button
								className="btn btn-icon-only theme-primary"
								disabled={isThemedPrimaryDisabled}
								onClick={handleThemedPrimaryPlayback}
								aria-label={themedPrimaryLabel}
								title={themedPrimaryLabel}
							>
								<PlaybackIcon name={status === 'playing' ? 'pause' : 'resume'} />
							</button>
							{canStopThemedPlayback && (
								<button
									className="btn btn-icon-only theme-stop"
									onClick={handleStopReading}
									aria-label={t('stopReading')}
									title={t('stopReading')}
								>
									<PlaybackIcon name="stop" />
								</button>
							)}
							{activeTheme === 'wmp12' && (
								<ReadingSpeedControl
									theme={activeTheme}
									compact
									speed={speed}
									speedProgress={speedProgress}
									onSpeedChange={handleSpeedChange}
								/>
							)}
						</div>
					) : (
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
					)}

					{session && isSessionOnAnotherTab && (
						<button className="btn btn-secondary btn-read-current-page" onClick={handleReadCurrentPage}>
							{t('readCurrentPage')}
						</button>
					)}

					<div className="privacy-disclosure" role="note">
						<span aria-hidden="true">🔒</span>
						<span>
							{t('privacyDisclosure')}{' '}
							<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
								{t('learnMore')}
							</a>
						</span>
					</div>
				</div>
			</main>

			{/* Settings Section */}
			{activeTheme !== 'wmp12' && (
				<section className="app-section">
					<h2 className="section-title">{t('voiceConfig')}</h2>
					<VoiceControl
						voice={activeVoice}
						disabled={status === 'playing' || status === 'loading'}
						onVoiceChange={handleVoiceChange}
					/>
					<ReadingSpeedControl
						theme={activeTheme}
						speed={speed}
						speedProgress={speedProgress}
						onSpeedChange={handleSpeedChange}
					/>
				</section>
			)}

			{/* Footer */}
			<footer className="app-footer">
				<div className="footer-links">
					<a className="support-link" href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noreferrer">
						<span aria-hidden="true">☕</span> {t('buyMeCoffee')}
					</a>
					<a className="support-link feedback-link" href={feedbackUrl} target="_blank" rel="noreferrer">
						{t('feedback')}
					</a>
					<a className="privacy-link" href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
						{t('privacyPolicy')}
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
