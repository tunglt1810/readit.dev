import { useEffect, useMemo, useRef, useState } from 'react';

import { loadPdfJsDocument } from '../background/pdfjs_loader.ts';
import {
	type BookProgressRecord,
	getBookHandle,
	loadBookProgress,
	matchesSavedFile,
	putBookHandle,
	saveBookProgress,
} from '../shared/book_progress_store.ts';
import { AudioExportButton } from '../shared/components/AudioExportButton.tsx';
import { PlaybackIcon } from '../shared/components/PlaybackIcon.tsx';
import {
	DEFAULT_SPEED,
	DOCX_ERROR_CODES,
	EPUB_ERROR_CODES,
	resolveStoredPlaybackSpeed,
	STORAGE_KEYS,
	VOICE_STYLES,
} from '../shared/constants.ts';
import {
	DOCUMENT_READER_PORT_NAME,
	type DocumentReaderPortMessage,
	type DocumentReaderSnapshot,
	isDocumentReaderCompletedMessage,
	mapDocumentReaderWords,
} from '../shared/document_reader.ts';
import { DocxError } from '../shared/docx_extractor.ts';
import { EpubError } from '../shared/epub_extractor.ts';
import { getLocalizedPlaybackError, t } from '../shared/i18n.ts';
import { isLocalBookSession } from '../shared/local_book_session.ts';
import { requestPlaybackState, sendPlaybackCommand, subscribePlaybackState } from '../shared/playback_client.ts';
import { resolvePlaybackStatus } from '../shared/playback_status.ts';
import { performCenteredScroll, UserScrollPauseManager } from '../shared/scroll_helper.ts';
import type { PlaybackSessionSnapshot, TabPlaybackSessionSnapshot, ThemeName } from '../shared/types.ts';
import { getDisplayVersion } from '../shared/version.ts';
import {
	type BookKind,
	detectBookKind,
	ensureReadPermission,
	hasReadPermission,
	isFileSystemAccessSupported,
	pickBookFile,
	sendReaderContent,
} from './book_loader.ts';
import { type BookSession, createBookSession } from './book_session.ts';
import { openBookSource, PdfSourceError } from './book_source_loader.ts';

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
	const [theme, setTheme] = useState<ThemeName>('default');
	const [showOriginal, setShowOriginal] = useState(false);
	const [positionState, setPositionState] = useState<{ kind: 'chapter' | 'page'; index: number; count: number } | null>(null);
	const bookSessionRef = useRef<BookSession | null>(null);
	const [savedProgress, setSavedProgress] = useState<BookProgressRecord | null>(null);
	const portRef = useRef<chrome.runtime.Port | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const snapshotSessionIdRef = useRef<string | null>(null);
	const scrollPauseManagerRef = useRef(new UserScrollPauseManager(3000));
	const wordRanges = useMemo(() => (snapshot ? mapDocumentReaderWords(snapshot.content, snapshot.words) : []), [snapshot]);
	const documentSession = isDocumentSession(session) ? session : null;
	const isLocalBook = isLocalBookSession(documentSession);
	/**
	 * A live session is the only thing that says where the audio came from, and stopping clears it
	 * — while the book stays on screen. Picking a file in this tab is the durable fact, so it is
	 * remembered here rather than read back off the session.
	 */
	const [openedLocalBook, setOpenedLocalBook] = useState(false);
	const documentSessionId = documentSession?.sessionId ?? null;
	const documentSourceTabId = documentSession?.source.tabId ?? null;
	const playbackStatus = documentSession?.status;

	/**
	 * The theme is picked in the popup or the side panel, never here — and this tab outlives both of
	 * them, so a stored value read once at load would go stale the moment the choice is changed.
	 */
	useEffect(() => {
		const isThemeName = (value: unknown): value is ThemeName => value === 'default' || value === 'winamp' || value === 'wmp12';

		chrome.storage.local.get(STORAGE_KEYS.THEME, (result) => {
			const storedTheme = result[STORAGE_KEYS.THEME];
			if (isThemeName(storedTheme)) {
				setTheme(storedTheme);
			}
		});

		const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
			const nextTheme = changes[STORAGE_KEYS.THEME]?.newValue;
			if (isThemeName(nextTheme)) {
				setTheme(nextTheme);
			}
		};
		chrome.storage.onChanged.addListener(handleStorageChange);
		return () => {
			chrome.storage.onChanged.removeListener(handleStorageChange);
		};
	}, []);

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
				// A new document arrives collapsed: the panel belongs to the text it was opened for.
				setShowOriginal(false);
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
		// The background hands a new page to the reader tab it already opened, so a book read here
		// earlier must not go on hiding the way back to the page that replaced it.
		if (!isLocalBook) {
			setOpenedLocalBook(false);
		}
		portRef.current?.postMessage({
			action: 'DOCUMENT_READER_ATTACH',
			sessionId: documentSessionId,
		} satisfies DocumentReaderPortMessage);
	}, [documentSessionId, documentSourceTabId, isLocalBook]);

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
		void loadBookProgress().then(async (progress) => {
			setSavedProgress(progress && (await getBookHandle()) ? progress : null);
		});
	}, []);

	useEffect(() => {
		const handleCompleted = (message: unknown) => {
			const bookSession = bookSessionRef.current;
			// A session this book never started — one left playing from before the tab reloaded —
			// must not chain the next chapter out from under the chapter being opened.
			if (!isDocumentReaderCompletedMessage(message) || !bookSession?.isPlaying(message.sessionId)) {
				return;
			}
			void bookSession.advance().then((advanced) => {
				if (advanced) {
					setPositionState(bookSession.state());
					return;
				}
				// End of book: hand the tab back to the picker so another book can be loaded.
				bookSessionRef.current = null;
				setPositionState(null);
				setSnapshot(null);
				void loadBookProgress().then(setSavedProgress);
			});
		};
		chrome.runtime.onMessage.addListener(handleCompleted);
		return () => chrome.runtime.onMessage.removeListener(handleCompleted);
	}, []);

	useEffect(() => {
		const bookSession = bookSessionRef.current;
		const range = wordRanges[currentWordIndex];
		if (!bookSession || !range) {
			return;
		}
		bookSession.recordPosition(range.start);
		if ((documentSession?.progressPercentage ?? 0) >= 80) {
			bookSession.prefetchNext();
		}
	}, [currentWordIndex, wordRanges, documentSession?.progressPercentage]);

	useEffect(() => {
		const flush = () => void bookSessionRef.current?.flush();
		const interval = setInterval(flush, 5000);
		window.addEventListener('beforeunload', flush);
		return () => {
			clearInterval(interval);
			window.removeEventListener('beforeunload', flush);
			flush();
		};
	}, []);

	const openBookSession = async (file: File, kind: BookKind): Promise<BookSession> =>
		createBookSession({
			book: await openBookSource(
				{ bytes: await file.arrayBuffer(), fileName: file.name, kind },
				{ loadPdfDocument: loadPdfJsDocument },
			),
			file: { name: file.name, size: file.size, lastModified: file.lastModified },
			startChapter: (payload) => sendReaderContent(payload),
			saveProgress: saveBookProgress,
			now: () => Date.now(),
		});

	/**
	 * A saved position only survives if it was written against this very file and the same chapter
	 * list. A record from a different count was numbered by a different list, so its index no
	 * longer names the chapter it was saved for.
	 */
	const resolveResumePoint = (saved: BookProgressRecord | null, file: File, chapterCount: number) =>
		saved && matchesSavedFile(saved, file) && saved.totalChapters === chapterCount
			? { chapterIndex: saved.chapterIndex, charOffset: saved.charOffset }
			: null;

	/** A paged document has one chapter, so only the file identity decides whether the offset holds. */
	const resolvePagedResumePoint = (saved: BookProgressRecord | null, file: File) =>
		saved && matchesSavedFile(saved, file) ? { chapterIndex: 0, charOffset: saved.charOffset } : null;

	const resumePointFor = (session: BookSession, saved: BookProgressRecord | null, file: File) => {
		const state = session.state();
		return state.kind === 'chapter' ? resolveResumePoint(saved, file, state.count) : resolvePagedResumePoint(saved, file);
	};

	const startBook = async (file: File, kind: BookKind, saved: BookProgressRecord | null): Promise<boolean> => {
		const bookSession = await openBookSession(file, kind);
		bookSessionRef.current = bookSession;
		const from = resumePointFor(bookSession, saved, file) ?? { chapterIndex: 0, charOffset: 0 };
		if (!(await bookSession.start(from))) {
			bookSessionRef.current = null;
			return false;
		}
		setPositionState(bookSession.state());
		setOpenedLocalBook(true);
		return true;
	};

	// A reload leaves the audio playing but the book object gone, so natural completion would
	// have nothing to chain the next chapter from. Take the playing chapter back over instead.
	useEffect(() => {
		if (bookSessionRef.current || !snapshot || !isLocalBook) {
			return;
		}
		let cancelled = false;
		void (async () => {
			const stored = await getBookHandle();
			const progress = await loadBookProgress();
			if (cancelled || !stored || !progress || !(await hasReadPermission(stored.handle))) {
				return;
			}
			const file = await stored.handle.getFile();
			const kind = detectBookKind(stored.fileName);
			if (cancelled || kind === null || kind === 'doc-legacy') {
				return;
			}
			const bookSession = await openBookSession(file, kind);
			const resumePoint = resumePointFor(bookSession, progress, file);
			if (cancelled || !resumePoint) {
				return;
			}
			await bookSession.adopt({
				chapterIndex: resumePoint.chapterIndex,
				sessionId: snapshot.sessionId,
				playingText: snapshot.content,
			});
			if (cancelled) {
				return;
			}
			bookSessionRef.current = bookSession;
			setPositionState(bookSession.state());
			setOpenedLocalBook(true);
		})().catch(() => undefined);
		return () => {
			cancelled = true;
		};
		// A reopened book replaces the session itself, so only a fresh snapshot can need adopting.
	}, [snapshot, isLocalBook]);

	/**
	 * A saved EPUB is a chapter out of many; a saved document is a percentage through one text. The
	 * record carries no page list — pages come from re-parsing the file — so the page number only
	 * appears once the book is open.
	 */
	const describeSavedProgress = (saved: BookProgressRecord): string => {
		if (saved.totalChapters > 1) {
			return `— ${t('chapterProgress')} ${saved.chapterIndex + 1}/${saved.totalChapters}`;
		}
		return saved.totalChars ? `— ${Math.round((saved.charOffset / saved.totalChars) * 100)}%` : '';
	};

	/** Every extractor throws a coded error; anything else is a failure with nothing to say. */
	const resolveBookError = (error: unknown): string =>
		(error instanceof EpubError || error instanceof DocxError || error instanceof PdfSourceError
			? getLocalizedPlaybackError(error.code)
			: undefined) ?? t('bookOpenFailed');

	const handleOpenBook = async () => {
		setBookError('');
		const handle = await pickBookFile();
		if (!handle) {
			return;
		}
		const kind = detectBookKind(handle.name);
		if (kind === 'doc-legacy') {
			setBookError(getLocalizedPlaybackError(DOCX_ERROR_CODES.legacyFormat) ?? t('bookOpenFailed'));
			return;
		}
		if (!kind) {
			setBookError(t('bookOpenFailed'));
			return;
		}
		setIsLoadingBook(true);
		try {
			const file = await handle.getFile();
			// Retaining the handle only enables resume; losing it must not block reading.
			await putBookHandle({ handle, fileName: file.name, fileSize: file.size, fileLastModified: file.lastModified }).catch(
				() => undefined,
			);
			if (!(await startBook(file, kind, null))) {
				setBookError(t('bookOpenFailed'));
			}
		} catch (error) {
			setBookError(resolveBookError(error));
		} finally {
			setIsLoadingBook(false);
		}
	};

	const handleResumeBook = async () => {
		setBookError('');
		const progress = savedProgress;
		const stored = await getBookHandle();
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
			const kind = detectBookKind(stored.fileName);
			if (kind === null || kind === 'doc-legacy') {
				setBookError(t('bookOpenFailed'));
				return;
			}
			if (!(await startBook(file, kind, progress))) {
				setBookError(t('bookOpenFailed'));
			}
		} catch (error) {
			setBookError(resolveBookError(error));
		} finally {
			setIsLoadingBook(false);
		}
	};

	// Unlike natural completion, running out of chapters here must not send the tab back to the
	// picker: the chapter the reader is listening to simply keeps playing.
	const handlePositionJump = (direction: 'previous' | 'next') => {
		const bookSession = bookSessionRef.current;
		if (!bookSession) {
			return;
		}
		void (direction === 'previous' ? bookSession.previous() : bookSession.advance()).then((moved) => {
			if (moved) {
				setPositionState(bookSession.state());
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

	// A session that fails before it produces words leaves this page on its empty state forever, and
	// the reader is the only surface in front of the reader on a translated session — the popup that
	// would otherwise carry the message is closed. Worded the same way the popup words it.
	const playbackError = status === 'error' ? (getLocalizedPlaybackError(documentSession?.error) ?? t('startReadingFailed')) : '';

	const displayVersion = getDisplayVersion();

	return (
		<main className="document-reader" data-theme={theme} aria-label="readit.dev Document Reader">
			{/*
			 * Above the document rather than inside the empty state: a session that dies after its text
			 * has been delivered leaves this page showing a perfectly normal document that simply never
			 * speaks, which is the case most in need of an explanation.
			 */}
			{playbackError && (
				<div className="alert alert-danger document-reader-playback-error" role="alert">
					{playbackError}
				</div>
			)}
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
					{/*
					 * Two ways there is nowhere to go back to: this tab has not been attached to a page
					 * yet, or the book was opened from this very tab. A permanently dead button says
					 * neither of those; it just sits there.
					 */}
					{sourceTabId !== null && !isLocalBook && !openedLocalBook && (
						<button
							className="btn btn-secondary btn-back-source"
							type="button"
							onClick={() => void chrome.tabs.update(sourceTabId, { active: true })}
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
							{/* A document with a single page or chapter has nowhere to step to. */}
							{positionState && positionState.count > 1 && (
								<button
									className="btn btn-secondary btn-icon-only btn-previous-chapter"
									type="button"
									disabled={positionState.index === 0}
									aria-label={t(positionState.kind === 'page' ? 'previousPage' : 'previousChapter')}
									title={t(positionState.kind === 'page' ? 'previousPage' : 'previousChapter')}
									onClick={() => handlePositionJump('previous')}
								>
									<PlaybackIcon name="previous" />
								</button>
							)}
							{/* Held in place while stopped or loading: a transport that drops a button mid-read
							    moves every control beside it. */}
							<button
								className="btn btn-primary btn-icon-only"
								type="button"
								disabled={status !== 'playing' && status !== 'paused'}
								aria-label={status === 'playing' ? t('pauseState') : t('resumeStatus')}
								title={status === 'playing' ? t('pauseState') : t('resumeStatus')}
								onClick={() =>
									void sendPlaybackCommand({ action: status === 'playing' ? 'PAUSE_READING' : 'RESUME_READING' })
								}
							>
								<PlaybackIcon name={status === 'playing' ? 'pause' : 'resume'} />
							</button>
							<button
								className="btn btn-secondary btn-icon-only btn-stop-reading"
								type="button"
								disabled={status === 'stopped'}
								aria-label={t('stopReading')}
								title={t('stopReading')}
								onClick={() => void sendPlaybackCommand({ action: 'STOP_READING' })}
							>
								<PlaybackIcon name="stop" />
							</button>
							{positionState && positionState.count > 1 && (
								<button
									className="btn btn-secondary btn-icon-only btn-next-chapter"
									type="button"
									disabled={positionState.index >= positionState.count - 1}
									aria-label={t(positionState.kind === 'page' ? 'nextPage' : 'nextChapter')}
									title={t(positionState.kind === 'page' ? 'nextPage' : 'nextChapter')}
									onClick={() => handlePositionJump('next')}
								>
									<PlaybackIcon name="next" />
								</button>
							)}
							<AudioExportButton session={documentSession} />
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
								<span className="form-label">{t('progressLabel')}</span>
								<span className="slider-value">{Math.round(documentSession?.progressPercentage ?? 0)}%</span>
							</div>
							{/* "Page 1/1" states nothing the reader does not already see. */}
							{positionState && positionState.count > 1 && (
								<span className="slider-value">
									{t(positionState.kind === 'page' ? 'pageProgress' : 'chapterProgress')} {positionState.index + 1}/
									{positionState.count}
								</span>
							)}
							<div className="progress-bar-container">
								<div className="progress-bar" style={{ width: `${documentSession?.progressPercentage ?? 0}%` }} />
							</div>
						</div>
					</section>
					{snapshot.translation && snapshot.originalContent && (
						<aside className="translation-notice">
							<h2>{t('translationNoticeTitle')}</h2>
							<p>
								{t('translationNoticeBody')}{' '}
								<span className="translation-notice-pair">
									({snapshot.translation.sourceLanguage} → {snapshot.translation.targetLanguage})
								</span>
							</p>
							<button type="button" onClick={() => setShowOriginal((shown) => !shown)}>
								{showOriginal ? t('translationHideOriginal') : t('translationViewOriginal')}
							</button>
							{showOriginal && (
								<div className="translation-original">
									<h3>{t('translationOriginalHeading')}</h3>
									<p>{snapshot.originalContent}</p>
								</div>
							)}
						</aside>
					)}
					{/*
					 * The original text lives in its own panel rather than replacing this element:
					 * highlight positioning reads `contentRef.current.firstChild`, which has to keep
					 * pointing at the text being spoken.
					 */}
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
									{t('resumeReading')}: {savedProgress.title} {describeSavedProgress(savedProgress)}
								</button>
							)}
						</div>
					)}
				</section>
			)}
		</main>
	);
}
