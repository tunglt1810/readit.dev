import { useEffect, useMemo, useRef, useState } from 'react';

import { PlaybackIcon } from '../shared/components/PlaybackIcon.tsx';
import { DEFAULT_SPEED, resolveStoredPlaybackSpeed, STORAGE_KEYS, VOICE_STYLES } from '../shared/constants.ts';
import {
	DOCUMENT_READER_PORT_NAME,
	type DocumentReaderPortMessage,
	type DocumentReaderSnapshot,
	isDocumentReaderCompletedMessage,
	mapDocumentReaderWords,
} from '../shared/document_reader.ts';
import { getLocalizedPlaybackError, t } from '../shared/i18n.ts';
import { isLocalBookSession } from '../shared/local_book_session.ts';
import { extractPdfArticleFromBytes } from '../background/pdf_extractor.ts';
import { loadPdfJsDocument } from '../background/pdfjs_loader.ts';
import {
	detectBookKind,
	ensureReadPermission,
	hasReadPermission,
	isFileSystemAccessSupported,
	pickBookFile,
	sendReaderContent,
} from './book_loader.ts';
import { EPUB_ERROR_CODES } from '../shared/constants.ts';
import { EpubError, openEpubBook } from '../shared/epub_extractor.ts';
import {
	type EpubProgressRecord,
	getEpubBookHandle,
	loadEpubProgress,
	matchesSavedFile,
	putEpubBookHandle,
	saveEpubProgress,
} from '../shared/epub_progress_store.ts';
import { createEpubSession, type EpubSession } from './epub_session.ts';
import { requestPlaybackState, sendPlaybackCommand, subscribePlaybackState } from '../shared/playback_client.ts';
import { resolvePlaybackStatus } from '../shared/playback_status.ts';
import { performCenteredScroll, UserScrollPauseManager } from '../shared/scroll_helper.ts';
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
	const [bookError, setBookError] = useState('');
	const [isLoadingBook, setIsLoadingBook] = useState(false);
	const [chapterState, setChapterState] = useState<{ chapterIndex: number; chapterCount: number } | null>(null);
	const epubSessionRef = useRef<EpubSession | null>(null);
	const [savedProgress, setSavedProgress] = useState<EpubProgressRecord | null>(null);
	const portRef = useRef<chrome.runtime.Port | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const snapshotSessionIdRef = useRef<string | null>(null);
	const scrollPauseManagerRef = useRef(new UserScrollPauseManager(3000));
	const wordRanges = useMemo(() => (snapshot ? mapDocumentReaderWords(snapshot.content, snapshot.words) : []), [snapshot]);
	const documentSession = isDocumentSession(session) ? session : null;
	const isLocalBook = isLocalBookSession(documentSession);
	const documentSessionId = documentSession?.sessionId ?? null;
	const documentSourceTabId = documentSession?.source.tabId ?? null;
	const playbackStatus = documentSession?.status;

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
		const manager = scrollPauseManagerRef.current;
		const isPlaying = playbackStatus === 'playing';
		manager.setPlaybackState(isPlaying);

		if (!isPlaying) {
			return;
		}

		const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ']);
		const handleUserScroll = () => manager.onUserInteraction();
		const handleKeyScroll = (e: KeyboardEvent) => {
			if (SCROLL_KEYS.has(e.key)) {
				manager.onUserInteraction();
			}
		};
		window.addEventListener('wheel', handleUserScroll, { passive: true });
		window.addEventListener('touchmove', handleUserScroll, { passive: true });
		window.addEventListener('keydown', handleKeyScroll, { passive: true });

		return () => {
			window.removeEventListener('wheel', handleUserScroll);
			window.removeEventListener('touchmove', handleUserScroll);
			window.removeEventListener('keydown', handleKeyScroll);
		};
	}, [playbackStatus]);

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
		const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		performCenteredScroll(
			bounds,
			window.innerHeight,
			scrollPauseManagerRef.current,
			(opts) => window.scrollBy(opts),
			prefersReducedMotion,
		);
		return () => registry.delete(HIGHLIGHT_NAME);
	}, [currentWordIndex, wordRanges]);

	useEffect(() => {
		void loadEpubProgress().then(async (progress) => {
			setSavedProgress(progress && (await getEpubBookHandle()) ? progress : null);
		});
	}, []);


	useEffect(() => {
		const handleCompleted = (message: unknown) => {
			const epubSession = epubSessionRef.current;
			// A session this book never started — one left playing from before the tab reloaded —
			// must not chain the next chapter out from under the chapter being opened.
			if (!isDocumentReaderCompletedMessage(message) || !epubSession?.isPlaying(message.sessionId)) {
				return;
			}
			void epubSession.advance().then((advanced) => {
				if (advanced) {
					setChapterState(epubSession.state());
					return;
				}
				// End of book: hand the tab back to the picker so another book can be loaded.
				epubSessionRef.current = null;
				setChapterState(null);
				setSnapshot(null);
				void loadEpubProgress().then(setSavedProgress);
			});
		};
		chrome.runtime.onMessage.addListener(handleCompleted);
		return () => chrome.runtime.onMessage.removeListener(handleCompleted);
	}, []);

	useEffect(() => {
		const epubSession = epubSessionRef.current;
		const range = wordRanges[currentWordIndex];
		if (!epubSession || !range) {
			return;
		}
		epubSession.recordPosition(range.start);
		if ((documentSession?.progressPercentage ?? 0) >= 80) {
			epubSession.prefetchNext();
		}
	}, [currentWordIndex, wordRanges, documentSession?.progressPercentage]);

	useEffect(() => {
		const flush = () => void epubSessionRef.current?.flush();
		const interval = setInterval(flush, 5000);
		window.addEventListener('beforeunload', flush);
		return () => {
			clearInterval(interval);
			window.removeEventListener('beforeunload', flush);
			flush();
		};
	}, []);

	const openEpubSession = async (file: File): Promise<EpubSession> =>
		createEpubSession({
			book: await openEpubBook(await file.arrayBuffer()),
			file: { name: file.name, size: file.size, lastModified: file.lastModified },
			startChapter: (payload) => sendReaderContent(payload),
			saveProgress: saveEpubProgress,
			now: () => Date.now(),
		});

	/**
	 * A saved position only survives if it was written against this very file and the same chapter
	 * list. A record from a different count was numbered by a different list, so its index no
	 * longer names the chapter it was saved for.
	 */
	const resolveResumePoint = (saved: EpubProgressRecord | null, file: File, chapterCount: number) =>
		saved && matchesSavedFile(saved, file) && saved.totalChapters === chapterCount
			? { chapterIndex: saved.chapterIndex, charOffset: saved.charOffset }
			: null;

	const startEpubBook = async (file: File, saved: EpubProgressRecord | null): Promise<boolean> => {
		const epubSession = await openEpubSession(file);
		epubSessionRef.current = epubSession;
		const from = resolveResumePoint(saved, file, epubSession.state().chapterCount) ?? { chapterIndex: 0, charOffset: 0 };
		if (!(await epubSession.start(from))) {
			epubSessionRef.current = null;
			return false;
		}
		setChapterState(epubSession.state());
		return true;
	};

	// A reload leaves the audio playing but the book object gone, so natural completion would
	// have nothing to chain the next chapter from. Take the playing chapter back over instead.
	useEffect(() => {
		if (epubSessionRef.current || !snapshot || !isLocalBook) {
			return;
		}
		let cancelled = false;
		void (async () => {
			const stored = await getEpubBookHandle();
			const progress = await loadEpubProgress();
			if (cancelled || !stored || !progress || !(await hasReadPermission(stored.handle))) {
				return;
			}
			const file = await stored.handle.getFile();
			if (cancelled) {
				return;
			}
			const epubSession = await openEpubSession(file);
			const resumePoint = resolveResumePoint(progress, file, epubSession.state().chapterCount);
			if (cancelled || !resumePoint) {
				return;
			}
			await epubSession.adopt({
				chapterIndex: resumePoint.chapterIndex,
				sessionId: snapshot.sessionId,
				playingText: snapshot.content,
			});
			if (cancelled) {
				return;
			}
			epubSessionRef.current = epubSession;
			setChapterState(epubSession.state());
		})().catch(() => undefined);
		return () => {
			cancelled = true;
		};
		// A reopened book replaces the session itself, so only a fresh snapshot can need adopting.
	}, [snapshot, isLocalBook]);

	const handleOpenBook = async () => {
		setBookError('');
		const handle = await pickBookFile();
		if (!handle) {
			return;
		}
		const kind = detectBookKind(handle.name);
		if (!kind) {
			setBookError(t('bookOpenFailed'));
			return;
		}
		setIsLoadingBook(true);
		try {
			const file = await handle.getFile();
			if (kind === 'pdf') {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const extraction = await extractPdfArticleFromBytes(bytes, file.name, { loadDocument: loadPdfJsDocument });
				if (!extraction.success) {
					setBookError(getLocalizedPlaybackError(extraction.error) ?? t('bookOpenFailed'));
					return;
				}
				const response = await sendReaderContent({
					title: extraction.article.title,
					content: extraction.article.content,
					lang: extraction.article.lang,
				});
				if (!response.success) {
					setBookError(t('bookOpenFailed'));
				}
				return;
			}
			// Retaining the handle only enables resume; losing it must not block reading.
			await putEpubBookHandle({ handle, fileName: file.name, fileSize: file.size, fileLastModified: file.lastModified }).catch(
				() => undefined,
			);
			if (!(await startEpubBook(file, null))) {
				setBookError(t('bookOpenFailed'));
			}
		} catch (error) {
			setBookError(error instanceof EpubError ? (getLocalizedPlaybackError(error.code) ?? t('bookOpenFailed')) : t('bookOpenFailed'));
		} finally {
			setIsLoadingBook(false);
		}
	};

	const handleResumeBook = async () => {
		setBookError('');
		const progress = savedProgress;
		const stored = await getEpubBookHandle();
		if (!progress || !stored) {
			setSavedProgress(null);
			return;
		}
		if (!(await ensureReadPermission(stored.handle))) {
			setBookError(getLocalizedPlaybackError(EPUB_ERROR_CODES.fileAccessDenied) ?? t('bookOpenFailed'));
			return;
		}
		setIsLoadingBook(true);
		try {
			const file = await stored.handle.getFile();
			if (!(await startEpubBook(file, progress))) {
				setBookError(t('bookOpenFailed'));
			}
		} catch (error) {
			setBookError(error instanceof EpubError ? (getLocalizedPlaybackError(error.code) ?? t('bookOpenFailed')) : t('bookOpenFailed'));
		} finally {
			setIsLoadingBook(false);
		}
	};

	// Unlike natural completion, running out of chapters here must not send the tab back to the
	// picker: the chapter the reader is listening to simply keeps playing.
	const handleChapterJump = (direction: 'previous' | 'next') => {
		const epubSession = epubSessionRef.current;
		if (!epubSession) {
			return;
		}
		void (direction === 'previous' ? epubSession.previous() : epubSession.advance()).then((moved) => {
			if (moved) {
				setChapterState(epubSession.state());
			}
		});
	};

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

	const status = resolvePlaybackStatus(documentSession);

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
				<div className="document-reader-header-actions">
					{snapshot && isFileSystemAccessSupported() && (
						<button
							className="btn btn-secondary btn-open-book"
							type="button"
							disabled={isLoadingBook}
							onClick={() => void handleOpenBook()}
						>
							{t('openBook')}
						</button>
					)}
					{/* A locally opened book is sourced from this very tab, so there is nowhere to go back to. */}
					{!isLocalBook && (
						<button
							className="btn btn-secondary btn-back-source"
							type="button"
							disabled={sourceTabId === null}
							onClick={() => sourceTabId !== null && void chrome.tabs.update(sourceTabId, { active: true })}
						>
							{t('backToSource')}
						</button>
					)}
				</div>
			</header>

			{snapshot ? (
				<>
					<section className="document-reader-toolbar" aria-label={t('documentReaderControls')}>
						<div className="playback-controls">
							{chapterState && (
								<button
									className="btn btn-secondary btn-icon-only btn-previous-chapter"
									type="button"
									disabled={chapterState.chapterIndex === 0}
									aria-label={t('previousChapter')}
									title={t('previousChapter')}
									onClick={() => handleChapterJump('previous')}
								>
									<PlaybackIcon name="previous" />
								</button>
							)}
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
							{chapterState && (
								<button
									className="btn btn-secondary btn-icon-only btn-next-chapter"
									type="button"
									disabled={chapterState.chapterIndex >= chapterState.chapterCount - 1}
									aria-label={t('nextChapter')}
									title={t('nextChapter')}
									onClick={() => handleChapterJump('next')}
								>
									<PlaybackIcon name="next" />
								</button>
							)}
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
							{chapterState && (
								<span className="slider-value">
									{t('chapterProgress')} {chapterState.chapterIndex + 1}/{chapterState.chapterCount}
								</span>
							)}
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
					{bookError && <div className="alert alert-danger">{bookError}</div>}
					{isFileSystemAccessSupported() && (
						<div className="document-reader-empty-actions">
							<button
								className="btn btn-primary btn-open-book"
								type="button"
								disabled={isLoadingBook}
								onClick={() => void handleOpenBook()}
							>
								{t('openBook')}
							</button>
							{savedProgress && (
								<button
									className="btn btn-secondary btn-resume-book"
									type="button"
									disabled={isLoadingBook}
									onClick={() => void handleResumeBook()}
								>
									{t('resumeReading')}: {savedProgress.title} — {t('chapterProgress')} {savedProgress.chapterIndex + 1}/
									{savedProgress.totalChapters}
								</button>
							)}
						</div>
					)}
				</section>
			)}
		</main>
	);
}
