import { base64ToBytes } from '../shared/base64.ts';
import { WORD_ONLINE_DOWNLOAD_UNAVAILABLE } from '../shared/constants.ts';
import { extractDocxText } from '../shared/docx_extractor.ts';
import { detectContentLanguage } from '../shared/language_detection.ts';
import type { Article } from '../shared/types.ts';

export type WordOnlineArticleResult =
	| { success: true; article: Article; readableSurface: 'document-reader' }
	| { success: false; error: typeof WORD_ONLINE_DOWNLOAD_UNAVAILABLE };

/**
 * Parsing happens here rather than in the content script so JSZip stays out of the bundle injected
 * into every page. Every `DocxError` collapses into the one download code: an Excel workbook opened
 * through `Doc.aspx` and a denied download need the same advice from the user's point of view.
 */
export async function buildWordOnlineArticle(
	docxBase64: string,
	source: Pick<Article, 'url' | 'title' | 'lang'>,
): Promise<WordOnlineArticleResult> {
	try {
		const bytes = base64ToBytes(docxBase64);
		const { title, content } = await extractDocxText(bytes.buffer as ArrayBuffer, source.title);
		return {
			success: true,
			article: { title, content, url: source.url, lang: detectContentLanguage(content, source.lang) },
			readableSurface: 'document-reader',
		};
	} catch {
		return { success: false, error: WORD_ONLINE_DOWNLOAD_UNAVAILABLE };
	}
}
