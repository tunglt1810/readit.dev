import { Readability } from '@mozilla/readability';

import { Article } from '../shared/types';

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
	/(?:advert|banner|comment|related|recommend|lienquan|xemnhieu|social|share|sidebar|navigation|menu|toolbar|control|player|flip)/i;
const ARTICLE_END_PATTERN = /article[-_]?end/i;
const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, blockquote, pre, li, figcaption';

function getElementIdentity(element: Element): string {
	const className = typeof element.className === 'string' ? element.className : '';
	return `${element.id} ${className} ${element.getAttribute('role') || ''}`;
}

function isNoiseElement(element: Element): boolean {
	return NOISE_IDENTITY_PATTERN.test(getElementIdentity(element));
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

function cleanContentTree(root: Element): void {
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

function getTextBlocks(root: Element): string[] {
	const seen = new Set<string>();
	const blocks: string[] = [];

	for (const element of Array.from(root.querySelectorAll(BLOCK_SELECTOR))) {
		const text = normaliseText(element.textContent || '');
		if (text && !seen.has(text)) {
			seen.add(text);
			blocks.push(text);
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

function getArticleTitle(root: Element, fallback: string): string {
	return normaliseText(root.querySelector('h1')?.textContent || '') || fallback || 'Untitled Article';
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

	const title = getArticleTitle(root, fallbackTitle || sourceDocument.title);
	const blocks = getTextBlocks(root);
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

function findSemanticRoot(documentClone: Document): Element | null {
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
