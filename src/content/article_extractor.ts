import { Readability } from '@mozilla/readability';

import type { Article } from '../shared/types.ts';

const STRUCTURAL_NOISE_SELECTOR = [
	'script',
	'style',
	'noscript',
	'template',
	'iframe',
	'canvas',
	'svg',
	'form',
	'button',
	'input',
	'textarea',
	'select',
	'nav',
	'aside',
	'footer',
	'[hidden]',
	'[aria-hidden="true"]',
	'[role="navigation"]',
	'[role="menu"]',
	'[role="menubar"]',
	'[role="complementary"]',
	'[role="search"]',
].join(',');

const NOISE_IDENTITY_PATTERN =
	/(?:advert|banner|comment|related|recommend|lienquan|xemnhieu|social|share|sidebar|navigation|menu(?!id)|toolbar|control|player|flip|promo|category|breadcrumb|cate[-_]|meta[-_]header)/i;
const ARTICLE_END_PATTERN = /article[-_]?end/i;
const LONG_SPAN_MIN_LENGTH = 20;

const BLOCK_ELEMENT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'BLOCKQUOTE', 'PRE', 'LI', 'FIGCAPTION']);

// Inline-only elements that may act as paragraph containers on non-standard CMSes (e.g. XenForo).
// When not nested inside a block element, they are treated as block text if their content is long enough.
const INLINE_ELEMENT_TAGS = new Set(['SPAN', 'B', 'STRONG', 'EM', 'I', 'U', 'CITE', 'ABBR']);

/**
 * Returns true if `el` has a block-level element ancestor between itself and `root`.
 * Used to avoid promoting spans that are already inside a captured block (e.g. <p><span>...).
 */
export function isWithinBlockElement(el: Element, root: Element): boolean {
	let ancestor: Element | null = el.parentElement;
	while (ancestor && ancestor !== root) {
		if (BLOCK_ELEMENT_TAGS.has(ancestor.tagName)) {
			return true;
		}
		ancestor = ancestor.parentElement;
	}
	return false;
}
function getElementIdentity(element: Element): string {
	const className = typeof element.className === 'string' ? element.className : '';
	return `${element.id} ${className} ${element.getAttribute('role') || ''}`;
}

function isNoiseElement(element: Element): boolean {
	return NOISE_IDENTITY_PATTERN.test(getElementIdentity(element));
}

/**
 * Non-mutating equivalent of the ancestor-based noise checks in `cleanContentTree`
 * (STRUCTURAL_NOISE_SELECTOR + isNoiseElement). Known limitation: does not replicate
 * `trimAtArticleEnd`'s "everything after an article-end marker" rule, since that is a
 * document-order exclusion rather than an ancestor check — content after such a marker
 * on a live page will not be treated as noise here.
 *
 * The ancestor walk stops at `boundaryRoot` (defaults to `document.body`) instead of going
 * all the way to `<html>`. Without a boundary, a real page's own OUTER layout wrapper can
 * false-positive match `NOISE_IDENTITY_PATTERN` for reasons that have nothing to do with the
 * article itself (e.g. a site naming its main-content grid column "sidebar-1"), which would
 * incorrectly exclude the entire article. `cleanContentTree` never has this problem because it
 * only ever inspects descendants of an already-chosen root, never that root's own ancestors.
 */
export function isWithinNoiseRegion(node: Node, boundaryRoot: Node = document.body): boolean {
	let element: Element | null = node instanceof Element ? node : node.parentElement;
	while (element && element !== boundaryRoot) {
		if (element.matches(STRUCTURAL_NOISE_SELECTOR) || isNoiseElement(element)) {
			return true;
		}
		element = element.parentElement;
	}
	return false;
}

