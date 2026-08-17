import { STORAGE_KEYS } from '../shared/constants';
import type { ReadableSurfaceWord } from '../shared/readable_surface.ts';
import { performCenteredScroll, UserScrollPauseManager } from '../shared/scroll_helper.ts';
import {
	isWordHighlightEnabled,
	isWordHighlightInitMessage,
	isWordHighlightUpdateMessage,
	WORD_HIGHLIGHT_NAME,
} from '../shared/word_highlight';
import { findSemanticRoot, isWithinNoiseRegion } from './article_extractor';
import {
	activatePendingSelectionScope,
	capturePendingSelectionRange,
	clearActiveSelectionScope,
	getActiveSelectionRange,
} from './reading_anchor';

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
	const h1 = document.querySelector('h1');
	if (h1 && !articleRoot.contains(h1)) {
		let common: Node | null = articleRoot.parentElement;
		while (common && common !== document.body && !common.contains(h1)) {
			common = common.parentElement;
		}
		return common || document.body;
	}
	return articleRoot;
}

// A single failed word-search must not consume the map-building cursor — otherwise one mismatch
// (Unicode form, a word split across inline markup, ...) would silently disable highlighting for
// the rest of the reading session. Bound the work for each map entry, then restore the cursor when
// an entry cannot be found so later words can still be mapped.
const MAX_NODES_SCANNED_PER_WORD = 15;

// Restoring the cursor is not enough once it has been dragged *past* the body text, because the
// walk only ever moves forward: every remaining word then sits behind it and can never be reached.
// That happens whenever the spoken text opens with words the page renders somewhere else — most
// visibly a title falling back to `document.title` on a site with no in-article heading (x.com),
// where it left 7% of words mapped, and on English Wikipedia, where it left 13%. After this many
// consecutive misses, rewind to the root and search the whole walk once for the current word.
const REANCHOR_AFTER_CONSECUTIVE_MISSES = 3;

// Each re-anchor rescans every text node under the root, so a word list that matches nothing at all
// would otherwise become a quadratic sweep — measured at 47s on a large article, against ~1s for
// the same list without re-anchoring. A bounded allowance keeps that worst case near the cost of
// never re-anchoring, while being far more than a page whose text actually matches ever needs.
const MAX_REANCHORS_PER_PRECOMPUTE = 20;

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

type MappedWordRange = { range: Range; variants: readonly string[] };

let wordRanges: Map<number, MappedWordRange> | null = null;
let sessionWords: readonly ReadableSurfaceWord[] | null = null;
let sessionScopeRange: Range | null = null;
let wordRangesStale = false;
let currentWordIndex = -1;
let currentSessionId: string | null = null;
let enabled = true;
let visualUpdatesAllowed = document.visibilityState === 'visible';
let styleInjected = false;
const scrollPauseManager = new UserScrollPauseManager(3000);

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

function disposeCurrentHighlightSession(): void {
	scrollPauseManager.setPlaybackState(false);
	if (currentSessionId) {
		clearActiveSelectionScope(currentSessionId);
	}
	currentSessionId = null;
	wordRanges = null;
	sessionWords = null;
	sessionScopeRange = null;
	wordRangesStale = false;
	currentWordIndex = -1;
	clearHighlight();
}

function isMappedRangeUsable(mapped: MappedWordRange): boolean {
	const { range } = mapped;
	if (!range.startContainer.isConnected || !range.endContainer.isConnected || range.collapsed) {
		return false;
	}
	return wordVariants(range.toString()).some((variant) => mapped.variants.includes(variant));
}

type WordSearchHit = { range: Range; node: Text; nextOffset: number };

