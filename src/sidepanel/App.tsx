import { type ChangeEvent, useEffect, useState } from 'react';

import { BUY_ME_A_COFFEE_URL, STORAGE_KEYS, VOICE_STYLE_TRANSLATIONS, VOICE_STYLES } from '../shared/constants.ts';
import { t, uiLang } from '../shared/i18n.ts';
import { requestPlaybackState, sendPlaybackCommand, sendRuntimeRequest, subscribePlaybackState } from '../shared/playback_client.ts';
import type { ManualTextLanguage, PageInfoResponse, PlaybackSessionSnapshot, ThemeName } from '../shared/types.ts';

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
	const [draft, setDraft] = useState('');
	const [language, setLanguage] = useState<ManualTextLanguage>('auto');
	const [commandError, setCommandError] = useState('');
	const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
	const [activeVoice, setActiveVoice] = useState('M1');
	const [speed, setSpeed] = useState(1);
	const [theme, setTheme] = useState<ThemeName>('default');
	const [pageInfo, setPageInfo] = useState<PageInfoResponse>(EMPTY_PAGE_INFO);

	useEffect(() => {
		chrome.storage.local.get([STORAGE_KEYS.ACTIVE_VOICE, STORAGE_KEYS.SPEED, STORAGE_KEYS.THEME], (result) => {
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
		});

		void requestPlaybackState().then((response) => setSession(response.session));
		void sendRuntimeRequest<PageInfoResponse>({ action: 'GET_CURRENT_PAGE_INFO' }).then(setPageInfo, () =>
			setPageInfo(EMPTY_PAGE_INFO),
		);
		const unsubscribePlayback = subscribePlaybackState(chrome.runtime, setSession);
		const handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
			if (areaName !== 'local') {
				return;
			}
			const nextVoice = changes[STORAGE_KEYS.ACTIVE_VOICE]?.newValue;
			if (typeof nextVoice === 'string' && VOICE_STYLES.some((voice) => voice.id === nextVoice)) {
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
		};
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			unsubscribePlayback();
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, []);

	const handleReadCurrentPage = async () => {
		setCommandError('');
		const response = await sendPlaybackCommand({ action: 'START_CURRENT_PAGE' });
		if (!response.success) {
			setCommandError(response.transportError ? t('startReadingFailed') : (response.error ?? t('startReadingFailed')));
		}
	};

	const handleReadManualText = async () => {
		if (!draft.trim()) {
			return;
		}
		setCommandError('');
		const response = await sendPlaybackCommand({ action: 'START_MANUAL_TEXT', payload: { text: draft, language } });
		if (!response.success) {
			setCommandError(
				response.transportError
					? t('startReadingFailed')
					: response.error === 'invalidManualText'
						? t('invalidManualText')
						: t('startReadingFailed'),
			);
		}
	};

	const handlePlaybackCommand = (action: 'PAUSE_READING' | 'RESUME_READING' | 'STOP_READING') => {
		void sendPlaybackCommand({ action });
	};

	const handleVoiceChange = (event: ChangeEvent<HTMLSelectElement>) => {
		setActiveVoice(event.target.value);
		void chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_VOICE]: event.target.value });
	};

	const handleSpeedChange = (event: ChangeEvent<HTMLInputElement>) => {
		const nextSpeed = Number(event.target.value);
		setSpeed(nextSpeed);
		void chrome.storage.local.set({ [STORAGE_KEYS.SPEED]: nextSpeed });
		void sendPlaybackCommand({ action: 'CHANGE_SPEED', payload: { speed: nextSpeed } });
	};

	const tabSource = session?.source.kind === 'tab' ? session.source : null;
	const sessionTitle = session?.contentScope === 'manual' ? t('pastedText') : (tabSource?.title ?? '');
	const sessionHost = tabSource ? getHost(tabSource.url) : '';

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
				<h2 id="current-page-title">{t('currentPage')}</h2>
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
				<button className="primary-button" type="button" onClick={handleReadCurrentPage}>
					{t('readPage')}
				</button>
			</section>

			<div className="paste-divider">{t('orPasteText')}</div>

			<section className="manual-text-card" aria-labelledby="manual-text-title">
				<h2 id="manual-text-title">{t('orPasteText')}</h2>
				<textarea
					aria-label={t('pasteTextPlaceholder')}
					placeholder={t('pasteTextPlaceholder')}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<div className="manual-meta">
					<span>{t('textProcessedLocally')}</span>
					<span>
						{draft.length} {t('characters')}
					</span>
				</div>
				<label className="field-label">
					<span>{t('manualLanguage')}</span>
					<select value={language} onChange={(event) => setLanguage(event.target.value as ManualTextLanguage)}>
						<option value="auto">{t('languageAuto')}</option>
						<option value="en">{t('languageEnglish')}</option>
						<option value="vi">{t('languageVietnamese')}</option>
						<option value="zh">{t('languageChinese')}</option>
					</select>
				</label>
				<div className="manual-actions">
					<button className="secondary-button" type="button" onClick={() => setDraft('')}>
						{t('clearText')}
					</button>
					<button className="primary-button" type="button" disabled={!draft.trim()} onClick={handleReadManualText}>
						{t('readPastedText')}
					</button>
				</div>
			</section>

			<section className="side-panel-player" aria-label={t('nowPlaying')}>
				<div className="status-display" data-status={session?.status ?? 'stopped'} role="status">
					{getStatusText(session)}
				</div>
				{session && (
					<div className="session-meta">
						<div className="session-title">{sessionTitle}</div>
						{sessionHost && <div className="session-host">{sessionHost}</div>}
					</div>
				)}
				<div className="player-controls">
					{session?.status === 'playing' && (
						<button type="button" aria-label={t('pauseState')} onClick={() => handlePlaybackCommand('PAUSE_READING')}>
							Ⅱ
						</button>
					)}
					{session?.status === 'paused' && (
						<button type="button" aria-label={t('resumeStatus')} onClick={() => handlePlaybackCommand('RESUME_READING')}>
							▶
						</button>
					)}
					{session && (
						<button type="button" aria-label={t('stopReading')} onClick={() => handlePlaybackCommand('STOP_READING')}>
							■
						</button>
					)}
				</div>
				<div className="player-settings">
					<label className="field-label">
						<span>{t('selectVoice')}</span>
						<select
							value={activeVoice}
							disabled={session?.status === 'playing' || session?.status === 'loading'}
							onChange={handleVoiceChange}
						>
							{VOICE_STYLES.map((voice) => (
								<option key={voice.id} value={voice.id}>
									{VOICE_STYLE_TRANSLATIONS[uiLang][voice.id as keyof typeof VOICE_STYLE_TRANSLATIONS.en]}
								</option>
							))}
						</select>
					</label>
					<label className="field-label">
						<span>{t('readingSpeed')}</span>
						<input type="range" min="0.7" max="1.8" step="0.05" value={speed} onChange={handleSpeedChange} />
					</label>
				</div>
			</section>
		</main>
	);
}
