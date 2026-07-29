import { useEffect, useRef, useState } from 'react';

import { buildSidePanelRegisterMessage } from '../popup/side_panel.ts';
import { PlaybackControlButton } from '../shared/components/PlaybackControlButton.tsx';
import { PlaybackIcon } from '../shared/components/PlaybackIcon.tsx';
import { SettingsCard } from '../shared/components/SettingsCard.tsx';
import { BUY_ME_A_COFFEE_URL, DEFAULT_SPEED, STORAGE_KEYS } from '../shared/constants.ts';
import { getLocalizedPlaybackError, t } from '../shared/i18n.ts';
import { normalizeManualText } from '../shared/manual_text.ts';
import { requestPlaybackState, sendPlaybackCommand, sendRuntimeRequest, subscribePlaybackState } from '../shared/playback_client.ts';
import { isSelectionButtonEnabled } from '../shared/selection_button.ts';
import type { ManualTextLanguage, PageInfoResponse, PlaybackSessionSnapshot, ThemeName } from '../shared/types.ts';
import { isWordHighlightEnabled } from '../shared/word_highlight.ts';
import { advanceManualHighlight, createManualHighlightCursor, type ManualWordRange } from './manual_word_highlight.ts';

const EMPTY_PAGE_INFO: PageInfoResponse = { available: false };

function getHost(url: string): string {
	try {
		return new URL(url).host;
	} catch (_error) {
		return '';
	}
}

function getStatusText(session: PlaybackSessionSnapshot | null): string {
	if (!session) {
		return t('readyStatus');
	}
	if (session.status === 'loading') {
		return t('preparingState');
	}
	if (session.status === 'playing') {
		return `${t('playingStatus')} ${session.currentParagraphIndex + 1}/${session.totalParagraphs}`;
	}
	if (session.status === 'paused') {
		return t('pauseState');
	}
	if (session.status === 'error') {
		return t('errorState');
	}
	return t('readyStatus');
}

