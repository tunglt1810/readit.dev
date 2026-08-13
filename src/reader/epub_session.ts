import type { EpubBook } from '../shared/epub_extractor.ts';
import { resolveChapterStart, toAbsoluteOffset } from '../shared/epub_position.ts';
import type { EpubProgressRecord } from '../shared/epub_progress_store.ts';

export interface EpubSessionDependencies {
	book: EpubBook;
	file: { name: string; size: number; lastModified: number };
	startChapter(payload: { title: string; content: string; lang: string }): Promise<{ success: boolean; sessionId?: string }>;
	saveProgress(record: EpubProgressRecord): Promise<void>;
	now(): number;
}

export interface EpubSession {
	start(from: { chapterIndex: number; charOffset: number }): Promise<boolean>;
	/**
	 * Take over a chapter that is already playing. The Reader tab can reload while the audio
	 * carries on, leaving a session to chain from but nothing to start.
	 */
	adopt(playing: { chapterIndex: number; sessionId: string; playingText: string }): Promise<void>;
	advance(): Promise<boolean>;
	/** Play the nearest readable chapter before this one; false when there is none. */
	previous(): Promise<boolean>;
	/** Whether a playback session id belongs to the chapter this book is currently playing. */
	isPlaying(sessionId: string): boolean;
	recordPosition(sliceRangeStart: number): void;
	prefetchNext(): void;
	flush(): Promise<void>;
	state(): { chapterIndex: number; chapterCount: number };
}

export function createEpubSession(dependencies: EpubSessionDependencies): EpubSession {
	const { book, file } = dependencies;
	let chapterIndex = 0;
	let baseOffset = 0;
	let pendingOffset = 0;
	let prefetched: { index: number; text: string } | null = null;
	let playingSessionId: string | null = null;

	const chapterText = async (index: number): Promise<string> => {
		if (prefetched?.index === index) {
			const { text } = prefetched;
			prefetched = null;
			return text;
		}
		return book.getChapterText(index);
	};

	const buildRecord = (): EpubProgressRecord => ({
		title: book.title || file.name,
		chapterIndex,
		charOffset: pendingOffset,
		totalChapters: book.chapterCount,
		fileSize: file.size,
		fileLastModified: file.lastModified,
		updatedAt: dependencies.now(),
	});

	const playChapter = async (index: number, charOffset: number): Promise<boolean> => {
		const text = (await chapterText(index)).trim();
		if (!text) {
			return false;
		}
		const slice = resolveChapterStart(text, charOffset);
		chapterIndex = index;
		baseOffset = slice.baseOffset;
		pendingOffset = slice.baseOffset;
		const started = await dependencies.startChapter({ title: book.title || file.name, content: slice.text, lang: book.lang });
		playingSessionId = started.success ? (started.sessionId ?? null) : null;
		if (started.success) {
			await dependencies.saveProgress(buildRecord());
		}
		return started.success;
	};

	/** Walk in one direction until a chapter with text plays; empty ones are passed over silently. */
	const seek = async (from: number, step: 1 | -1): Promise<boolean> => {
		for (let index = from; index >= 0 && index < book.chapterCount; index += step) {
			if (await playChapter(index, 0)) {
				return true;
			}
		}
		return false;
	};

	return {
		async start(from) {
			for (let index = Math.max(0, from.chapterIndex); index < book.chapterCount; index++) {
				// Only the requested chapter honours the saved offset; skipped-into chapters start fresh.
				if (await playChapter(index, index === from.chapterIndex ? from.charOffset : 0)) {
					return true;
				}
			}
			return false;
		},
		async adopt(playing) {
			const full = (await book.getChapterText(playing.chapterIndex)).trim();
			chapterIndex = playing.chapterIndex;
			// A played slice is always the tail of its chapter, so what precedes it is the base.
			baseOffset = Math.max(0, full.length - playing.playingText.length);
			pendingOffset = baseOffset;
			playingSessionId = playing.sessionId;
		},
		async advance() {
			return seek(chapterIndex + 1, 1);
		},
		async previous() {
			return seek(chapterIndex - 1, -1);
		},
		isPlaying(sessionId) {
			return playingSessionId !== null && sessionId === playingSessionId;
		},
		recordPosition(sliceRangeStart) {
			pendingOffset = toAbsoluteOffset(baseOffset, sliceRangeStart);
		},
		prefetchNext() {
			const next = chapterIndex + 1;
			if (prefetched?.index === next || next >= book.chapterCount) {
				return;
			}
			void book.getChapterText(next).then(
				(text) => {
					prefetched = { index: next, text };
				},
				() => {
					prefetched = null;
				},
			);
		},
		async flush() {
			await dependencies.saveProgress(buildRecord());
		},
		state() {
			return { chapterIndex, chapterCount: book.chapterCount };
		},
	};
}
