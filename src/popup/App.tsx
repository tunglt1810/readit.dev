import { useEffect, useRef, useState } from 'react';

import { isFileSystemAccessSupported } from '../reader/book_loader';
import { openSidebarOrPanel } from '../shared/browser';
import { AudioExportButton } from '../shared/components/AudioExportButton';
import { PlaybackControlButton } from '../shared/components/PlaybackControlButton';
import { PlaybackIcon } from '../shared/components/PlaybackIcon';
import { SettingsCard } from '../shared/components/SettingsCard';
import { TranslateReadButton } from '../shared/components/TranslateReadButton';
import { BUY_ME_A_COFFEE_URL, DEFAULT_SPEED, PRIVACY_POLICY_URL, resolveStoredPlaybackSpeed, STORAGE_KEYS } from '../shared/constants';
import { getLocalizedPlaybackError, t } from '../shared/i18n';
import { requestPlaybackState, sendPlaybackCommand, subscribePlaybackState } from '../shared/playback_client';
import { resolvePlaybackStatus } from '../shared/playback_status';
import { isSelectionButtonEnabled } from '../shared/selection_button';
import { isTranslationAvailable } from '../shared/translation_availability';
import { readTranslationTarget, writeTranslationTarget } from '../shared/translation_target_store';
import type { PlaybackSessionSnapshot, PlaybackStatus, ThemeName, TranslationTarget } from '../shared/types';
import { getDisplayVersion } from '../shared/version';
import { isWordHighlightEnabled } from '../shared/word_highlight';
import { buildFeedbackUrl } from './feedback';
import { openSidePanelForCurrentWindow, shouldFallbackToOpen } from './side_panel';

