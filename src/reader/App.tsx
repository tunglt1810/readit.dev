import { useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_SPEED, STORAGE_KEYS, VOICE_STYLES } from '../shared/constants.ts';
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
		chrome.storage.local.get([STORAGE_KEYS.ACTIVE_VOICE, STORAGE_KEYS.SPEED], (result) => {
			const storedVoice = result[STORAGE_KEYS.ACTIVE_VOICE];
			const storedSpeed = result[STORAGE_KEYS.SPEED];
			if (typeof storedVoice === 'string') {
				setActiveVoice(storedVoice);
			}
			if (typeof storedSpeed === 'number') {
				setSpeed(storedSpeed);
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

		void requestPlaybackState().then((response) => setSession(response.session));
		const unsubscribe = subscribePlaybackState(chrome.runtime, setSession);
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
		void chrome.storage.local.set({ [STORAGE_KEYS.SPEED]: nextSpeed });
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
						<div className="document-reader-playback">
							{(status === 'playing' || status === 'paused') && (
								<button
									className="primary-button"
									type="button"
									onClick={() =>
										void sendPlaybackCommand({ action: status === 'playing' ? 'PAUSE_READING' : 'RESUME_READING' })
									}
								>
									{status === 'playing' ? t('pauseState') : t('resumeStatus')}
								</button>
							)}
							<button
								type="button"
								disabled={status === 'stopped'}
								onClick={() => void sendPlaybackCommand({ action: 'STOP_READING' })}
							>
								{t('stopReading')}
							</button>
						</div>
						<label>
							<span>{t('selectVoice')}</span>
							<select value={activeVoice} onChange={(event) => handleVoiceChange(event.target.value)}>
								{VOICE_STYLES.map((voice) => (
									<option key={voice.id} value={voice.id}>
										{voice.name}
									</option>
								))}
							</select>
						</label>
						<label>
							<span>{t('readingSpeed')}</span>
							<input
								type="range"
								min="0.7"
								max="1.8"
								step="0.05"
								value={speed}
								onChange={(event) => handleSpeedChange(Number(event.target.value))}
							/>
							<output>{speed.toFixed(2)}×</output>
						</label>
						<div className="document-reader-progress" role="status">
							<span>{Math.round(documentSession?.progressPercentage ?? 0)}%</span>
							<div>
								<i style={{ width: `${documentSession?.progressPercentage ?? 0}%` }} />
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
