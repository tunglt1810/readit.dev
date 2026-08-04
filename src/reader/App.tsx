import { useEffect, useMemo, useRef, useState } from 'react';

import { PlaybackIcon } from '../shared/components/PlaybackIcon.tsx';
import {
	DEFAULT_SPEED,
	resolveStoredPlaybackSpeed,
	STORAGE_KEYS,
	VOICE_STYLES,
} from '../shared/constants.ts';
import {
	DOCUMENT_READER_PORT_NAME,
	type DocumentReaderPortMessage,
	type DocumentReaderSnapshot,
	mapDocumentReaderWords,
} from '../shared/document_reader.ts';
import { t } from '../shared/i18n.ts';
import { requestPlaybackState, sendPlaybackCommand, subscribePlaybackState } from '../shared/playback_client.ts';
import type { PlaybackSessionSnapshot, TabPlaybackSessionSnapshot } from '../shared/types.ts';
import { getDisplayVersion } from '../shared/version.ts';

type HighlightRegistry = {
	set(name: string, highlight: unknown): void;
	delete(name: string): void;
};

const HIGHLIGHT_NAME = 'readit-document-reader-word';

type DocumentPlaybackSession = TabPlaybackSessionSnapshot & { readableSurface: 'document-reader' };

function isDocumentSession(session: PlaybackSessionSnapshot | null): session is DocumentPlaybackSession {
	return session?.source.kind === 'tab' && session.readableSurface === 'document-reader';
}

