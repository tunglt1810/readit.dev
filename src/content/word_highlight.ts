import { STORAGE_KEYS } from '../shared/constants';
import { isWordHighlightEnabled, WORD_HIGHLIGHT_NAME } from '../shared/word_highlight';
import { findSemanticRoot, isWithinNoiseRegion } from './article_extractor';
import {
	activatePendingSelectionScope,
	capturePendingSelectionRange,
	clearActiveSelectionScope,
	getActiveSelectionRange,
} from './reading_anchor';

interface WalkerCursor {
	walker: TreeWalker;
	node: Text | null;
	offset: number;
	scopeRange: Range | null;
}

function createWalker(root: Node): TreeWalker {
	return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (isWithinNoiseRegion(node, root)) {
				return NodeFilter.FILTER_REJECT;
			}
			return node.textContent && node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		},
	});
}

// Scope the walk to the article's own root instead of document.body: isWithinNoiseRegion walks
// ancestors up to this root, and a real page's outer layout wrapper can false-positive match the
// noise pattern for reasons unrelated to the article (e.g. a site naming its main-content grid
// column "sidebar-1"), which would otherwise exclude the entire article from being found at all.
// Reuses the exact same root-finding heuristic as extraction, so "the text we read" and "the text
// we search for while reading" stay consistent.
function resolveWalkerRoot(startRange: Range | null): Node {
	const articleRoot = findSemanticRoot(document);
	if (!articleRoot) {
		return document.body;
	}
	if (startRange && !articleRoot.contains(startRange.startContainer)) {
		return document.body;
	}
	return articleRoot;
}

function createCursor(startRange: Range | null): WalkerCursor {
	const walker = createWalker(resolveWalkerRoot(startRange));
	let node = walker.nextNode() as Text | null;
	if (startRange) {
		// Skip every text node that lies entirely before the selection's start point, so the
		// cursor anchors at the real selection start — not just "the first matching word
		// anywhere in the selection's container", which could wrongly match an earlier,
		// unrelated occurrence of the same word earlier on the page.
		while (node) {
			try {
				if (startRange.comparePoint(node, node.textContent?.length ?? 0) >= 0) {
					break;
				}
			} catch {
				// Not comparable to the range (e.g. different root) — treat this node as the start.
				break;
			}
			node = walker.nextNode() as Text | null;
		}
	}
	const offset = startRange && node === startRange.startContainer ? startRange.startOffset : 0;
	return { walker, node, offset, scopeRange: startRange };
}

// A single failed word-search must never permanently exhaust the shared cursor's TreeWalker —
// otherwise one mismatch (Unicode form, a word split across inline markup, ...) would silently
// disable highlighting for the rest of the reading session. Bound how many text nodes a single
// search is allowed to consume before giving up, so later words can still be found.
const MAX_NODES_SCANNED_PER_WORD = 40;

// The spoken word (from the TTS pipeline) is always NFC-normalized (see vietnamese/tokenizer.ts
// and latin/speech_units.ts), but the live page's own HTML text is not guaranteed to be NFC — so
// compare against both normalization forms. We only ever transform the (short) search target,
// never the DOM's own text, so Range offsets into the DOM stay correct.
function wordVariants(word: string): string[] {
	const trimmed = word.trim().toLocaleLowerCase();
	if (!trimmed) {
		return [];
	}
	return [...new Set([trimmed.normalize('NFC'), trimmed.normalize('NFD')])];
}

// A plain indexOf substring search has no notion of word boundaries, so a short word (e.g. "an")
// can match inside an unrelated longer word that happens to contain the same letters (e.g.
// "c[an]ô"). Require the characters immediately before/after a candidate match to not themselves
// be letters/marks/numbers — the same "word" character class the Vietnamese tokenizer uses.
const WORD_CHAR_PATTERN = /[\p{L}\p{M}\p{N}_]/u;

function isWordBoundaryMatch(searchText: string, matchIndex: number, matchLength: number): boolean {
	const before = searchText[matchIndex - 1];
	const after = searchText[matchIndex + matchLength];
	return !(before && WORD_CHAR_PATTERN.test(before)) && !(after && WORD_CHAR_PATTERN.test(after));
}

function findWordBoundaryMatch(searchText: string, variant: string, fromIndex: number): number {
	// The boundary check only makes sense for an actual word: it exists to stop a short word from
	// matching inside a longer one. A variant with no word character at all (e.g. a lone "," or
	// "." — should never be sent as a highlight target, but defend against it anyway) is virtually
	// always adjacent to a letter at its own natural position, so requiring both sides to be
	// non-word characters would force it to skip ahead to some unrelated, distant occurrence
	// instead, eating every real word in between.
	if (!WORD_CHAR_PATTERN.test(variant)) {
		return searchText.indexOf(variant, fromIndex);
	}
	let matchIndex = searchText.indexOf(variant, fromIndex);
	while (matchIndex !== -1 && !isWordBoundaryMatch(searchText, matchIndex, variant.length)) {
		matchIndex = searchText.indexOf(variant, matchIndex + 1);
	}
	return matchIndex;
}

function selectionSearchBounds(range: Range, node: Text, cursorOffset: number): { start: number; end: number } | 'after' | null {
	const length = node.textContent?.length ?? 0;
	try {
		if (range.comparePoint(node, 0) > 0) {
			return 'after';
		}
		if (range.comparePoint(node, length) < 0) {
			return null;
		}
		const start = node === range.startContainer ? Math.max(cursorOffset, range.startOffset) : cursorOffset;
		const end = node === range.endContainer ? Math.min(length, range.endOffset) : length;
		return start < end ? { start, end } : 'after';
	} catch {
		return 'after';
	}
}

