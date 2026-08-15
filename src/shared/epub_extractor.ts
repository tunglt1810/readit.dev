import JSZip from 'jszip';

import type { BookSource } from './book_source.ts';
import { EPUB_ERROR_CODES, type EpubErrorCode } from './constants.ts';

const CONTAINER_PATH = 'META-INF/container.xml';
const ENCRYPTION_PATH = 'META-INF/encryption.xml';
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, pre';

export class EpubError extends Error {
	readonly code: EpubErrorCode;

	constructor(code: EpubErrorCode) {
		super(code);
		this.name = 'EpubError';
		this.code = code;
	}
}

export type EpubBook = BookSource;

export interface EpubChapter {
	title: string;
	/** Spine slots this chapter is read from, in reading order. */
	spineIndices: number[];
}

/**
 * The spine is a file list, not a chapter list: covers, title pages and the contents page each
 * occupy a slot. What a reader means by "chapter" is what the book's own navigation names, so the
 * table of contents decides both the numbering and where each chapter starts.
 */
export function buildChapterList(spinePaths: readonly string[], tocEntries: readonly { title: string; path: string }[]): EpubChapter[] {
	const spineIndexByPath = new Map(spinePaths.map((path, index) => [path, index]));
	const titleByStart = new Map<number, string>();
	for (const entry of tocEntries) {
		const spineIndex = spineIndexByPath.get(entry.path);
		// Sub-sections point into a file an earlier entry already opened; they start no new chapter.
		if (spineIndex !== undefined && !titleByStart.has(spineIndex)) {
			titleByStart.set(spineIndex, entry.title);
		}
	}

	// A book whose navigation is missing or points outside the spine still has to be readable.
	if (titleByStart.size === 0) {
		return spinePaths.map((_, spineIndex) => ({ title: '', spineIndices: [spineIndex] }));
	}

	// The spine, not the navigation, is the definitive reading order.
	const starts = [...titleByStart.keys()].sort((left, right) => left - right);
	return starts.map((start, position) => ({
		title: titleByStart.get(start) ?? '',
		// Slots between two nav targets are continuations of the earlier one, and dropping them
		// would silently lose text. Slots before the first target are front matter the book itself
		// declined to navigate to.
		spineIndices: Array.from({ length: (starts[position + 1] ?? spinePaths.length) - start }, (_, offset) => start + offset),
	}));
}

export interface EpubExtractorDependencies {
	parseXml(text: string, mimeType: 'text/xml' | 'application/xhtml+xml'): Document;
}

function defaultDependencies(): EpubExtractorDependencies {
	return {
		parseXml: (text, mimeType) => new DOMParser().parseFromString(text, mimeType),
	};
}