export default function App() {
	const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
	const [snapshot, setSnapshot] = useState<DocumentReaderSnapshot | null>(null);
	const [currentWordIndex, setCurrentWordIndex] = useState(-1);
	const [sourceTabId, setSourceTabId] = useState<number | null>(null);
	const [activeVoice, setActiveVoice] = useState('M1');
	const [speed, setSpeed] = useState(DEFAULT_SPEED);
	const portRef = useRef<chrome.runtime.Port | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const snapshotSessionIdRef = useRef<string | null>(null);
	const wordRanges = useMemo(() => (snapshot ? mapDocumentReaderWords(snapshot.content, snapshot.words) : []), [snapshot]);
	const documentSession = isDocumentSession(session) ? session : null;
	const documentSessionId = documentSession?.sessionId ?? null;
	const documentSourceTabId = documentSession?.source.tabId ?? null;

	useEffect(() => {
		let latestSessionSpeed: number | undefined;
		let latestSessionLanguage: string | undefined;
		chrome.storage.local.get([STORAGE_KEYS.ACTIVE_VOICE, STORAGE_KEYS.SPEED, STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE], (result) => {
			const storedVoice = result[STORAGE_KEYS.ACTIVE_VOICE];
			const storedSpeed = result[STORAGE_KEYS.SPEED];
			if (typeof storedVoice === 'string') {
				setActiveVoice(storedVoice);
			}
			if (latestSessionSpeed === undefined) {
				setSpeed(resolveStoredPlaybackSpeed(latestSessionLanguage, storedSpeed, result[STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE]));
			}
		});

		const port = chrome.runtime.connect({ name: DOCUMENT_READER_PORT_NAME });
		portRef.current = port;
		const handlePortMessage = (message: DocumentReaderPortMessage) => {
			if (message.action === 'DOCUMENT_READER_SNAPSHOT') {
				snapshotSessionIdRef.current = message.snapshot.sessionId;
				setSnapshot(message.snapshot);
				setCurrentWordIndex(message.snapshot.currentWordIndex);
			} else if (message.action === 'DOCUMENT_READER_UPDATE') {
				setCurrentWordIndex((current) => (message.sessionId === snapshotSessionIdRef.current ? message.wordIndex : current));
			} else if (message.action === 'DOCUMENT_READER_CLEAR' && message.sessionId === snapshotSessionIdRef.current) {
				setCurrentWordIndex(-1);
			}
		};
		port.onMessage.addListener(handlePortMessage);

		void requestPlaybackState().then((response) => {
			setSession(response.session);
			latestSessionLanguage = response.session?.lang;
			if (response.session && typeof response.session.speed === 'number' && Number.isFinite(response.session.speed)) {
				latestSessionSpeed = response.session.speed;
				setSpeed(response.session.speed);
			}
		});
		const unsubscribe = subscribePlaybackState(chrome.runtime, (nextSession) => {
			setSession(nextSession);
			latestSessionLanguage = nextSession?.lang;
			if (nextSession && typeof nextSession.speed === 'number' && Number.isFinite(nextSession.speed)) {
				latestSessionSpeed = nextSession.speed;
				setSpeed(nextSession.speed);
			}
		});
		return () => {
			unsubscribe();
			port.onMessage.removeListener(handlePortMessage);
			port.disconnect();
			portRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (documentSessionId === null || documentSourceTabId === null) {
			return;
		}
		setSourceTabId(documentSourceTabId);
		portRef.current?.postMessage({
			action: 'DOCUMENT_READER_ATTACH',
			sessionId: documentSessionId,
		} satisfies DocumentReaderPortMessage);
	}, [documentSessionId, documentSourceTabId]);

	useEffect(() => {
		const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
		registry?.delete(HIGHLIGHT_NAME);
		const rangeOffsets = wordRanges[currentWordIndex];
		const textNode = contentRef.current?.firstChild;
		const HighlightConstructor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
		if (!registry || !HighlightConstructor || !rangeOffsets || !(textNode instanceof Text)) {
			return;
		}
		const range = document.createRange();
		range.setStart(textNode, rangeOffsets.start);
		range.setEnd(textNode, rangeOffsets.end);
		registry.set(HIGHLIGHT_NAME, new HighlightConstructor(range));

		const bounds = range.getBoundingClientRect();
		if (bounds.top < window.innerHeight * 0.2 || bounds.bottom > window.innerHeight * 0.8) {
			const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
			window.scrollBy({ top: bounds.top - window.innerHeight / 2, behavior });
		}
		return () => registry.delete(HIGHLIGHT_NAME);
	}, [currentWordIndex, wordRanges]);

	const handleVoiceChange = (voice: string) => {
		setActiveVoice(voice);
		void chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_VOICE]: voice });
	};

	const handleSpeedChange = (nextSpeed: number) => {
		setSpeed(nextSpeed);
		void chrome.storage.local.set({
			[STORAGE_KEYS.SPEED]: nextSpeed,
			[STORAGE_KEYS.HAS_CUSTOM_SPEED_OVERRIDE]: true,
		});
		void sendPlaybackCommand({ action: 'CHANGE_SPEED', payload: { speed: nextSpeed } });
	};

	const status = documentSession?.status ?? 'stopped';

	const displayVersion = getDisplayVersion();

	return (
		<main className="document-reader" aria-label="readit.dev Document Reader">
			<header className="document-reader-header">
				<div>
					<span className="document-reader-brand">
						readit<span>.dev</span> <span className="extension-version">v{displayVersion}</span>
					</span>
					<h1>{snapshot?.title || t('documentReaderTitle')}</h1>
				</div>
				<button
					className="btn btn-secondary btn-back-source"
					type="button"
					disabled={sourceTabId === null}
					onClick={() => sourceTabId !== null && void chrome.tabs.update(sourceTabId, { active: true })}
				>
					{t('backToSource')}
				</button>
			</header>

			{snapshot ? (
				<>
					<section className="document-reader-toolbar" aria-label={t('documentReaderControls')}>
						<div className="playback-controls">
							{(status === 'playing' || status === 'paused') && (
								<button
									className="btn btn-primary btn-icon-only"
									type="button"
									aria-label={status === 'playing' ? t('pauseState') : t('resumeStatus')}
									title={status === 'playing' ? t('pauseState') : t('resumeStatus')}
									onClick={() =>
										void sendPlaybackCommand({ action: status === 'playing' ? 'PAUSE_READING' : 'RESUME_READING' })
									}
								>
									<PlaybackIcon name={status === 'playing' ? 'pause' : 'resume'} />
								</button>
							)}
							<button
								className="btn btn-secondary btn-icon-only"
								type="button"
								disabled={status === 'stopped'}
								aria-label={t('stopReading')}
								title={t('stopReading')}
								onClick={() => void sendPlaybackCommand({ action: 'STOP_READING' })}
							>
								<PlaybackIcon name="stop" />
							</button>
						</div>
						<div className="form-group">
							<label className="form-label" htmlFor="reader-voice-select">
								{t('selectVoice')}
							</label>
							<select
								id="reader-voice-select"
								className="form-select"
								value={activeVoice}
								onChange={(event) => handleVoiceChange(event.target.value)}
							>
								{VOICE_STYLES.map((voice) => (
									<option key={voice.id} value={voice.id}>
										{voice.name}
									</option>
								))}
							</select>
						</div>
						<div className="form-group">
							<div className="slider-label-group">
								<span className="form-label">{t('readingSpeed')}</span>
								<output className="slider-value">{speed.toFixed(2)}×</output>
							</div>
							<input
								className="form-slider"
								type="range"
								min="0.7"
								max="1.8"
								step="0.05"
								value={speed}
								onChange={(event) => handleSpeedChange(Number(event.target.value))}
							/>
						</div>
						<div className="form-group document-reader-progress" role="status">
							<div className="slider-label-group">
								<span className="form-label">PROGRESS</span>
								<span className="slider-value">{Math.round(documentSession?.progressPercentage ?? 0)}%</span>
							</div>
							<div className="progress-bar-container">
								<div className="progress-bar" style={{ width: `${documentSession?.progressPercentage ?? 0}%` }} />
							</div>
						</div>
					</section>
					<article ref={contentRef} className="document-reader-content">
						{snapshot.content}
					</article>
				</>
			) : (
				<section className="document-reader-empty">
					<h2>{t('documentReaderEmptyTitle')}</h2>
					<p>{t('documentReaderEmptyBody')}</p>
				</section>
			)}
		</main>
	);
}