function trimAtArticleEnd(root: Element): void {
	const endMarker = Array.from(root.querySelectorAll('[id], [class]')).find((element) =>
		ARTICLE_END_PATTERN.test(getElementIdentity(element)),
	);

	if (!endMarker) {
		return;
	}

	let current: ChildNode | null = endMarker;
	while (current) {
		const next: ChildNode | null = current.nextSibling;
		current.remove();
		current = next;
	}
}

function removeStructuralNoise(root: Element): void {
	for (const element of Array.from(root.querySelectorAll(STRUCTURAL_NOISE_SELECTOR))) {
		element.remove();
	}
}

export function cleanContentTree(root: Element): void {
	trimAtArticleEnd(root);
	removeStructuralNoise(root);

	for (const element of Array.from(root.querySelectorAll('*'))) {
		if (isNoiseElement(element)) {
			element.remove();
		}
	}
}

function normaliseText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// element.textContent concatenates every descendant text node with zero separator, even across
// element boundaries that have no real whitespace text node between them in the source HTML (e.g.
// a "<span>An Giang</span>Thấy nhiều..." location-stamp badge that relies purely on CSS
// background/border for visual separation from the sentence that follows it). That silently fuses
// two real words into one unpronounceable, unmatchable token ("GiangThấy") — breaking both TTS
// pronunciation and word-highlight DOM lookup. Walking text nodes and inserting a boundary space
// wherever one doesn't already exist keeps normal prose (which already has real whitespace at
// every element boundary) unchanged while fixing this fusion.
const SHOW_ELEMENT = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_ELEMENT : 1;
const SHOW_TEXT = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;

function extractBlockText(element: Element): string {
	const walker = (element.ownerDocument ?? document).createTreeWalker(element, SHOW_TEXT);
	let result = '';
	let node = walker.nextNode();
	while (node) {
		const text = node.textContent ?? '';
		if (text) {
			if (result && !/\s$/.test(result) && !/^\s/.test(text)) {
				result += ' ';
			}
			result += text;
		}
		node = walker.nextNode();
	}
	return result;
}

const TEXT_NODE_TYPE = typeof Node !== 'undefined' ? Node.TEXT_NODE : 3;
const ELEMENT_NODE_TYPE = typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1;

// When an element uses <br> as line separators (common in XenForo span.xf-body-paragraph
// bullet lists), split it into individual text blocks so each line gets its own TTS pause.
function extractBrBlocks(element: Element, blocks: string[]): void {
	const segments: string[] = [];
	let current = '';
	for (const child of element.childNodes) {
		if (child.nodeType === TEXT_NODE_TYPE) {
			current += child.textContent;
		} else if ((child as Element).tagName === 'BR') {
			segments.push(current);
			current = '';
		} else {
			// Inline element (b, a, em…) — keep its text in the current segment
			current += (child as Element).textContent || '';
		}
	}
	segments.push(current);

	for (const seg of segments) {
		appendBlock(blocks, normaliseText(seg));
	}
}

// Skip an element's entire subtree in a TreeWalker. Moving directly to nextSibling is not enough
// when an element is the last child of its parent (nextSibling is null): calling nextNode()
// would erroneously dive into the element's first child instead of skipping it.
function skipSubtree(walker: TreeWalker): Element | null {
	let next = walker.nextSibling() as Element | null;
	while (!next) {
		const parent = walker.parentNode();
		if (!parent) {
			return null;
		}
		next = walker.nextSibling() as Element | null;
	}
	return next;
}

// Guards against emitting the same text twice for the same DOM position — a container and the
// child it just consumed, or a flushed run that duplicates the block that follows. It deliberately
// only compares against the block just emitted, never the whole document: a phrase can legitimately
// appear more than once in an article (an x.com longform post lists its sections up front, then
// opens each section with that same phrase in bold), and de-duplicating globally silently deleted
// the repeat from what gets read aloud — which also put the spoken word list out of step with the
// DOM the highlighter walks.
function appendBlock(blocks: string[], text: string): void {
	if (text && blocks[blocks.length - 1] !== text) {
		blocks.push(text);
	}
}