/** Resolve a manifest href against the OPF's own directory, as EPUB paths are OPF-relative. */
export function resolveHref(opfPath: string, href: string): string {
	const directory = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
	const segments = directory ? directory.split('/') : [];
	for (const segment of decodeURIComponent(href).split('/')) {
		if (segment === '.' || segment === '') {
			continue;
		}
		if (segment === '..') {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join('/');
}

export function normalizeChapterText(blocks: readonly string[]): string {
	return blocks
		.map((block) => block.replace(/\s+/gu, ' ').trim())
		.filter((block) => block.length > 0)
		.join('\n\n');
}

/** Nav targets carry a fragment when they point at a heading inside a file; the file is the target. */
function tocEntryPath(opfPath: string, href: string): string {
	return resolveHref(opfPath, href.split('#')[0]);
}

/** EPUB 3 ships an XHTML navigation document; its `toc` nav is the table of contents. */
function readNavDocument(opfPath: string, nav: Document): { title: string; path: string }[] {
	const navs = Array.from(nav.getElementsByTagName('nav'));
	const toc = navs.find((element) => (element.getAttribute('epub:type') ?? '').split(/\s+/u).includes('toc')) ?? navs[0];
	return Array.from(toc?.querySelectorAll('a[href]') ?? [])
		.map((anchor) => ({ title: (anchor.textContent ?? '').replace(/\s+/gu, ' ').trim(), href: anchor.getAttribute('href') ?? '' }))
		.filter((entry) => entry.href)
		.map((entry) => ({ title: entry.title, path: tocEntryPath(opfPath, entry.href) }));
}

/** EPUB 2 ships an NCX instead, where each navPoint names one destination. */
function readNcxDocument(opfPath: string, ncx: Document): { title: string; path: string }[] {
	return Array.from(ncx.getElementsByTagName('navPoint'))
		.map((point) => ({
			title: (point.getElementsByTagName('text')[0]?.textContent ?? '').replace(/\s+/gu, ' ').trim(),
			href: point.getElementsByTagName('content')[0]?.getAttribute('src') ?? '',
		}))
		.filter((entry) => entry.href)
		.map((entry) => ({ title: entry.title, path: tocEntryPath(opfPath, entry.href) }));
}

/**
 * Locates whichever table of contents the book ships — EPUB 3's navigation document or EPUB 2's
 * NCX — and returns its destinations. An unreadable or absent one yields nothing, which
 * `buildChapterList` handles by falling back to the spine.
 */
async function readTableOfContents(
	archive: JSZip,
	opfPath: string,
	opf: Document,
	hrefById: ReadonlyMap<string, string>,
	dependencies: EpubExtractorDependencies,
): Promise<{ title: string; path: string }[]> {
	const navItem = Array.from(opf.getElementsByTagName('item')).find((item) =>
		(item.getAttribute('properties') ?? '').split(/\s+/u).includes('nav'),
	);
	const navPath = navItem?.getAttribute('id') ? hrefById.get(navItem.getAttribute('id') as string) : undefined;
	const ncxPath = hrefById.get(opf.getElementsByTagName('spine')[0]?.getAttribute('toc') ?? '');
	const source = navPath ? { path: navPath, isNav: true } : ncxPath ? { path: ncxPath, isNav: false } : null;
	if (!source) {
		return [];
	}
	try {
		const xml = await archive.file(source.path)?.async('string');
		if (!xml) {
			return [];
		}
		const document = dependencies.parseXml(xml, source.isNav ? 'application/xhtml+xml' : 'text/xml');
		return source.isNav ? readNavDocument(opfPath, document) : readNcxDocument(opfPath, document);
	} catch (_error) {
		// A malformed table of contents must not stop a book from being read at all.
		return [];
	}
}

function elementText(document: Document, tagName: string): string | undefined {
	const value = document.getElementsByTagName(tagName)[0]?.textContent?.trim();
	return value ? value : undefined;
}

export async function openEpubBook(bytes: ArrayBuffer, dependencies: EpubExtractorDependencies = defaultDependencies()): Promise<EpubBook> {
	let archive: JSZip;
	try {
		archive = await JSZip.loadAsync(bytes);
	} catch {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}

	if (archive.file(ENCRYPTION_PATH)) {
		throw new EpubError(EPUB_ERROR_CODES.drmProtected);
	}

	const containerXml = await archive.file(CONTAINER_PATH)?.async('string');
	if (!containerXml) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}
	const opfPath = dependencies.parseXml(containerXml, 'text/xml').getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
	if (!opfPath) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}

	const opfXml = await archive.file(opfPath)?.async('string');
	if (!opfXml) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}
	const opf = dependencies.parseXml(opfXml, 'text/xml');

	const hrefById = new Map<string, string>();
	for (const item of Array.from(opf.getElementsByTagName('item'))) {
		const id = item.getAttribute('id');
		const href = item.getAttribute('href');
		if (id && href) {
			hrefById.set(id, resolveHref(opfPath, href));
		}
	}

	const spinePaths = Array.from(opf.getElementsByTagName('itemref'))
		.map((itemref) => itemref.getAttribute('idref'))
		.map((idref) => (idref ? hrefById.get(idref) : undefined))
		.filter((path): path is string => Boolean(path));

	if (spinePaths.length === 0) {
		throw new EpubError(EPUB_ERROR_CODES.parseFailed);
	}

	const chapters = buildChapterList(spinePaths, await readTableOfContents(archive, opfPath, opf, hrefById, dependencies));

	return {
		title: elementText(opf, 'dc:title') ?? elementText(opf, 'title') ?? '',
		lang: elementText(opf, 'dc:language') ?? elementText(opf, 'language') ?? '',
		chapterCount: chapters.length,
		async getChapterText(index) {
			const blocks: string[] = [];
			for (const spineIndex of chapters[index]?.spineIndices ?? []) {
				const path = spinePaths[spineIndex];
				const chapterXml = path ? await archive.file(path)?.async('string') : undefined;
				if (!chapterXml) {
					continue;
				}
				const document = dependencies.parseXml(chapterXml, 'application/xhtml+xml');
				const slotBlocks = Array.from(document.querySelectorAll(BLOCK_SELECTOR)).map((element) => element.textContent ?? '');
				// Some books wrap everything in divs; fall back to the whole body rather than reading nothing.
				blocks.push(...(slotBlocks.length > 0 ? slotBlocks : [document.body?.textContent ?? '']));
			}
			return normalizeChapterText(blocks);
		},
	};
}
