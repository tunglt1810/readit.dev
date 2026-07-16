import { STORAGE_KEYS, THEME_TRANSLATIONS } from '../shared/constants';
import {
	isSelectionButtonEnabled,
	SELECTION_BUTTON_HOST_ID,
	SELECTION_BUTTON_ICON_SIZE,
	SELECTION_BUTTON_SIZE,
	type StartSelectedTextMessage,
} from '../shared/selection_button';
import { computeSelectionButtonPosition } from './selection_button_position';

type SelectionSource = 'pointer' | 'keyboard';

interface SelectionSnapshot {
	text: string;
	pageLanguage: string;
	anchor: { left: number; top: number; right: number; bottom: number };
}

function areSelectionSnapshotsEquivalent(left: SelectionSnapshot | null, right: SelectionSnapshot | null): boolean {
	return (
		left !== null &&
		right !== null &&
		left.text === right.text &&
		left.pageLanguage === right.pageLanguage &&
		left.anchor.left === right.anchor.left &&
		left.anchor.top === right.anchor.top &&
		left.anchor.right === right.anchor.right &&
		left.anchor.bottom === right.anchor.bottom
	);
}

function elementForNode(node: Node | null): Element | null {
	return node instanceof Element ? node : (node?.parentElement ?? null);
}

function isEditableNode(node: Node | null): boolean {
	const element = elementForNode(node);
	if (!element) {
		return false;
	}
	if (element.closest('input, textarea')) {
		return true;
	}
	const editable = element.closest('[contenteditable]');
	return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}

function readSelectionSnapshot(): SelectionSnapshot | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		return null;
	}
	const text = selection.toString().trim();
	const range = selection.getRangeAt(0);
	if (
		!text ||
		isEditableNode(selection.anchorNode) ||
		isEditableNode(selection.focusNode) ||
		isEditableNode(range.commonAncestorContainer)
	) {
		return null;
	}
	const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
	const rect = rects.at(-1);
	if (!rect) {
		return null;
	}
	return {
		text,
		pageLanguage: document.documentElement.lang,
		anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
	};
}