function findNextWordRange(cursor: WalkerCursor, word: string): Range | null {
	const variants = wordVariants(word);
	if (variants.length === 0 || !cursor.node) {
		return null;
	}
	// Remember where the search started so a miss can roll the cursor back to it below — otherwise
	// a word that isn't found anywhere forward would strand later, perfectly findable words behind
	// nodes this failed search already walked past.
	const startNode = cursor.node;
	const startOffset = cursor.offset;
	let nodesScanned = 0;
	while (cursor.node && nodesScanned < MAX_NODES_SCANNED_PER_WORD) {
		const searchText = (cursor.node.textContent ?? '').toLocaleLowerCase();
		let searchStart = cursor.offset;
		let searchEnd = searchText.length;
		if (cursor.scopeRange) {
			const bounds = selectionSearchBounds(cursor.scopeRange, cursor.node, cursor.offset);
			if (bounds === 'after') {
				cursor.walker.currentNode = startNode;
				cursor.node = startNode;
				cursor.offset = startOffset;
				return null;
			}
			if (bounds === null) {
				cursor.node = cursor.walker.nextNode() as Text | null;
				cursor.offset = 0;
				nodesScanned++;
				continue;
			}
			searchStart = bounds.start;
			searchEnd = bounds.end;
		}
		for (const variant of variants) {
			const matchIndex = findWordBoundaryMatch(searchText, variant, searchStart);
			if (matchIndex === -1 || matchIndex + variant.length > searchEnd) {
				continue;
			}
			const range = document.createRange();
			range.setStart(cursor.node, matchIndex);
			range.setEnd(cursor.node, matchIndex + variant.length);
			cursor.offset = matchIndex + variant.length;
			return range;
		}
		cursor.node = cursor.walker.nextNode() as Text | null;
		cursor.offset = 0;
		nodesScanned++;
	}
	cursor.walker.currentNode = startNode;
	cursor.node = startNode;
	cursor.offset = startOffset;
	return null;
}

let cursor: WalkerCursor | null = null;
let currentSessionId: string | null = null;
let enabled = true;
let styleInjected = false;

function ensureStyleInjected(): void {
	if (styleInjected) {
		return;
	}
	styleInjected = true;
	const style = document.createElement('style');
	style.id = 'readit-dev-word-highlight-style';
	style.textContent = `::highlight(${WORD_HIGHLIGHT_NAME}) { background-color: #ffe066; color: #1a1a1a; }`;
	document.head.append(style);
}

function clearHighlight(): void {
	CSS.highlights?.delete(WORD_HIGHLIGHT_NAME);
}

function applyWordHighlight(word: string, contentScope: 'article' | 'selection'): void {
	if (!enabled) {
		return;
	}
	if (!cursor) {
		const selectionRange = contentScope === 'selection' && currentSessionId ? getActiveSelectionRange(currentSessionId) : undefined;
		if (contentScope === 'selection' && !selectionRange) {
			clearHighlight();
			return;
		}
		cursor = createCursor(selectionRange ?? null);
	}
	const range = findNextWordRange(cursor, word);
	if (!range) {
		if (contentScope === 'selection') {
			clearHighlight();
		}
		return;
	}
	ensureStyleInjected();
	CSS.highlights?.set(WORD_HIGHLIGHT_NAME, new Highlight(range));
}

export function installWordHighlight(): void {
	if (window.top !== window || (window.location.protocol !== 'http:' && window.location.protocol !== 'https:')) {
		return;
	}
	if (typeof CSS === 'undefined' || !CSS.highlights) {
		return;
	}
	document.addEventListener(
		'contextmenu',
		() => {
			const selection = window.getSelection();
			capturePendingSelectionRange(
				selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0).cloneRange() : null,
			);
		},
		true,
	);

	chrome.runtime.onMessage.addListener((message: unknown) => {
		const msg = message as { action?: string; sessionId?: string; word?: string; contentScope?: string; selectionText?: string };
		if (
			msg.action === 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE' &&
			typeof msg.sessionId === 'string' &&
			typeof msg.selectionText === 'string'
		) {
			if (currentSessionId && currentSessionId !== msg.sessionId) {
				clearActiveSelectionScope(currentSessionId);
			}
			currentSessionId = msg.sessionId;
			cursor = null;
			activatePendingSelectionScope(msg.sessionId, msg.selectionText);
			clearHighlight();
		} else if (msg.action === 'WORD_HIGHLIGHT_UPDATE' && typeof msg.word === 'string') {
			if (msg.sessionId !== currentSessionId) {
				if (currentSessionId) {
					clearActiveSelectionScope(currentSessionId);
				}
				currentSessionId = msg.sessionId ?? null;
				cursor = null;
			}
			applyWordHighlight(msg.word, msg.contentScope === 'selection' ? 'selection' : 'article');
		} else if (msg.action === 'WORD_HIGHLIGHT_CLEAR' && typeof msg.sessionId === 'string') {
			clearActiveSelectionScope(msg.sessionId);
			if (msg.sessionId === currentSessionId) {
				currentSessionId = null;
				cursor = null;
				clearHighlight();
			}
		}
	});

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'local' || !(STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED in changes)) {
			return;
		}
		enabled = isWordHighlightEnabled(changes[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED].newValue);
		if (!enabled) {
			clearHighlight();
		}
	});

	void chrome.storage.local.get(STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED).then((stored) => {
		enabled = isWordHighlightEnabled(stored[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]);
	});
}