// Advances `walker` looking for `variants`, starting at `startNode`/`startOffset` and giving up
// after `maxNodes` text nodes. Leaves the walker wherever it stopped; the caller owns the cursor.
function searchForWord(
	walker: TreeWalker,
	startNode: Text | null,
	startOffset: number,
	variants: readonly string[],
	maxNodes: number,
	scopeRange: Range | null,
): WordSearchHit | null {
	let node = startNode;
	let offset = startOffset;
	let nodesScanned = 0;

	while (node && variants.length > 0 && nodesScanned < maxNodes) {
		const searchText = (node.textContent ?? '').toLocaleLowerCase();
		let searchStart = offset;
		let searchEnd = searchText.length;
		if (scopeRange) {
			const bounds = selectionSearchBounds(scopeRange, node, offset);
			if (bounds === 'after') {
				return null;
			}
			if (bounds === null) {
				node = walker.nextNode() as Text | null;
				offset = 0;
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
			range.setStart(node, matchIndex);
			range.setEnd(node, matchIndex + variant.length);
			return { range, node, nextOffset: matchIndex + variant.length };
		}
		node = walker.nextNode() as Text | null;
		offset = 0;
		nodesScanned++;
	}

	return null;
}

function precomputeWordRanges(words: readonly ReadableSurfaceWord[], scopeRange: Range | null): Map<number, MappedWordRange> {
	const ranges = new Map<number, MappedWordRange>();
	const walkerRoot = resolveWalkerRoot(scopeRange);
	const walker = createWalker(walkerRoot);
	let node = walker.nextNode() as Text | null;
	let offset = 0;

	if (scopeRange) {
		while (node) {
			try {
				if (scopeRange.comparePoint(node, node.textContent?.length ?? 0) >= 0) {
					break;
				}
			} catch {
				break;
			}
			node = walker.nextNode() as Text | null;
		}
		if (node === scopeRange.startContainer) {
			offset = scopeRange.startOffset;
		}
	}

	let consecutiveMisses = 0;
	let reanchorsSpent = 0;

	for (const { text, globalIndex } of words) {
		const startNode = node;
		const startOffset = offset;
		const variants = wordVariants(text);
		let hit = searchForWord(walker, node, offset, variants, MAX_NODES_SCANNED_PER_WORD, scopeRange);

		if (!hit) {
			consecutiveMisses++;
			if (consecutiveMisses >= REANCHOR_AFTER_CONSECUTIVE_MISSES && reanchorsSpent < MAX_REANCHORS_PER_PRECOMPUTE) {
				reanchorsSpent++;
				consecutiveMisses = 0;
				walker.currentNode = walkerRoot;
				hit = searchForWord(walker, walker.nextNode() as Text | null, 0, variants, Number.POSITIVE_INFINITY, scopeRange);
			}
		}

		if (hit) {
			ranges.set(globalIndex, { range: hit.range, variants });
			walker.currentNode = hit.node;
			node = hit.node;
			offset = hit.nextOffset;
			consecutiveMisses = 0;
		} else if (startNode) {
			walker.currentNode = startNode;
			node = startNode;
			offset = startOffset;
		}
	}

	return ranges;
}

function scrollIntoViewIfNeeded(range: Range): void {
	const rect = range.getBoundingClientRect();
	const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	performCenteredScroll(rect, window.innerHeight, scrollPauseManager, (opts) => window.scrollBy(opts), prefersReducedMotion);
}

// A range dies when the page re-renders the text it points at — a virtualized timeline (x.com)
// does this constantly, and highlighting scrolls the page itself, so it happens mid-read. Remapping
// the dead word right away would paint some other copy of it, which is exactly what the reader is
// not looking at, so that word still clears. Instead the map is marked stale and rebuilt for the
// next word, which is the one the reader is about to hear.
function rebuildWordRangesIfStale(): void {
	if (!wordRangesStale || !sessionWords) {
		return;
	}
	wordRangesStale = false;
	wordRanges = precomputeWordRanges(sessionWords, sessionScopeRange);
}

function applyHighlightForIndex(wordIndex: number): void {
	rebuildWordRangesIfStale();
	const mapped = wordRanges?.get(wordIndex);
	if (!mapped || !isMappedRangeUsable(mapped)) {
		if (mapped) {
			wordRangesStale = true;
		}
		wordRanges?.delete(wordIndex);
		clearHighlight();
		return;
	}
	ensureStyleInjected();
	CSS.highlights?.set(WORD_HIGHLIGHT_NAME, new Highlight(mapped.range));
	scrollIntoViewIfNeeded(mapped.range);
}

function handleHighlightUpdate(wordIndex: number): void {
	currentWordIndex = wordIndex;
	if (enabled && visualUpdatesAllowed && wordRanges) {
		applyHighlightForIndex(wordIndex);
	}
}

function updateVisualUpdatePermission(): void {
	visualUpdatesAllowed = document.visibilityState === 'visible';
	if (visualUpdatesAllowed && enabled && currentWordIndex >= 0) {
		applyHighlightForIndex(currentWordIndex);
	} else if (!visualUpdatesAllowed) {
		clearHighlight();
	}
}

export function installWordHighlight(): void {
	if (window.top !== window || (window.location.protocol !== 'http:' && window.location.protocol !== 'https:')) {
		return;
	}
	if (typeof CSS === 'undefined' || !CSS.highlights) {
		return;
	}
	const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ']);
	const handleUserScroll = () => scrollPauseManager.onUserInteraction();
	const handleKeyScroll = (e: KeyboardEvent) => {
		if (SCROLL_KEYS.has(e.key)) {
			scrollPauseManager.onUserInteraction();
		}
	};
	window.addEventListener('wheel', handleUserScroll, { passive: true });
	window.addEventListener('touchmove', handleUserScroll, { passive: true });
	window.addEventListener('keydown', handleKeyScroll, { passive: true });
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

	chrome.runtime.onMessage.addListener(
		(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
			const msg = message as { action?: string; sessionId?: string; selectionText?: string };
			if (
				msg.action === 'WORD_HIGHLIGHT_SET_SELECTION_SCOPE' &&
				typeof msg.sessionId === 'string' &&
				typeof msg.selectionText === 'string'
			) {
				if (currentSessionId && currentSessionId !== msg.sessionId) {
					disposeCurrentHighlightSession();
				}
				currentSessionId = msg.sessionId;
				wordRanges = null;
				sessionWords = null;
				sessionScopeRange = null;
				wordRangesStale = false;
				currentWordIndex = -1;
				activatePendingSelectionScope(msg.sessionId, msg.selectionText);
				clearHighlight();
			} else if (isWordHighlightInitMessage(message)) {
				if (currentSessionId !== message.sessionId) {
					disposeCurrentHighlightSession();
					currentSessionId = message.sessionId;
				} else {
					wordRanges = null;
					currentWordIndex = -1;
					clearHighlight();
				}
				scrollPauseManager.setPlaybackState(true);
				const selectionRange = message.contentScope === 'selection' ? getActiveSelectionRange(message.sessionId) : null;
				const failsClosed = message.contentScope === 'selection' && !selectionRange;
				// Kept so a map invalidated by the page re-rendering its nodes can be rebuilt later. A
				// selection session with no captured range fails closed, and must keep failing closed.
				sessionWords = failsClosed ? null : message.words;
				sessionScopeRange = selectionRange ?? null;
				wordRangesStale = false;
				wordRanges = failsClosed ? new Map() : precomputeWordRanges(message.words, selectionRange ?? null);
				sendResponse({ success: true });
			} else if (isWordHighlightUpdateMessage(message)) {
				if (message.sessionId !== currentSessionId || !wordRanges) {
					return;
				}
				handleHighlightUpdate(message.wordIndex);
			} else if (msg.action === 'WORD_HIGHLIGHT_CLEAR' && typeof msg.sessionId === 'string') {
				clearActiveSelectionScope(msg.sessionId);
				if (msg.sessionId === currentSessionId) {
					disposeCurrentHighlightSession();
				}
			}
		},
	);

	document.addEventListener('visibilitychange', updateVisualUpdatePermission);

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'local' || !(STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED in changes)) {
			return;
		}
		enabled = isWordHighlightEnabled(changes[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED].newValue);
		if (!enabled) {
			clearHighlight();
		} else if (visualUpdatesAllowed && currentWordIndex >= 0) {
			applyHighlightForIndex(currentWordIndex);
		}
	});

	void chrome.storage.local.get(STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED).then((stored) => {
		enabled = isWordHighlightEnabled(stored[STORAGE_KEYS.WORD_HIGHLIGHT_ENABLED]);
		if (enabled && visualUpdatesAllowed && currentWordIndex >= 0) {
			applyHighlightForIndex(currentWordIndex);
		}
	});
}