export function getTextBlocks(root: Element): string[] {
	const blocks: string[] = [];
	const ownerDoc = root.ownerDocument ?? document;

	// Single-pass TreeWalker maintains document order and enables subtree skipping
	// to avoid double-counting text that appears in both a parent and its descendants.
	// Promotes long orphan inlines (e.g. XenForo's span.xf-body-paragraph) as block text.
	// For container elements we walk through, collects any direct text-node children
	// (prose fragments in div.xfBody etc.) splitting on newlines to preserve paragraph breaks.
	const walker = ownerDoc.createTreeWalker(root, SHOW_ELEMENT);
	let node = walker.nextNode() as Element | null;

	while (node) {
		const isStandardBlock = BLOCK_ELEMENT_TAGS.has(node.tagName);
		const isLongOrphanInline =
			INLINE_ELEMENT_TAGS.has(node.tagName) &&
			!isWithinBlockElement(node, root) &&
			normaliseText(node.textContent || '').length >= LONG_SPAN_MIN_LENGTH;

		if (isStandardBlock || isLongOrphanInline) {
			if (node.querySelector('br')) {
				extractBrBlocks(node, blocks);
			} else {
				appendBlock(blocks, normaliseText(extractBlockText(node)));
			}
			node = skipSubtree(walker);
		} else {
			// For container elements we walk into, collect runs of adjacent direct text nodes
			// and short inline element children, merging them into single coherent blocks.
			// Break runs at <br> or block-level element boundaries.
			// Short inline children (e.g. <b>18 năm 5 tháng</b>) that are below threshold
			// individually are included in the surrounding text run so they are not lost.
			let run = '';
			const flushRun = (): void => {
				const text = normaliseText(run);
				if (text.length >= LONG_SPAN_MIN_LENGTH) {
					appendBlock(blocks, text);
				}
				run = '';
			};
			for (const child of node.childNodes) {
				const childEl = child as Element;
				if (child.nodeType === TEXT_NODE_TYPE) {
					const lines = (child.textContent || '').split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (i > 0) {
							flushRun();
						}
						const seg = lines[i];
						if (seg.trim()) {
							if (run && !/\s$/.test(run)) {
								run += ' ';
							}
							run += seg;
						}
					}
				} else if (child.nodeType === ELEMENT_NODE_TYPE) {
					if (childEl.tagName === 'BR') {
						flushRun();
					} else if (INLINE_ELEMENT_TAGS.has(childEl.tagName)) {
						if (normaliseText(childEl.textContent || '').length >= LONG_SPAN_MIN_LENGTH) {
							// Long inline: will be captured by isLongOrphanInline when walker visits it — flush run
							flushRun();
						} else {
							// Short inline element (e.g. <b>, <a>): merge its text into current run
							const t = childEl.textContent || '';
							if (t.trim()) {
								if (run && !/\s$/.test(run)) {
									run += ' ';
								}
								run += t;
							}
						}
					} else {
						// Any container or block element (DIV, SECTION, P, UL, etc.): flush run
						// and do NOT consume its text content; TreeWalker will visit its children
						flushRun();
					}
				}
			}
			flushRun();
			node = walker.nextNode() as Element | null;
		}
	}

	return blocks;
}

function getLinkTextLength(root: Element): number {
	return Array.from(root.querySelectorAll('a')).reduce((length, link) => length + normaliseText(link.textContent || '').length, 0);
}

function hasQualityText(text: string, blockCount: number, linkTextLength: number): boolean {
	const normalisedLength = normaliseText(text).length;
	return normalisedLength >= 120 && blockCount > 0 && linkTextLength / normalisedLength < 0.6;
}

