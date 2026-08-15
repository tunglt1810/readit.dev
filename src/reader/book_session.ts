import type { BookProgressRecord } from '../shared/book_progress_store.ts';
import type { BookSource } from '../shared/book_source.ts';
import { resolveChapterStart, toAbsoluteOffset } from '../shared/epub_position.ts';

export interface BookSessionDependencies {
	book: BookSource;
	file: { name: string; size: number; lastModified: number };
	startChapter(payload: { title: string; content: string; lang: string }): Promise<{ success: boolean; sessionId?: string }>;
	saveProgress(record: BookProgressRecord): Promise<void>;
	now(): number;
}

export interface BookSession {
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
	/** Where the reader is: a chapter for EPUB, a page for single-chapter documents. */
	state(): { kind: 'chapter' | 'page'; index: number; count: number };
}

export function createBookSession(dependencies: BookSessionDependencies): BookSession {
	const { book, file } = dependencies;
	let chapterIndex = 0;
	let baseOffset = 0;
	let pendingOffset = 0;
	let prefetched: { index: number; text: string } | null = null;
	let playingSessionId: string | null = null;

	// A document with page starts is one chapter long; its navigation unit is the page.
	const pageStarts = book.chapterCount === 1 && book.pageStarts?.length ? [...book.pageStarts] : null;
	let totalChars: number | undefined;

	/** The page containing an offset: the last start at or before it. */
	const pageIndexAt = (offset: number): number => {
		if (!pageStarts) {
			return 0;
		}
		let low = 0;
		let high = pageStarts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (pageStarts[middle] <= offset) {
				low = middle;
			} else {
				high = middle - 1;
			}
		}
		return low;
	};

	const chapterText = async (index: number): Promise<string> => {
		if (prefetched?.index === index) {
			const { text } = prefetched;
			prefetched = null;
			return text;
		}
		return book.getChapterText(index);
	};

	const buildRecord = (): BookProgressRecord => ({
		title: book.title || file.name,
		chapterIndex,
		charOffset: pendingOffset,
		totalChapters: book.chapterCount,
		totalChars,
		fileSize: file.size,
		fileLastModified: file.lastModified,
		updatedAt: dependencies.now(),
	});

	const playChapter = async (index: number, charOffset: number): Promise<boolean> => {
		const text = (await chapterText(index)).trim();
		if (!text) {
			return false;
		}
		totalChars = text.length;
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
			if (pageStarts) {
				const next = pageIndexAt(pendingOffset) + 1;
				return next < pageStarts.length ? playChapter(0, pageStarts[next]) : false;
			}
			return seek(chapterIndex + 1, 1);
		},
		async previous() {
			if (pageStarts) {
				const previousPage = pageIndexAt(pendingOffset) - 1;
				return previousPage >= 0 ? playChapter(0, pageStarts[previousPage]) : false;
			}
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
			return pageStarts
				? { kind: 'page' as const, index: pageIndexAt(pendingOffset), count: pageStarts.length }
				: { kind: 'chapter' as const, index: chapterIndex, count: book.chapterCount };
		},
	};
}
