/**
 * What the reader needs from a book, whatever format it came from. EPUB supplies many chapters;
 * PDF and DOCX supply exactly one and describe their pages with `pageStarts` instead.
 */
export interface BookSource {
	title: string;
	lang: string;
	chapterCount: number;
	getChapterText(index: number): Promise<string>;
	/** Character offsets where each page starts inside chapter 0's text. Single-chapter books only. */
	pageStarts?: readonly number[];
}