export async function installSelectionButton(): Promise<void> {
	if (window.top !== window || (window.location.protocol !== 'http:' && window.location.protocol !== 'https:')) {
		return;
	}

	const stored = await chrome.storage.local.get(STORAGE_KEYS.SELECTION_BUTTON_ENABLED);
	let enabled = isSelectionButtonEnabled(stored[STORAGE_KEYS.SELECTION_BUTTON_ENABLED]);
	let host: HTMLDivElement | null = null;
	let snapshot: SelectionSnapshot | null = null;
	let previousFocus: HTMLElement | null = null;
	let movingKeyboardFocus = false;
	let activated = false;
	let dismissedPointerId: number | null = null;

	const removeButton = (restoreFocus = false) => {
		const focusTarget = previousFocus;
		host?.remove();
		host = null;
		snapshot = null;
		previousFocus = null;
		movingKeyboardFocus = false;
		activated = false;
		if (restoreFocus && focusTarget?.isConnected) {
			focusTarget.focus();
		}
	};

	const showButton = (source: SelectionSource) => {
		if (!enabled) {
			removeButton();
			return;
		}
		const nextSnapshot = readSelectionSnapshot();
		if (!nextSnapshot) {
			removeButton();
			return;
		}

		const focusTarget = source === 'keyboard' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
		removeButton();
		snapshot = nextSnapshot;
		previousFocus = focusTarget;
		activated = false;

		host = document.createElement('div');
		host.id = SELECTION_BUTTON_HOST_ID;
		host.style.all = 'initial';
		host.style.position = 'fixed';
		host.style.zIndex = '2147483647';
		const position = computeSelectionButtonPosition(
			nextSnapshot.anchor,
			{ width: window.innerWidth, height: window.innerHeight },
			{ width: SELECTION_BUTTON_SIZE, height: SELECTION_BUTTON_SIZE },
		);
		host.style.left = `${position.left}px`;
		host.style.top = `${position.top}px`;

		const shadow = host.attachShadow({ mode: 'open' });
		const style = document.createElement('style');
		style.textContent = `
			button { all: initial; box-sizing: border-box; width: ${SELECTION_BUTTON_SIZE}px; height: ${SELECTION_BUTTON_SIZE}px; display: flex;
				align-items: center; justify-content: center; border: 1px solid rgba(0,0,0,.22); border-radius: 9px; background: #fff;
				box-shadow: 0 4px 12px rgba(0,0,0,.38); cursor: pointer; }
			button:hover { transform: translateY(-1px); }
			button:focus-visible { outline: 2px solid #099fb5; outline-offset: 3px; }
			button:disabled { opacity: .65; cursor: default; }
			img { display: block; width: ${SELECTION_BUTTON_ICON_SIZE}px; height: ${SELECTION_BUTTON_ICON_SIZE}px; }
		`;
		const button = document.createElement('button');
		button.type = 'button';
		const uiLang = chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en';
		const label = THEME_TRANSLATIONS[uiLang].readSelectedText;
		button.setAttribute('aria-label', label);
		button.title = label;
		const image = document.createElement('img');
		image.src = chrome.runtime.getURL('assets/icon32.png');
		image.alt = '';
		button.append(image);
		button.addEventListener('pointerdown', (event) => event.preventDefault());
		button.addEventListener('click', () => {
			if (activated || !snapshot) {
				return;
			}
			activated = true;
			button.disabled = true;
			const message: StartSelectedTextMessage = {
				action: 'START_SELECTED_TEXT',
				selectionText: snapshot.text,
				pageLanguage: snapshot.pageLanguage,
			};
			removeButton();
			void chrome.runtime.sendMessage(message).catch(() => undefined);
		});
		button.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				removeButton(true);
			}
		});
		shadow.append(style, button);
		document.documentElement.append(host);

		if (source === 'keyboard') {
			movingKeyboardFocus = true;
			button.focus();
			queueMicrotask(() => {
				movingKeyboardFocus = false;
			});
		}
	};

	document.addEventListener('selectionchange', (event) => {
		const eventTarget = event.target instanceof Node ? event.target : null;
		if (isEditableNode(eventTarget) || isEditableNode(document.activeElement)) {
			removeButton();
			return;
		}
		if (movingKeyboardFocus || areSelectionSnapshotsEquivalent(snapshot, readSelectionSnapshot())) {
			return;
		}
		removeButton();
	});
	document.addEventListener('pointerup', (event) => {
		if (dismissedPointerId === event.pointerId) {
			dismissedPointerId = null;
			return;
		}
		if (host && event.composedPath().includes(host)) {
			return;
		}
		queueMicrotask(() => showButton('pointer'));
	});
	document.addEventListener('pointercancel', (event) => {
		if (dismissedPointerId === event.pointerId) {
			dismissedPointerId = null;
		}
	});
	document.addEventListener('keyup', (event) => {
		if (event.key === 'Escape') {
			removeButton(true);
			return;
		}
		if (host?.shadowRoot?.activeElement instanceof HTMLButtonElement) {
			return;
		}
		const isSelectAll = event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey);
		if (event.key === 'Shift' || event.shiftKey || isSelectAll) {
			if (isEditableNode(document.activeElement)) {
				removeButton();
				return;
			}
			queueMicrotask(() => showButton('keyboard'));
		}
	});
	document.addEventListener(
		'pointerdown',
		(event) => {
			if (host && !event.composedPath().includes(host)) {
				dismissedPointerId = event.pointerId;
				removeButton();
			}
		},
		true,
	);
	window.addEventListener('scroll', () => removeButton(), true);
	window.addEventListener('resize', () => removeButton());

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'local' || !(STORAGE_KEYS.SELECTION_BUTTON_ENABLED in changes)) {
			return;
		}
		enabled = isSelectionButtonEnabled(changes[STORAGE_KEYS.SELECTION_BUTTON_ENABLED].newValue);
		if (!enabled) {
			removeButton();
		}
	});
}