export default function App() {
	const [panelInstanceId] = useState(() => crypto.randomUUID());
	const [draft, setDraft] = useState('');
	const [manualReaderText, setManualReaderText] = useState<string | null>(null);
	const [manualHighlight, setManualHighlight] = useState<ManualWordRange | null>(null);
	const [manualCheckpointState, setManualCheckpointState] = useState<'suspended' | null>(null);
	const [language, setLanguage] = useState<ManualTextLanguage>('auto');
	const [commandError, setCommandError] = useState('');
	const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
	const [activeVoice, setActiveVoice] = useState('M1');
	const [speed, setSpeed] = useState(DEFAULT_SPEED);
	const [theme, setTheme] = useState<ThemeName>('default');
	const [selectionButtonEnabled, setSelectionButtonEnabled] = useState(true);
	const [wordHighlightEnabled, setWordHighlightEnabled] = useState(true);
	const [pageInfo, setPageInfo] = useState<PageInfoResponse>(EMPTY_PAGE_INFO);
	const readerRef = useRef<HTMLDivElement>(null);
	const primaryButtonRef = useRef<HTMLButtonElement>(null);
	const manualHighlightCursorRef = useRef<ReturnType<typeof createManualHighlightCursor> | null>(null);
	const manualReaderSessionIdRef = useRef<string | null>(null);

	useEffect(() => {
		primaryButtonRef.current?.focus();
	}, [session]);

	const clearManualReader = () => {
		setManualReaderText(null);
		manualReaderSessionIdRef.current = null;
		setManualHighlight(null);
		manualHighlightCursorRef.current = null;
		setManualCheckpointState(null);
	};

	useEffect(() => {
		chrome.storage.local.get(
			[
				STORAGE_KEYS.ACTIVE_VOICE,
				STORAGE_KEYS.SPEED,
				STORAGE_KEYS.THEME,
				STORAGE_KEYS.SELECTION_BUTTON_ENABLED,
				STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED,
			],
			(result) => {
				const storedVoice = result[STORAGE_KEYS.ACTIVE_VOICE];
				const storedSpeed = result[STORAGE_KEYS.SPEED];
				const storedTheme = result[STORAGE_KEYS.THEME];
				if (typeof storedVoice === 'string') {
					setActiveVoice(storedVoice);
				}
				if (typeof storedSpeed === 'number') {
					setSpeed(storedSpeed);
				}
				if (storedTheme === 'default' || storedTheme === 'winamp' || storedTheme === 'wmp12') {
					setTheme(storedTheme);
				}
				setSelectionButtonEnabled(isSelectionButtonEnabled(result[STORAGE_KEYS.SELECTION_BUTTON_ENABLED]));
				setWordHighlightEnabled(isWordHighlightEnabled(result[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]));
			},
		);

		void requestPlaybackState().then((response) => setSession(response.session));
		void sendRuntimeRequest<PageInfoResponse>({ action: 'GET_CURRENT_PAGE_INFO' }).then(setPageInfo, () =>
			setPageInfo(EMPTY_PAGE_INFO),
		);
		const unsubscribePlayback = subscribePlaybackState(chrome.runtime, setSession);
		const handleManualPlaybackMessage = (message: unknown) => {
			if (!message || typeof message !== 'object') {
				return;
			}
			const value = message as Record<string, unknown>;
			if (value.action === 'PLAYBACK_STATE_UPDATE') {
				const nextSession = value.session as PlaybackSessionSnapshot | null;
				if (nextSession?.contentScope === 'manual' && nextSession.source.panelInstanceId === panelInstanceId) {
					manualReaderSessionIdRef.current = nextSession.sessionId;
				}
				return;
			}
			if (value.action === 'MANUAL_WORD_HIGHLIGHT_CLEAR') {
				if (value.sessionId === manualReaderSessionIdRef.current) {
					setManualHighlight(null);
				}
				return;
			}
			if (value.action === 'MANUAL_WORD_HIGHLIGHT_UPDATE') {
				if (
					typeof value.sessionId !== 'string' ||
					value.sessionId !== manualReaderSessionIdRef.current ||
					typeof value.word !== 'string' ||
					typeof value.wordIndex !== 'number' ||
					!Number.isInteger(value.wordIndex)
				) {
					return;
				}
				const cursor = manualHighlightCursorRef.current;
				if (!cursor) {
					return;
				}
				const result = advanceManualHighlight(cursor, { word: value.word, wordIndex: value.wordIndex });
				if (result.kind === 'matched') {
					setManualHighlight(result.range);
				} else if (result.kind === 'unmatched') {
					setManualHighlight(null);
				}
				return;
			}
			if (value.action !== 'MANUAL_CHECKPOINT_STATE_UPDATE' || value.panelInstanceId !== panelInstanceId) {
				return;
			}
			if (value.state === 'suspended') {
				setManualCheckpointState('suspended');
			} else if (value.state === 'active') {
				setManualCheckpointState(null);
			} else if (value.state === 'discarded') {
				clearManualReader();
			} else if (value.state === 'unavailable') {
				clearManualReader();
				setCommandError(t('manualCheckpointUnavailable'));
			}
		};
		chrome.runtime.onMessage.addListener(handleManualPlaybackMessage);
		const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
			if (areaName !== 'local') {
				return;
			}
			const nextVoice = changes[STORAGE_KEYS.ACTIVE_VOICE]?.newValue;
			if (typeof nextVoice === 'string') {
				setActiveVoice(nextVoice);
			}
			const nextSpeed = changes[STORAGE_KEYS.SPEED]?.newValue;
			if (typeof nextSpeed === 'number' && Number.isFinite(nextSpeed) && nextSpeed >= 0.7 && nextSpeed <= 1.8) {
				setSpeed(nextSpeed);
			}
			const nextTheme = changes[STORAGE_KEYS.THEME]?.newValue;
			if (nextTheme === 'default' || nextTheme === 'winamp' || nextTheme === 'wmp12') {
				setTheme(nextTheme);
			}
			if (changes[STORAGE_KEYS.SELECTION_BUTTON_ENABLED] !== undefined) {
				setSelectionButtonEnabled(isSelectionButtonEnabled(changes[STORAGE_KEYS.SELECTION_BUTTON_ENABLED].newValue));
			}
			if (changes[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED] !== undefined) {
				setWordHighlightEnabled(isWordHighlightEnabled(changes[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED].newValue));
			}
		};
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			unsubscribePlayback();
			chrome.runtime.onMessage.removeListener(handleManualPlaybackMessage);
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, [panelInstanceId]);

	useEffect(() => {
		if (!manualReaderText || !session || session.contentScope !== 'manual' || session.source.panelInstanceId !== panelInstanceId) {
			return;
		}
		manualReaderSessionIdRef.current = session.sessionId;
		if (session.status === 'stopped' || session.status === 'error') {
			clearManualReader();
		}
	}, [manualReaderText, panelInstanceId, session]);

	useEffect(() => {
		const activeWord = readerRef.current?.querySelector<HTMLElement>('.manual-reader-active-word');
		if (!activeWord || !readerRef.current) {
			return;
		}
		const reader = readerRef.current;
		const wordBounds = activeWord.getBoundingClientRect();
		const readerBounds = reader.getBoundingClientRect();
		if (wordBounds.top < readerBounds.top) {
			reader.scrollTop += wordBounds.top - readerBounds.top;
		} else if (wordBounds.bottom > readerBounds.bottom) {
			reader.scrollTop += wordBounds.bottom - readerBounds.bottom;
		}
	}, [manualHighlight]);

	useEffect(() => {
		const handlePageHide = () => {
			void sendPlaybackCommand({ action: 'STOP_SIDE_PANEL_AUDIO', panelInstanceId });
		};
		window.addEventListener('pagehide', handlePageHide);
		return () => window.removeEventListener('pagehide', handlePageHide);
	}, [panelInstanceId]);

	useEffect(() => {
		let port: chrome.runtime.Port | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

		const connectPort = () => {
			try {
				if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
					port = chrome.runtime.connect({ name: 'sidepanel-port' });

					if (typeof chrome !== 'undefined' && chrome.windows?.getCurrent) {
						chrome.windows.getCurrent((win) => {
							if (win?.id && port) {
								try {
									port.postMessage(buildSidePanelRegisterMessage(win.id));
								} catch (_e) {
									// ignore
								}
							}
						});
					}

					port.onMessage?.addListener((msg) => {
						if (msg?.action === 'CLOSE_SIDEPANEL') {
							window.close();
						}
					});

					port.onDisconnect?.addListener(() => {
						port = null;
						reconnectTimer = setTimeout(connectPort, 1000);
					});
				}
			} catch (_e) {
				// ignore in environments without full chrome runtime port support
			}
		};

		connectPort();

		const handleMessage = (msg: any) => {
			if (msg?.action === 'CLOSE_SIDEPANEL') {
				window.close();
			}
		};

		if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
			chrome.runtime.onMessage.addListener(handleMessage);
		}

		return () => {
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
			port?.disconnect();
			if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
				chrome.runtime.onMessage.removeListener(handleMessage);
			}
		};
	}, []);

	const handleReadCurrentPage = async () => {
		setCommandError('');
		const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE' });
		if (!response.success) {
			setCommandError(
				response.transportError
					? t('startReadingFailed')
					: response.error === 'manualCheckpointFailed'
						? t('manualCheckpointFailed')
						: (getLocalizedPlaybackError(response.error) ?? t('startReadingFailed')),
			);
		}
	};

	const handleReadManualText = async () => {
		if (!draft.trim()) {
			return;
		}
		setCommandError('');
		const response = await sendPlaybackCommand({
			action: 'START_MANUAL_TEXT',
			payload: { text: draft, language, panelInstanceId },
		});
		if (!response.success) {
			setCommandError(
				response.transportError
					? t('startReadingFailed')
					: response.error === 'invalidManualText'
						? t('invalidManualText')
						: t('startReadingFailed'),
			);
			return;
		}
		const normalizedDraft = normalizeManualText(draft);
		setManualReaderText(normalizedDraft);
		manualReaderSessionIdRef.current = null;
		setManualHighlight(null);
		manualHighlightCursorRef.current = createManualHighlightCursor(normalizedDraft);
	};

	const handlePlaybackCommand = (action: 'PAUSE_READING' | 'RESUME_READING' | 'STOP_READING') => {
		void sendPlaybackCommand({ action });
	};

	const handleOpenDocumentReader = async () => {
		setCommandError('');
		const response = await sendPlaybackCommand({ action: 'OPEN_DOCUMENT_READER' });
		if (!response.success) {
			setCommandError(t('documentReaderOpenFailed'));
		}
	};

	const handleResumeManualCheckpoint = async () => {
		setCommandError('');
		const response = await sendPlaybackCommand({ action: 'RESUME_MANUAL_CHECKPOINT', panelInstanceId });
		if (!response.success) {
			setCommandError(response.error === 'manualCheckpointUnavailable' ? t('manualCheckpointUnavailable') : t('startReadingFailed'));
		}
	};

	const handleDiscardManualCheckpoint = async () => {
		setCommandError('');
		const response = await sendPlaybackCommand({ action: 'DISCARD_MANUAL_CHECKPOINT', panelInstanceId });
		if (response.success) {
			clearManualReader();
		} else {
			setCommandError(t('manualCheckpointUnavailable'));
		}
	};

	const handleVoiceChange = (voice: string) => {
		setActiveVoice(voice);
		void chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_VOICE]: voice });
	};

	const handleSpeedChange = (nextSpeed: number) => {
		setSpeed(nextSpeed);
		void chrome.storage.local.set({ [STORAGE_KEYS.SPEED]: nextSpeed });
		void sendPlaybackCommand({ action: 'CHANGE_SPEED', payload: { speed: nextSpeed } });
	};

	const handleSelectionButtonEnabledChange = (enabled: boolean) => {
		setSelectionButtonEnabled(enabled);
		void chrome.storage.local.set({ [STORAGE_KEYS.SELECTION_BUTTON_ENABLED]: enabled });
	};

	const handleWordHighlightEnabledChange = (enabled: boolean) => {
		setWordHighlightEnabled(enabled);
		void chrome.storage.local.set({ [STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]: enabled });
	};

	const handleThemeChange = (newTheme: ThemeName) => {
		setTheme(newTheme);
		void chrome.storage.local.set({ [STORAGE_KEYS.THEME]: newTheme });
	};

	const tabSource = session?.source.kind === 'tab' ? session.source : null;
	const sessionTitle = session?.contentScope === 'manual' ? t('pastedText') : (tabSource?.title ?? '');
	const sessionHost = tabSource ? getHost(tabSource.url) : '';
	const manualReaderLocked = manualReaderText !== null;
	const manualText = manualReaderText ?? draft;
	const readerBeforeHighlight = manualHighlight ? manualReaderText?.slice(0, manualHighlight.start) : null;
	const readerActiveHighlight = manualHighlight ? manualReaderText?.slice(manualHighlight.start, manualHighlight.end) : null;
	const readerAfterHighlight = manualHighlight ? manualReaderText?.slice(manualHighlight.end) : null;

	return (
		<main className="side-panel" data-theme={theme} aria-label="readit.dev Side Panel">
			<header className="side-panel-header">
				<h1>
					readit<span>.dev</span>
				</h1>
				<span className="extension-version">v{chrome.runtime.getManifest().version}</span>
				<a className="header-support-link" href={BUY_ME_A_COFFEE_URL} target="_blank" rel="noreferrer">
					<span aria-hidden="true">☕</span> {t('buyMeCoffee')}
				</a>
			</header>

			{commandError && (
				<div className="alert alert-danger" role="alert">
					{commandError}
				</div>
			)}

			<section className="current-page-card" aria-labelledby="current-page-title">
				<div className="status-display" data-status={session?.status ?? 'stopped'} role="status">
					<div className="status-dot-pulse" data-status={session?.status ?? 'stopped'} />
					<span className="status-text">{getStatusText(session)}</span>
				</div>
				<h2 id="current-page-title">{t('currentPage')}</h2>
				{session && session.source.kind === 'tab' ? (
					<>
						<div className="session-meta">
							<span className="session-title" title={sessionTitle}>
								{sessionTitle}
							</span>
							{sessionHost && <span className="session-host">{sessionHost}</span>}
							<div className="session-context">
								<span>
									{session.totalParagraphs > 0
										? `${t('paragraphLabel')} ${session.currentParagraphIndex + 1}/${session.totalParagraphs} • ${Math.round(session.progressPercentage)}%`
										: t('preparingContent')}
								</span>
								<span>{t('readingThisTab')}</span>
							</div>
						</div>
						{session.status !== 'stopped' && session.status !== 'error' && (
							<div className="progress-bar-container">
								<div className="progress-bar" style={{ width: `${session.progressPercentage}%` }} />
							</div>
						)}
						<div className="playback-controls">
							{(session.status === 'playing' || session.status === 'paused') && (
								<button
									ref={primaryButtonRef}
									className="btn btn-secondary btn-icon-only btn-playpause"
									type="button"
									aria-label={session.status === 'playing' ? t('pauseState') : t('resumeStatus')}
									title={session.status === 'playing' ? t('pauseState') : t('resumeStatus')}
									onClick={() => handlePlaybackCommand(session.status === 'playing' ? 'PAUSE_READING' : 'RESUME_READING')}
								>
									<PlaybackIcon name={session.status === 'playing' ? 'pause' : 'resume'} />
								</button>
							)}
							<PlaybackControlButton
								status={session.status}
								onClick={() => handlePlaybackCommand('STOP_READING')}
								buttonRef={session.status === 'playing' || session.status === 'paused' ? undefined : primaryButtonRef}
							/>
						</div>
						{session.readableSurface === 'document-reader' && (
							<button className="secondary-button document-reader-button" type="button" onClick={handleOpenDocumentReader}>
								{t('openDocumentReader')}
							</button>
						)}
					</>
				) : (
					<>
						{pageInfo.available ? (
							<div className="page-info">
								<strong>{pageInfo.title}</strong>
								<span>
									{getHost(pageInfo.url)} · {pageInfo.lang}
								</span>
							</div>
						) : (
							<p>{t('currentPageUnavailable')}</p>
						)}
						<PlaybackControlButton
							status="stopped"
							onClick={handleReadCurrentPage}
							buttonRef={session?.status === 'playing' || session?.status === 'paused' ? undefined : primaryButtonRef}
						/>
					</>
				)}
			</section>

			<div className="paste-divider">{t('orPasteText')}</div>

			<section className="manual-text-card" aria-labelledby="manual-text-title">
				<h2 id="manual-text-title">{t('orPasteText')}</h2>
				{manualReaderLocked ? (
					<div ref={readerRef} className="manual-reader" role="textbox" aria-label={t('manualReaderLabel')} aria-readonly="true">
						{manualHighlight &&
						readerBeforeHighlight !== null &&
						readerActiveHighlight !== null &&
						readerAfterHighlight !== null ? (
							<>
								{readerBeforeHighlight}
								<mark className="manual-reader-active-word">{readerActiveHighlight}</mark>
								{readerAfterHighlight}
							</>
						) : (
							manualReaderText
						)}
					</div>
				) : (
					<textarea
						aria-label={t('pasteTextPlaceholder')}
						placeholder={t('pasteTextPlaceholder')}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
				)}
				<div className="manual-meta">
					<span>{t('textProcessedLocally')}</span>
					<span>
						{manualText.length} {t('characters')}
					</span>
				</div>
				<label className="field-label">
					<span>{t('manualLanguage')}</span>
					<select
						disabled={manualReaderLocked}
						value={language}
						onChange={(event) => setLanguage(event.target.value as ManualTextLanguage)}
					>
						<option value="auto">{t('languageAuto')}</option>
						<option value="en">{t('languageEnglish')}</option>
						<option value="vi">{t('languageVietnamese')}</option>
						<option value="zh">{t('languageChinese')}</option>
					</select>
				</label>
				<div className="manual-actions">
					<button className="secondary-button" type="button" disabled={manualReaderLocked} onClick={() => setDraft('')}>
						{t('clearText')}
					</button>
					<button
						className="primary-button"
						type="button"
						disabled={manualReaderLocked || !draft.trim()}
						onClick={handleReadManualText}
					>
						{t('readPastedText')}
					</button>
				</div>
				{manualCheckpointState === 'suspended' && (
					<div className="manual-checkpoint-actions">
						<p>{t('manualPausedForWeb')}</p>
						<div>
							<button className="secondary-button" type="button" onClick={handleDiscardManualCheckpoint}>
								{t('stopEditorReading')}
							</button>
							<button className="primary-button" type="button" onClick={handleResumeManualCheckpoint}>
								{t('resumeEditorReading')}
							</button>
						</div>
					</div>
				)}
				{session && session.source.kind === 'manual' && (
					<>
						<div className="session-meta">
							<span className="session-title" title={sessionTitle}>
								{sessionTitle}
							</span>
							<div className="session-context">
								<span>
									{session.totalParagraphs > 0
										? `${t('paragraphLabel')} ${session.currentParagraphIndex + 1}/${session.totalParagraphs} • ${Math.round(session.progressPercentage)}%`
										: t('preparingContent')}
								</span>
								<span>{t('manualSession')}</span>
							</div>
						</div>
						{session.status !== 'stopped' && session.status !== 'error' && (
							<div className="progress-bar-container">
								<div className="progress-bar" style={{ width: `${session.progressPercentage}%` }} />
							</div>
						)}
						<div className="playback-controls">
							{(session.status === 'playing' || session.status === 'paused') && (
								<button
									ref={primaryButtonRef}
									className="btn btn-secondary btn-icon-only btn-playpause"
									type="button"
									aria-label={session.status === 'playing' ? t('pauseState') : t('resumeStatus')}
									title={session.status === 'playing' ? t('pauseState') : t('resumeStatus')}
									onClick={() => handlePlaybackCommand(session.status === 'playing' ? 'PAUSE_READING' : 'RESUME_READING')}
								>
									<PlaybackIcon name={session.status === 'playing' ? 'pause' : 'resume'} />
								</button>
							)}
							<PlaybackControlButton
								status={session.status}
								onClick={() => handlePlaybackCommand('STOP_READING')}
								buttonRef={session.status === 'playing' || session.status === 'paused' ? undefined : primaryButtonRef}
							/>
						</div>
					</>
				)}
			</section>

			<SettingsCard
				collapsible
				defaultExpanded={false}
				theme={theme}
				activeVoice={activeVoice}
				speed={speed}
				selectionButtonEnabled={selectionButtonEnabled}
				wordHighlightEnabled={wordHighlightEnabled}
				playbackStatus={session?.status ?? 'stopped'}
				onVoiceChange={handleVoiceChange}
				onSpeedChange={handleSpeedChange}
				onSelectionButtonEnabledChange={handleSelectionButtonEnabledChange}
				onWordHighlightEnabledChange={handleWordHighlightEnabledChange}
				onThemeChange={handleThemeChange}
			/>
		</main>
	);
}