export default function App() {
	// Playback state is owned by the background coordinator.
	const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
	const [currentTabId, setCurrentTabId] = useState<number | undefined>();
	const [sidePanelWindowId, setSidePanelWindowId] = useState<number | undefined>();
	const [activeTheme, setActiveTheme] = useState<ThemeName>('default');
	const primaryButtonRef = useRef<HTMLButtonElement>(null);

	// Settings States
	const [activeVoice, setActiveVoice] = useState('M1');
	const [speed, setSpeed] = useState(DEFAULT_SPEED);
	const [selectionButtonEnabled, setSelectionButtonEnabled] = useState(true);
	const [wordHighlightEnabled, setWordHighlightEnabled] = useState(true);
	const [openSidePanelWindows, setOpenSidePanelWindows] = useState<number[]>([]);

	const hasUserChangedVoiceRef = useRef(false);
	const hasUserChangedSpeedRef = useRef(false);
	const hasUserChangedThemeRef = useRef(false);
	const hasUserChangedSelectionButtonRef = useRef(false);
	const hasUserChangedWordHighlightRef = useRef(false);

	// Model Loading States
	const [modelLoading, setModelLoading] = useState(false);
	const [loadingProgress, setLoadingProgress] = useState({ loaded: 0, total: 0, modelName: '' });
	const [modelError, setModelError] = useState('');
	const [commandError, setCommandError] = useState('');
	// Non-null exactly when this browser can translate, which is also what reveals the control.
	const [translationTarget, setTranslationTarget] = useState<TranslationTarget | null>(null);
	const [translationNotice, setTranslationNotice] = useState('');
	const status: PlaybackStatus = resolvePlaybackStatus(session);
	const tabSource = session?.source.kind === 'tab' ? session.source : null;
	const isSessionOnAnotherTab = tabSource !== null && tabSource.tabId !== currentTabId;
	const sessionTitle = session?.contentScope === 'manual' ? t('pastedText') : (tabSource?.title ?? '');
	const errorMsg = getLocalizedPlaybackError(commandError || session?.error || modelError);
	const sessionHost = tabSource ? getHost(tabSource.url) : '';
	const displayVersion = getDisplayVersion();
	const feedbackUrl = buildFeedbackUrl(displayVersion);

	// Fetch initial states on mount
	useEffect(() => {
		let latestSessionSpeed: number | undefined;
		let latestSessionLanguage: string | undefined;
		// Get stored voice, speed and theme
		chrome.storage.local.get(
			[
				STORAGE_KEYS.ACTIVE_VOICE,
				STORAGE_KEYS.SPEED,
				STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE,
				STORAGE_KEYS.THEME,
				STORAGE_KEYS.SELECTION_BUTTON_ENABLED,
				STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED,
			],
			(result: { [key: string]: unknown }) => {
				if (!hasUserChangedVoiceRef.current && result[STORAGE_KEYS.ACTIVE_VOICE]) {
					setActiveVoice(result[STORAGE_KEYS.ACTIVE_VOICE] as string);
				}
				if (!hasUserChangedSpeedRef.current && latestSessionSpeed === undefined) {
					setSpeed(
						resolveStoredPlaybackSpeed(
							latestSessionLanguage,
							result[STORAGE_KEYS.SPEED],
							result[STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE],
						),
					);
				}
				if (!hasUserChangedThemeRef.current && result[STORAGE_KEYS.THEME]) {
					setActiveTheme(result[STORAGE_KEYS.THEME] as ThemeName);
				}
				if (!hasUserChangedSelectionButtonRef.current) {
					setSelectionButtonEnabled(isSelectionButtonEnabled(result[STORAGE_KEYS.SELECTION_BUTTON_ENABLED]));
				}
				if (!hasUserChangedWordHighlightRef.current) {
					setWordHighlightEnabled(isWordHighlightEnabled(result[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]));
				}
			},
		);

		void requestPlaybackState().then((response) => {
			setSession(response.session);
			latestSessionLanguage = response.session?.lang;
			if (response.session && typeof response.session.speed === 'number' && Number.isFinite(response.session.speed)) {
				latestSessionSpeed = response.session.speed;
				setSpeed(response.session.speed);
			}
			setCurrentTabId(response.currentTabId);
			if (response.session === null) {
				setModelError('');
				setCommandError('');
			}
		});
		const unsubscribePlayback = subscribePlaybackState(chrome.runtime, (nextSession) => {
			setSession(nextSession);
			latestSessionLanguage = nextSession?.lang;
			if (nextSession && typeof nextSession.speed === 'number' && Number.isFinite(nextSession.speed)) {
				latestSessionSpeed = nextSession.speed;
				setSpeed(nextSession.speed);
			}
			setCommandError('');
			if (nextSession === null) {
				setModelError('');
			}
		});

		void chrome.tabs.query({ active: true, currentWindow: true }).then(
			([tab]) => setSidePanelWindowId(tab?.windowId),
			() => setSidePanelWindowId(undefined),
		);

		// Listen to messages from background/offscreen
		const messageListener = (message: unknown) => {
			const msg = message as {
				action: string;
				progress?: { loaded: number; total: number; modelName: string };
				error?: string;
			};
			const { action, progress, error } = msg;

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
		return () => {
			unsubscribePlayback();
			chrome.runtime.onMessage.removeListener(messageListener);
		};
	}, []);

	useEffect(() => {
		primaryButtonRef.current?.focus();
	}, [session, activeTheme]);

	useEffect(() => {
		if (typeof chrome !== 'undefined' && chrome.storage?.local) {
			chrome.storage.local.get(['readit_open_sidepanel_windows'], (res) => {
				if (Array.isArray(res?.readit_open_sidepanel_windows)) {
					setOpenSidePanelWindows(res.readit_open_sidepanel_windows);
				}
			});
		}

		const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
			// The side panel can be open alongside this popup and switch the theme out from under it.
			const nextTheme = changes[STORAGE_KEYS.THEME]?.newValue;
			if (nextTheme === 'default' || nextTheme === 'winamp' || nextTheme === 'wmp12') {
				setActiveTheme(nextTheme);
			}
			if (changes.readit_open_sidepanel_windows) {
				const newValue = changes.readit_open_sidepanel_windows.newValue;
				if (Array.isArray(newValue)) {
					setOpenSidePanelWindows(newValue);
				} else {
					setOpenSidePanelWindows([]);
				}
			}
		};

		if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
			chrome.storage.onChanged.addListener(handleStorageChange);
		}

		return () => {
			if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
				chrome.storage.onChanged.removeListener(handleStorageChange);
			}
		};
	}, []);

	// Handler: Start/Stop Reading Page
	const handleStartCurrentPage = () => {
		setCommandError('');
		void sendPlaybackCommand({ action: 'START_CURRENT_PAGE' }).then((response) => {
			if (response?.success === false) {
				setCommandError(
					response.transportError
						? t('startReadingFailed')
						: (getLocalizedPlaybackError(response.error) ?? t('startReadingFailed')),
				);
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
			void sendPlaybackCommand({ action: 'STOP_READING' });
		}
	};

	// Handler: Play/Pause Audio
	const handlePlayPause = () => {
		if (status === 'playing') {
			void sendPlaybackCommand({ action: 'PAUSE_READING' });
		} else if (status === 'paused') {
			void sendPlaybackCommand({ action: 'RESUME_READING' });
		}
	};

	const handleThemedPrimaryPlayback = () => {
		if (status === 'stopped' || status === 'error') {
			setModelError('');
			handleStartCurrentPage();
		} else if (status === 'playing') {
			void sendPlaybackCommand({ action: 'PAUSE_READING' });
		} else if (status === 'paused') {
			void sendPlaybackCommand({ action: 'RESUME_READING' });
		}
	};

	const handleStopReading = () => void sendPlaybackCommand({ action: 'STOP_READING' });

	const handleReadCurrentPage = () => {
		setModelError('');
		handleStartCurrentPage();
	};

	useEffect(() => {
		void isTranslationAvailable().then(async (available) => {
			if (available) {
				setTranslationTarget(await readTranslationTarget());
			}
		});
	}, []);

	const handleTranslationTargetChange = (target: TranslationTarget) => {
		setTranslationTarget(target);
		void writeTranslationTarget(target);
	};

	const handleTranslateAndRead = () => {
		setModelError('');
		setCommandError('');
		setTranslationNotice('');
		void sendPlaybackCommand({ action: 'START_CURRENT_PAGE_TRANSLATED' }).then((response) => {
			if (!response?.success) {
				setCommandError(getLocalizedPlaybackError(response?.error) ?? t('startReadingFailed'));
				return;
			}
			// Silence here is what made the feature look broken: the page is read untranslated and
			// nothing says why.
			if (response.translated === false) {
				setTranslationNotice(t('translationSkipped'));
			}
		});
	};

	const handleOpenBook = () => {
		void chrome.tabs.create({ url: chrome.runtime.getURL('src/reader/reader.html') });
	};

	const isSidePanelOpen = Boolean(sidePanelWindowId && openSidePanelWindows.includes(sidePanelWindowId));

	const handleToggleSidePanel = () => {
		setCommandError('');
		if (isSidePanelOpen) {
			if (sidePanelWindowId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
				chrome.runtime.sendMessage({ action: 'CLOSE_SIDEPANEL', payload: { windowId: sidePanelWindowId } }, (response) => {
					if (shouldFallbackToOpen(response)) {
						void openSidePanelForCurrentWindow({
							windowId: sidePanelWindowId,
							open: (options) => openSidebarOrPanel(options.windowId),
						}).catch(() => setCommandError(t('openSidePanelFailed')));
					}
				});
			}
		} else {
			void openSidePanelForCurrentWindow({
				windowId: sidePanelWindowId,
				open: (options) => openSidebarOrPanel(options.windowId),
			}).catch(() => setCommandError(t('openSidePanelFailed')));
		}
	};

	// Handler: Change Voice
	const handleVoiceChange = (val: string) => {
		hasUserChangedVoiceRef.current = true;
		setActiveVoice(val);
		chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_VOICE]: val });
	};

	// Handler: Change Speed
	const handleSpeedChange = (val: number) => {
		hasUserChangedSpeedRef.current = true;
		setSpeed(val);
		chrome.storage.local.set({
			[STORAGE_KEYS.SPEED]: val,
			[STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE]: true,
		});
		void sendPlaybackCommand({ action: 'CHANGE_SPEED', payload: { speed: val } });
	};

	// Handler: Change Theme
	const handleThemeChange = (newTheme: ThemeName) => {
		hasUserChangedThemeRef.current = true;
		setActiveTheme(newTheme);
		chrome.storage.local.set({ [STORAGE_KEYS.THEME]: newTheme });
	};

	const handleSelectionButtonEnabledChange = (enabled: boolean) => {
		hasUserChangedSelectionButtonRef.current = true;
		setSelectionButtonEnabled(enabled);
		void chrome.storage.local.set({ [STORAGE_KEYS.SELECTION_BUTTON_ENABLED]: enabled });
	};

	const handleWordHighlightEnabledChange = (enabled: boolean) => {
		hasUserChangedWordHighlightRef.current = true;
		setWordHighlightEnabled(enabled);
		void chrome.storage.local.set({ [STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]: enabled });
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
				<span className="extension-version">v{displayVersion}</span>
				<a className="support-link header-support-link" href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noreferrer">
					<PlaybackIcon name="coffee" /> {t('buyMeCoffee')}
				</a>
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
				{translationNotice && (
					<div className="alert alert-info translation-skipped-notice" role="status">
						{translationNotice}
					</div>
				)}

				{/* Status Indicator Row */}
				<div className="status-row">
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
					<div className="status-row-actions">
						{isFileSystemAccessSupported() && (
							<button
								className="btn-icon-openbook btn-open-book"
								type="button"
								onClick={handleOpenBook}
								aria-label={t('openBook')}
								data-tooltip={t('openBook')}
							>
								<PlaybackIcon name="book" />
							</button>
						)}
						<button
							className={`btn-icon-sidepanel ${isSidePanelOpen ? 'active' : ''}`}
							type="button"
							onClick={handleToggleSidePanel}
							aria-label={isSidePanelOpen ? t('closeSidePanel') : t('openSidePanel')}
							aria-pressed={isSidePanelOpen}
							data-tooltip={isSidePanelOpen ? t('closeSidePanel') : t('openSidePanel')}
						>
							<PlaybackIcon name="sidepanel" />
						</button>
					</div>
				</div>

				{session && (
					<div className="session-meta">
						<span className="session-title" title={sessionTitle}>
							{sessionTitle}
						</span>
						{sessionHost && <span className="session-host">{sessionHost}</span>}
						<div className="session-context">
							<span>
								{session.totalParagraphs > 0
									? `${t('paragraphLabel')} ${session.currentParagraphIndex + 1}/${session.totalParagraphs} • ${Math.round(session.progressPercentage)}% `
									: t('preparingContent')}
							</span>
							<span>
								{session.contentScope === 'manual'
									? t('manualSession')
									: isSessionOnAnotherTab
										? t('readingOtherTab')
										: t('readingThisTab')}
							</span>
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
					{usesThemedTransport ? (
						<div className={`theme-transport ${activeTheme === 'wmp12' ? 'wmp-transport' : 'winamp-deck'}`}>
							<button
								ref={primaryButtonRef}
								className="btn btn-icon-only theme-primary"
								disabled={isThemedPrimaryDisabled}
								onClick={handleThemedPrimaryPlayback}
								aria-label={themedPrimaryLabel}
								title={themedPrimaryLabel}
								data-tooltip={themedPrimaryLabel}
							>
								<PlaybackIcon name={status === 'playing' ? 'pause' : 'resume'} />
							</button>
							{canStopThemedPlayback && (
								<button
									className="btn btn-icon-only theme-stop"
									onClick={handleStopReading}
									aria-label={t('stopReading')}
									title={t('stopReading')}
									data-tooltip={t('stopReading')}
								>
									<PlaybackIcon name="stop" />
								</button>
							)}
							{translationTarget && (status === 'stopped' || status === 'error') && (
								<TranslateReadButton target={translationTarget} onClick={handleTranslateAndRead} />
							)}
							<AudioExportButton session={session} />
						</div>
					) : (
						<div className="playback-controls">
							{(status === 'playing' || status === 'paused') && (
								<button
									ref={primaryButtonRef}
									className="btn btn-secondary btn-icon-only btn-playpause"
									onClick={handlePlayPause}
									aria-label={status === 'playing' ? t('pauseState') : t('resumeStatus')}
									title={status === 'playing' ? t('pauseState') : t('resumeStatus')}
									data-tooltip={status === 'playing' ? t('pauseState') : t('resumeStatus')}
								>
									<PlaybackIcon name={status === 'playing' ? 'pause' : 'resume'} />
								</button>
							)}
							<PlaybackControlButton
								status={status}
								onClick={handleReadPage}
								buttonRef={status === 'playing' || status === 'paused' ? undefined : primaryButtonRef}
							/>
							{/* Beside the read button, not beside export: it is another way to start, not a follow-up. */}
							{translationTarget && (status === 'stopped' || status === 'error') && (
								<TranslateReadButton target={translationTarget} onClick={handleTranslateAndRead} />
							)}
							<AudioExportButton session={session} />
						</div>
					)}

					{session && isSessionOnAnotherTab && (
						<button className="btn btn-secondary btn-read-current-page" onClick={handleReadCurrentPage}>
							{t('readCurrentPage')}
						</button>
					)}

					<div className="privacy-disclosure" role="note">
						<PlaybackIcon name="lock" />
						<span>
							{t('privacyDisclosure')}{' '}
							<a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
								{t('learnMore')}
							</a>
						</span>
					</div>
				</div>
			</main>

			<SettingsCard
				collapsible={false}
				theme={activeTheme}
				activeVoice={activeVoice}
				speed={speed}
				selectionButtonEnabled={selectionButtonEnabled}
				wordHighlightEnabled={wordHighlightEnabled}
				playbackStatus={status}
				translationTarget={translationTarget}
				onVoiceChange={handleVoiceChange}
				onSpeedChange={handleSpeedChange}
				onSelectionButtonEnabledChange={handleSelectionButtonEnabledChange}
				onWordHighlightEnabledChange={handleWordHighlightEnabledChange}
				onThemeChange={handleThemeChange}
				onTranslationTargetChange={handleTranslationTargetChange}
			/>

			{/* Footer */}
			<footer className="app-footer">
				<div className="footer-links">
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
