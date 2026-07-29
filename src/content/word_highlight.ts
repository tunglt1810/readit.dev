import { STORAGE_KEYS } from '../shared/constants';
import type { ReadableSurfaceWord } from '../shared/readable_surface.ts';
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
	return articleRoot;
}

// A single failed word-search must not consume the map-building cursor — otherwise one mismatch
// (Unicode form, a word split across inline markup, ...) would silently disable highlighting for
// the rest of the reading session. Bound the work for each map entry, then restore the cursor when
// an entry cannot be found so later words can still be mapped.
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

type MappedWordRange = { range: Range; variants: readonly string[] };

let wordRanges: Map<number, MappedWordRange> | null = null;
let currentWordIndex = -1;
let currentSessionId: string | null = null;
let enabled = true;
let visualUpdatesAllowed = document.visibilityState === 'visible';
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

function disposeCurrentHighlightSession(): void {
	if (currentSessionId) {
		clearActiveSelectionScope(currentSessionId);
	}
	currentSessionId = null;
	wordRanges = null;
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

function precomputeWordRanges(words: readonly ReadableSurfaceWord[], scopeRange: Range | null): Map<number, MappedWordRange> {
	const ranges = new Map<number, MappedWordRange>();
	const walker = createWalker(resolveWalkerRoot(scopeRange));
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

	for (const { text, globalIndex } of words) {
		const startNode = node;
		const startOffset = offset;
		const variants = wordVariants(text);
		let found = false;
		let nodesScanned = 0;
		while (node && variants.length > 0 && nodesScanned < MAX_NODES_SCANNED_PER_WORD && !found) {
			const searchText = (node.textContent ?? '').toLocaleLowerCase();
			let searchStart = offset;
			let searchEnd = searchText.length;
			if (scopeRange) {
				const bounds = selectionSearchBounds(scopeRange, node, offset);
				if (bounds === 'after') {
					node = null;
					break;
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
				ranges.set(globalIndex, { range, variants });
				offset = matchIndex + variant.length;
				found = true;
				break;
			}
			if (!found) {
				node = walker.nextNode() as Text | null;
				offset = 0;
				nodesScanned++;
			}
		}
		if (!found && startNode) {
			walker.currentNode = startNode;
			node = startNode;
			offset = startOffset;
		}
	}

	return ranges;
}

function scrollIntoViewIfNeeded(range: Range): void {
	const rect = range.getBoundingClientRect();
	if (rect.top < 0) {
		// A tall paragraph can still intersect the viewport while its current word is above it.
		// scrollIntoView({ block: 'nearest' }) then leaves the paragraph in place, so position the
		// range itself below the top edge instead.
		window.scrollBy({ top: rect.top - window.innerHeight * 0.2, behavior: 'auto' });
		return;
	}
	if (rect.bottom > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
		range.startContainer.parentElement?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
	}
}

function applyHighlightForIndex(wordIndex: number): void {
	const mapped = wordRanges?.get(wordIndex);
	if (!mapped || !isMappedRangeUsable(mapped)) {
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
				const selectionRange = message.contentScope === 'selection' ? getActiveSelectionRange(message.sessionId) : null;
				wordRanges =
					message.contentScope === 'selection' && !selectionRange
						? new Map()
						: precomputeWordRanges(message.words, selectionRange ?? null);
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