// A title has to be text the page actually renders, because it leads the spoken content and
// therefore leads the word list the highlighter maps against the live DOM. `document.title` often
// is not: x.com wraps the real heading in chrome it never displays — an unread count and a " / X"
// suffix — and its heading is not an <h1>, so the usual lookup misses it. Speaking that string
// reads the unread count aloud, and its extra words ("on", "X") match arbitrary spots further down
// the page, dragging the mapping cursor off the article before the body even starts.
//
// So when there is no in-root heading, prefer a block the page renders that the tab title merely
// wraps. A page with no such block keeps the tab title exactly as before.
const MIN_RENDERED_TITLE_LENGTH = 10;

export function resolveArticleTitle(root: Element, blocks: readonly string[], documentTitle: string): string {
	const heading = normaliseText(root.querySelector('h1')?.textContent || '');
	if (heading) {
		return heading;
	}
	const tabTitle = normaliseText(documentTitle);
	const rendered = blocks.find((block) => block.length >= MIN_RENDERED_TITLE_LENGTH && tabTitle.includes(block));
	return rendered || tabTitle || 'Untitled Article';
}

function getLanguage(sourceDocument: Document): string {
	let lang = sourceDocument.documentElement.lang || 'en';
	if (lang.includes('-')) {
		lang = lang.split('-')[0];
	}
	return lang.toLowerCase();
}

function articleFromRoot(root: Element, sourceDocument: Document, fallbackTitle?: string): Article | null {
	cleanContentTree(root);

	const blocks = getTextBlocks(root);
	const title = resolveArticleTitle(root, blocks, fallbackTitle || sourceDocument.title);
	const contentBlocks = blocks.filter((block) => block !== title);
	const content = [title, ...contentBlocks].join('\n\n').trim();

	if (!hasQualityText(content, contentBlocks.length, getLinkTextLength(root))) {
		return null;
	}

	return {
		title,
		content,
		url: sourceDocument.location?.href || sourceDocument.URL,
		lang: getLanguage(sourceDocument),
	};
}

export function findSemanticRoot(documentClone: Document): Element | null {
	const candidates = [
		...Array.from(documentClone.querySelectorAll('[itemprop="articleBody"]')).map((root) => ({ root, priority: 0 })),
		...Array.from(documentClone.querySelectorAll('article')).map((root) => ({ root, priority: 1 })),
		...Array.from(documentClone.querySelectorAll('main')).map((root) => ({ root, priority: 2 })),
	];

	return (
		candidates
			.map(({ root, priority }) => ({ root, priority, length: normaliseText(root.textContent || '').length }))
			.filter(({ root, length }) => {
				const blocks = getTextBlocks(root).filter((block) => block.length >= 40);
				return length >= 120 && blocks.length > 0;
			})
			.sort((left, right) => left.priority - right.priority || right.length - left.length)[0]?.root || null
	);
}

export function extractArticleFromDocument(sourceDocument: Document): Article | null {
	try {
		const documentClone = sourceDocument.cloneNode(true) as Document;
		if (!documentClone.body) {
			return null;
		}

		removeStructuralNoise(documentClone.body);

		const semanticRoot = findSemanticRoot(documentClone);
		if (semanticRoot) {
			const semanticArticle = articleFromRoot(semanticRoot, sourceDocument);
			if (semanticArticle) {
				return semanticArticle;
			}
		}

		const parsedArticle = new Readability(documentClone).parse();
		if (!parsedArticle) {
			return null;
		}

		const parsedRoot = documentClone.createElement('article');
		parsedRoot.innerHTML = parsedArticle.content || '';
		cleanContentTree(parsedRoot);
		const blocks = getTextBlocks(parsedRoot);
		const content = blocks.join('\n\n').trim() || normaliseText(parsedArticle.textContent || '');

		if (!hasQualityText(content, blocks.length, getLinkTextLength(parsedRoot))) {
			return null;
		}

		return {
			title: parsedArticle.title || sourceDocument.title || 'Untitled Article',
			content,
			url: sourceDocument.location?.href || sourceDocument.URL,
			lang: getLanguage(sourceDocument),
		};
	} catch (_error) {
		return null;
	}
}
