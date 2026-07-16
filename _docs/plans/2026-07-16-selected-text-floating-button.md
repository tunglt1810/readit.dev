# Selected-Text Floating Read Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended, only after explicit delegation approval) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a logo-only button beside supported text selections, open the Chrome action popup immediately on activation, and replace the active playback session with the new selected text through the existing coordinator.

**Architecture:** A focused content module owns selection eligibility, geometry, Shadow DOM UI, and the enablement setting. The content script sends one typed `START_SELECTED_TEXT` intent; the background validates `MessageSender`, requests the action popup outside the state transition, and routes the selection into the existing `startArticlePlayback()` replacement path. Popup rendering and offscreen TTS keep their current ownership boundaries.

**Tech Stack:** TypeScript 6, React 19, Chrome Manifest V3 APIs, Shadow DOM, Node test runner, Playwright 1.61, Rsbuild 2.1, Biome.

## Global Constraints

- Target Chrome 127+ and declare `"minimum_chrome_version": "127"`.
- Do not add a playback queue, pending-selection storage, second coordinator, new runtime dependency, permission, or host permission.
- A valid selected-text request stops and invalidates the active session before publishing the new loading session, exactly like `START_CURRENT_PAGE`.
- Keep the existing short-lived background `stateQueue`; it serializes state mutations and is not an audio queue.
- Keep the selected-text context-menu entry point and route both entry points through `createSelectedTextArticle()` and `startArticlePlayback()`.
- Show the button only in the top-level HTTP/HTTPS document and exclude `input`, `textarea`, and editable content.
- Use the existing `public/assets/icon32.png` asset at 26 by 26 pixels inside a 36 by 36 pixel button.
- Store only the boolean `STORAGE_KEYS.SELECTION_BUTTON_ENABLED` in `chrome.storage.local`; never persist selected text in local or session storage.
- The compact popup setting is one line with no section title or helper copy and appears immediately before the footer in every theme.
- Preserve the Free permission boundary: `activeTab`, `scripting`, `storage`, `offscreen`, `contextMenus`, and only `https://huggingface.co/*` as host permission.
- Preserve unrelated worktree content, especially `context_improvement.md`; stage only files named by each task.
- Store temporary profiles, screenshots, and scratch output under repository `.tmp/`; never use the operating-system temp directory.

---

## File Structure

- Create `src/shared/selection_button.ts`: typed runtime intent, stable host ID, button dimensions, and default-on setting semantics.
- Modify `src/shared/constants.ts`: selection-button storage key plus EN/VI setting and accessible labels.
- Modify `public/manifest.json`: Chrome 127 floor and narrowly scoped logo web-accessible resource.
- Modify `scripts/validate-free-manifest.mjs`: validate the version floor, logo exposure, permissions, and host permissions.
- Modify `tests/unit/manifest_validation.test.ts`: accepted manifest plus rejection cases for version and resource drift.
- Create `tests/unit/selection_button_contract.test.ts`: default-on setting contract.
- Create `src/content/selection_button_position.ts`: pure bottom-right, clamp, and flip calculations.
- Create `tests/unit/selection_button_position.test.ts`: deterministic geometry cases.
- Create `src/content/selection_button.ts`: selection lifecycle, editable exclusion, Shadow DOM button, focus handling, and runtime intent.
- Modify `src/content/content_script.ts`: install the affordance once alongside article extraction.
- Create `tests/e2e/selection-button.spec.ts`: real page selection, visibility, accessibility, hide behavior, popup opening, replacement, and live setting coverage.
- Create `src/background/selected_text_request.ts`: pure `MessageSender`-derived request validation and selected-text `Article` preparation.
- Create `src/background/action_popup.ts`: isolated popup request that absorbs API rejection.
- Create `tests/unit/selected_text_request.test.ts`: top-frame, protocol, metadata, and invalid-selection cases.
- Create `tests/unit/action_popup.test.ts`: popup options and rejection isolation.
- Modify `src/background/background.ts`: handle `START_SELECTED_TEXT`, request popup immediately, and reuse `startArticlePlayback()`.
- Modify `src/popup/App.tsx`: default-on state, persisted checkbox, and one-line setting row.
- Modify `src/popup/popup.css`: compact native checkbox styling across themes.
- Modify `tests/e2e/themes.spec.ts`: setting persistence, placement, theme stability, and English copy.
- Modify `_docs/specs/2026-07-12-free-mvp-design.md`: make the floating button and default-on setting part of the canonical Free behavior.
- Modify `_docs/RELEASING.md`: document the Chrome 127 and logo-resource manifest assertions.
- Modify `_docs/specs/2026-07-16-selected-text-floating-button-design.md`: mark implemented only after verification succeeds.

---

### Task 1: Shared contract and manifest boundary

**Files:**
- Create: `src/shared/selection_button.ts`
- Modify: `src/shared/constants.ts`
- Modify: `public/manifest.json`
- Modify: `scripts/validate-free-manifest.mjs`
- Create: `tests/unit/selection_button_contract.test.ts`
- Modify: `tests/unit/manifest_validation.test.ts`

**Interfaces:**
- Produces: `StartSelectedTextMessage` with `action`, `selectionText`, and `pageLanguage`.
- Produces: `isSelectionButtonEnabled(value: unknown): boolean` where only literal `false` disables the feature.
- Produces: `SELECTION_BUTTON_HOST_ID`, `SELECTION_BUTTON_SIZE`, and `SELECTION_BUTTON_ICON_SIZE`.
- Produces: `STORAGE_KEYS.SELECTION_BUTTON_ENABLED` with value `readit_selection_button_enabled`.
- Produces translation keys `showSelectionButton` and `readSelectedText` in both locales.
- Preserves the exact existing permission and host-permission arrays.

- [ ] **Step 1: Write failing contract and manifest tests**

Create `tests/unit/selection_button_contract.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SELECTION_BUTTON_HOST_ID,
	SELECTION_BUTTON_ICON_SIZE,
	SELECTION_BUTTON_SIZE,
	isSelectionButtonEnabled,
} from '../../src/shared/selection_button.ts';

test('selection button defaults on and only literal false disables it', () => {
	assert.equal(isSelectionButtonEnabled(undefined), true);
	assert.equal(isSelectionButtonEnabled(true), true);
	assert.equal(isSelectionButtonEnabled(false), false);
	assert.equal(isSelectionButtonEnabled('false'), true);
});

test('selection button dimensions and host id stay stable', () => {
	assert.equal(SELECTION_BUTTON_HOST_ID, 'readit-dev-selection-button-host');
	assert.equal(SELECTION_BUTTON_SIZE, 36);
	assert.equal(SELECTION_BUTTON_ICON_SIZE, 26);
});
```

Replace `validManifest` in `tests/unit/manifest_validation.test.ts` and add two tests:

```ts
const validManifest = {
	manifest_version: 3,
	minimum_chrome_version: '127',
	permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'contextMenus'],
	host_permissions: ['https://huggingface.co/*'],
	web_accessible_resources: [
		{
			resources: ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs'],
			matches: ['<all_urls>'],
		},
		{
			resources: ['assets/icon32.png'],
			matches: ['http://*/*', 'https://*/*'],
		},
	],
};

test('rejects a Chrome version below the supported popup API floor', () => {
	assert.throws(() => validateFreeManifest({ ...validManifest, minimum_chrome_version: '126' }), /127/);
});

test('rejects missing or broadly exposed selection button artwork', () => {
	assert.throws(
		() =>
			validateFreeManifest({
				...validManifest,
				web_accessible_resources: validManifest.web_accessible_resources.slice(0, 1),
			}),
		/assets\/icon32\.png/,
	);
	assert.throws(
		() =>
			validateFreeManifest({
				...validManifest,
				web_accessible_resources: [
					validManifest.web_accessible_resources[0],
					{ resources: ['assets/icon32.png'], matches: ['<all_urls>'] },
				],
			}),
		/http:\/\/\*\/\*/,
	);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/selection_button_contract.test.ts tests/unit/manifest_validation.test.ts
```

Expected: FAIL because `src/shared/selection_button.ts` is missing and the current validator does not enforce Chrome 127 or the logo resource.

- [ ] **Step 3: Add the shared selection-button contract**

Create `src/shared/selection_button.ts`:

```ts
export const SELECTION_BUTTON_HOST_ID = 'readit-dev-selection-button-host';
export const SELECTION_BUTTON_SIZE = 36;
export const SELECTION_BUTTON_ICON_SIZE = 26;

export interface StartSelectedTextMessage {
	action: 'START_SELECTED_TEXT';
	selectionText: string;
	pageLanguage: string;
}

export function isSelectionButtonEnabled(value: unknown): boolean {
	return value !== false;
}
```

Add to `STORAGE_KEYS` in `src/shared/constants.ts`:

```ts
SELECTION_BUTTON_ENABLED: 'readit_selection_button_enabled',
```

Add these exact entries to both objects in `THEME_TRANSLATIONS`:

```ts
// vi
showSelectionButton: 'Hiện nút đọc cạnh văn bản đã chọn',
readSelectedText: 'Đọc văn bản đã chọn',

// en
showSelectionButton: 'Show read button for selected text',
readSelectedText: 'Read selected text',
```

- [ ] **Step 4: Add the Chrome floor and logo resource to the source manifest**

Add after `manifest_version` in `public/manifest.json`:

```json
"minimum_chrome_version": "127",
```

Add a second `web_accessible_resources` entry without broadening the existing ONNX entry:

```json
{
	"resources": ["assets/icon32.png"],
	"matches": ["http://*/*", "https://*/*"]
}
```

- [ ] **Step 5: Extend exact manifest validation**

In `scripts/validate-free-manifest.mjs`, add the expected resources and canonical comparison:

```js
const REQUIRED_MINIMUM_CHROME_VERSION = '127';
const REQUIRED_WEB_ACCESSIBLE_RESOURCES = [
	{
		resources: ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'],
		matches: ['<all_urls>'],
	},
	{
		resources: ['assets/icon32.png'],
		matches: ['http://*/*', 'https://*/*'],
	},
];

function canonicalizeResourceEntries(value) {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry) => ({
			resources: Array.isArray(entry?.resources) ? entry.resources.map(String).sort() : [],
			matches: Array.isArray(entry?.matches) ? entry.matches.map(String).sort() : [],
		}))
		.map((entry) => JSON.stringify(entry))
		.sort();
}

function compareResourceEntries(actual, expected) {
	compareExact(canonicalizeResourceEntries(actual), canonicalizeResourceEntries(expected), 'web_accessible_resources');
}
```

Then extend `validateFreeManifest()` after the MV3 assertion:

```js
if (manifest.minimum_chrome_version !== REQUIRED_MINIMUM_CHROME_VERSION) {
	throw new Error(`Expected minimum_chrome_version 127, got ${String(manifest.minimum_chrome_version)}`);
}
compareResourceEntries(manifest.web_accessible_resources, REQUIRED_WEB_ACCESSIBLE_RESOURCES);
```

- [ ] **Step 6: Run focused tests and manifest validation GREEN**

Run:

```bash
node --experimental-strip-types --test tests/unit/selection_button_contract.test.ts tests/unit/manifest_validation.test.ts
CI=true pnpm build
pnpm validate:manifest
```

Expected: all focused tests PASS, production build exits 0, and manifest validation exits 0 without a validation error.

- [ ] **Step 7: Commit the shared boundary**

```bash
git add src/shared/selection_button.ts src/shared/constants.ts public/manifest.json scripts/validate-free-manifest.mjs tests/unit/selection_button_contract.test.ts tests/unit/manifest_validation.test.ts
git commit -m "Define selected-text button contract"
```

---

### Task 2: Pure selection-button positioning

**Files:**
- Create: `src/content/selection_button_position.ts`
- Create: `tests/unit/selection_button_position.test.ts`

**Interfaces:**
- Produces: `computeSelectionButtonPosition(anchor, viewport, button, gap?, margin?): ButtonPosition`.
- Consumes: `SELECTION_BUTTON_SIZE` from Task 1 only at the DOM integration boundary; the pure helper accepts explicit dimensions.

- [ ] **Step 1: Write failing geometry tests**

Create `tests/unit/selection_button_position.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSelectionButtonPosition } from '../../src/content/selection_button_position.ts';

test('places the button below and right-aligned with the final selection rect', () => {
	assert.deepEqual(
		computeSelectionButtonPosition(
			{ left: 120, top: 80, right: 220, bottom: 120 },
			{ width: 800, height: 600 },
			{ width: 36, height: 36 },
		),
		{ left: 184, top: 126 },
	);
});

test('flips above when the preferred bottom placement would overflow', () => {
	assert.deepEqual(
		computeSelectionButtonPosition(
			{ left: 120, top: 180, right: 220, bottom: 210 },
			{ width: 320, height: 240 },
			{ width: 36, height: 36 },
		),
		{ left: 184, top: 138 },
	);
});

test('flips left and clamps to the viewport margin', () => {
	assert.deepEqual(
		computeSelectionButtonPosition(
			{ left: 300, top: 20, right: 318, bottom: 42 },
			{ width: 320, height: 240 },
			{ width: 36, height: 36 },
		),
		{ left: 258, top: 48 },
	);
	assert.deepEqual(
		computeSelectionButtonPosition(
			{ left: 0, top: 0, right: 12, bottom: 12 },
			{ width: 40, height: 40 },
			{ width: 36, height: 36 },
		),
		{ left: 0, top: 0 },
	);
});
```

- [ ] **Step 2: Run geometry tests and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/selection_button_position.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `selection_button_position.ts`.

- [ ] **Step 3: Implement the pure geometry helper**

Create `src/content/selection_button_position.ts`:

```ts
export interface RectLike {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface SizeLike {
	width: number;
	height: number;
}

export interface ButtonPosition {
	left: number;
	top: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function computeSelectionButtonPosition(
	anchor: RectLike,
	viewport: SizeLike,
	button: SizeLike,
	gap = 6,
	margin = 8,
): ButtonPosition {
	let left = anchor.right - button.width;
	let top = anchor.bottom + gap;

	if (left + button.width > viewport.width - margin) {
		left = anchor.left - button.width - gap;
	}
	if (top + button.height > viewport.height - margin) {
		top = anchor.top - button.height - gap;
	}

	const maximumLeft = viewport.width - button.width - margin;
	const maximumTop = viewport.height - button.height - margin;
	const minimumLeft = Math.min(margin, Math.max(0, maximumLeft));
	const minimumTop = Math.min(margin, Math.max(0, maximumTop));

	return {
		left: clamp(left, minimumLeft, Math.max(minimumLeft, maximumLeft)),
		top: clamp(top, minimumTop, Math.max(minimumTop, maximumTop)),
	};
}
```

- [ ] **Step 4: Run geometry tests GREEN**

Run the Step 2 command.

Expected: 3 tests PASS.

- [ ] **Step 5: Commit geometry**

```bash
git add src/content/selection_button_position.ts tests/unit/selection_button_position.test.ts
git commit -m "Add selection button positioning"
```

---

### Task 3: Content-script selection affordance

**Files:**
- Create: `src/content/selection_button.ts`
- Modify: `src/content/content_script.ts`
- Create: `tests/e2e/selection-button.spec.ts`

**Interfaces:**
- Consumes: Task 1 `StartSelectedTextMessage`, setting helper, translations, dimensions, and host ID.
- Consumes: Task 2 `computeSelectionButtonPosition()`.
- Produces: `installSelectionButton(): Promise<void>`.
- Produces an open Shadow DOM host with stable ID for E2E inspection; the page receives no selected-text property or attribute.

- [ ] **Step 1: Write failing E2E coverage for visibility, exclusion, hiding, and keyboard focus**

Create `tests/e2e/selection-button.spec.ts` with these helpers and tests:

```ts
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

const targetUrl = 'https://readit.test/selection-button';
const hostSelector = '#readit-dev-selection-button-host';
const buttonSelector = `${hostSelector} button`;

async function openSelectionPage(context: BrowserContext): Promise<Page> {
	await context.route(targetUrl, (route) =>
		route.fulfill({
			contentType: 'text/html; charset=utf-8',
			body: `<!doctype html><html lang="vi"><body style="min-height:1400px">
				<button id="before">Before selection</button>
				<p id="first">Đoạn văn bản đầu tiên dùng để kiểm tra nút đọc selection.</p>
				<p id="second">Đoạn văn bản thứ hai phải thay thế phiên đọc đang hoạt động.</p>
				<div id="editable" contenteditable="true">Vùng soạn thảo không được hiển thị nút đọc.</div>
				<iframe id="child" srcdoc="<p id='inside-frame'>Văn bản trong iframe không thuộc phạm vi hỗ trợ.</p>"></iframe>
			</body></html>`,
		}),
	);
	const page = await context.newPage();
	await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
	return page;
}

async function selectNodeText(page: Page, selector: string, source: 'pointer' | 'keyboard'): Promise<void> {
	await page.locator(selector).evaluate((element, selectionSource) => {
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(element);
		selection?.removeAllRanges();
		selection?.addRange(range);
		if (selectionSource === 'pointer') {
			document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		} else {
			document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
		}
	}, source);
}

test('shows the approved logo button for pointer selection and hides it on dismissal events', async ({ context }) => {
	const page = await openSelectionPage(context);
	await selectNodeText(page, '#first', 'pointer');

	const button = page.locator(buttonSelector);
	await expect(button).toBeVisible();
	await expect(button).toHaveAttribute('aria-label', 'Đọc văn bản đã chọn');
	await expect(button.locator('img')).toHaveAttribute('src', /chrome-extension:\/\/.*\/assets\/icon32\.png/);
	await expect(button).toHaveCSS('width', '36px');
	await expect(button).toHaveCSS('height', '36px');

	await page.keyboard.press('Escape');
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#first', 'pointer');
	await page.mouse.click(4, 4);
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test('does not show the affordance for editable content', async ({ context }) => {
	const page = await openSelectionPage(context);
	await selectNodeText(page, '#editable', 'pointer');
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test('does not install the affordance in child frames', async ({ context }) => {
	const page = await openSelectionPage(context);
	const frame = page.frameLocator('#child');
	await frame.locator('#inside-frame').evaluate((element) => {
		const selection = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(element);
		selection?.removeAllRanges();
		selection?.addRange(range);
		document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	});
	await expect(frame.locator(hostSelector)).toHaveCount(0);
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test('keyboard selection focuses the button and Escape restores prior focus', async ({ context }) => {
	const page = await openSelectionPage(context);
	await page.locator('#before').focus();
	await selectNodeText(page, '#first', 'keyboard');

	await expect(page.locator(buttonSelector)).toBeFocused();
	await page.locator(buttonSelector).press('Escape');
	await expect(page.locator(hostSelector)).toHaveCount(0);
	await expect(page.locator('#before')).toBeFocused();
});

test('keyboard selection supports native Enter and Space activation', async ({ context }) => {
	const page = await openSelectionPage(context);

	await selectNodeText(page, '#first', 'keyboard');
	await page.locator(buttonSelector).press('Enter');
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await selectNodeText(page, '#second', 'keyboard');
	await page.locator(buttonSelector).press('Space');
	await expect(page.locator(hostSelector)).toHaveCount(0);
});

test.describe('English browser locale', () => {
	test.use({ browserLocale: 'en-US' });

	test('localizes the selected-text button label', async ({ context }) => {
		const page = await openSelectionPage(context);
		await selectNodeText(page, '#first', 'pointer');
		await expect(page.locator(buttonSelector)).toHaveAttribute('aria-label', 'Read selected text');
	});
});
```

- [ ] **Step 2: Build and verify E2E RED**

Run:

```bash
CI=true pnpm build
CI=true pnpm exec playwright test tests/e2e/selection-button.spec.ts
```

Expected: build succeeds, then all new tests FAIL because the selection-button host is never created.

- [ ] **Step 3: Implement the content-side controller**

Create `src/content/selection_button.ts`. Keep DOM responsibilities in this file and geometry in Task 2's pure helper. Use this state and event structure:

```ts
import { STORAGE_KEYS, THEME_TRANSLATIONS } from '../shared/constants';
import {
	SELECTION_BUTTON_HOST_ID,
	SELECTION_BUTTON_ICON_SIZE,
	SELECTION_BUTTON_SIZE,
	type StartSelectedTextMessage,
	isSelectionButtonEnabled,
} from '../shared/selection_button';
import { computeSelectionButtonPosition } from './selection_button_position';

type SelectionSource = 'pointer' | 'keyboard';

interface SelectionSnapshot {
	text: string;
	pageLanguage: string;
	anchor: { left: number; top: number; right: number; bottom: number };
}

function elementForNode(node: Node | null): Element | null {
	return node instanceof Element ? node : node?.parentElement ?? null;
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
	if (!text || isEditableNode(selection.anchorNode) || isEditableNode(selection.focusNode) || isEditableNode(range.commonAncestorContainer)) {
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
	if (window.top !== window || (location.protocol !== 'http:' && location.protocol !== 'https:')) {
		return;
	}

	const stored = await chrome.storage.local.get(STORAGE_KEYS.SELECTION_BUTTON_ENABLED);
	let enabled = isSelectionButtonEnabled(stored[STORAGE_KEYS.SELECTION_BUTTON_ENABLED]);
	let host: HTMLDivElement | null = null;
	let snapshot: SelectionSnapshot | null = null;
	let previousFocus: HTMLElement | null = null;
	let movingKeyboardFocus = false;
	let activated = false;

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
			button { all: initial; box-sizing: border-box; width: 36px; height: 36px; display: flex; align-items: center;
				justify-content: center; border: 1px solid rgba(0,0,0,.22); border-radius: 9px; background: #fff;
				box-shadow: 0 4px 12px rgba(0,0,0,.38); cursor: pointer; }
			button:hover { transform: translateY(-1px); }
			button:focus-visible { outline: 2px solid #099fb5; outline-offset: 3px; }
			button:disabled { opacity: .65; cursor: default; }
			img { display: block; width: 26px; height: 26px; }
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

	document.addEventListener('selectionchange', () => {
		if (movingKeyboardFocus || host?.shadowRoot?.activeElement instanceof HTMLButtonElement) {
			return;
		}
		removeButton();
	});
	document.addEventListener('pointerup', (event) => {
		if (host && event.composedPath().includes(host)) {
			return;
		}
		queueMicrotask(() => showButton('pointer'));
	});
	document.addEventListener('keyup', (event) => {
		if (event.key === 'Escape') {
			removeButton(true);
			return;
		}
		if (host?.shadowRoot?.activeElement instanceof HTMLButtonElement) {
			return;
		}
		if (event.key === 'Shift' || event.shiftKey) {
			queueMicrotask(() => showButton('keyboard'));
		}
	});
	document.addEventListener(
		'pointerdown',
		(event) => {
			if (host && !event.composedPath().includes(host)) {
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
```

- [ ] **Step 4: Install the controller once**

In `src/content/content_script.ts`, add:

```ts
import { installSelectionButton } from './selection_button';
```

Inside the existing `claimContentScriptInitialization(...)` block, after the runtime message listener is registered, add:

```ts
void installSelectionButton();
```

- [ ] **Step 5: Build and run selection affordance E2E GREEN**

Run:

```bash
CI=true pnpm build
CI=true pnpm exec playwright test tests/e2e/selection-button.spec.ts
```

Expected: all six E2E tests PASS with localized labels, no child-frame affordance, and no host left after dismissal or activation.

- [ ] **Step 6: Commit the content affordance**

```bash
git add src/content/selection_button.ts src/content/content_script.ts tests/e2e/selection-button.spec.ts
git commit -m "Add selected-text floating button"
```

---

### Task 4: Background command, popup opening, and session replacement

**Files:**
- Create: `src/background/selected_text_request.ts`
- Create: `src/background/action_popup.ts`
- Create: `tests/unit/selected_text_request.test.ts`
- Create: `tests/unit/action_popup.test.ts`
- Modify: `src/background/background.ts`
- Modify: `tests/e2e/selection-button.spec.ts`

**Interfaces:**
- Produces: `prepareSelectedTextRequest(message, sender): PreparedSelectedTextRequest | null`.
- Produces: `requestActionPopup(windowId, action): Promise<void>` that never rejects.
- Consumes: existing `createSelectedTextArticle()` and `startArticlePlayback()`.
- Background accepts only frame `0`, integer tab/window IDs, and HTTP/HTTPS sender URLs.
- The new command uses the existing `respondFromQueue()` state lock; it adds no playback queue.

- [ ] **Step 1: Write failing pure background-boundary tests**

Create `tests/unit/selected_text_request.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSelectedTextRequest } from '../../src/background/selected_text_request.ts';

const sender = {
	frameId: 0,
	tabId: 42,
	windowId: 7,
	title: 'Selection page',
	url: 'https://readit.test/selection-button',
};

test('prepares a selected-text Article from trusted sender metadata', () => {
	assert.deepEqual(
		prepareSelectedTextRequest({ selectionText: '  Nội dung mới  ', pageLanguage: 'vi-VN' }, sender),
		{
			tabId: 42,
			windowId: 7,
			title: 'Selection page',
			url: 'https://readit.test/selection-button',
			article: {
				title: 'Selection page',
				content: 'Nội dung mới',
				url: 'https://readit.test/selection-button',
				lang: 'vi',
			},
		},
	);
});

test('rejects child frames, unsupported protocols, missing ids, and empty text', () => {
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, frameId: 1 }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, url: 'chrome://settings' }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, url: 'not a URL' }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: 'Text', pageLanguage: 'en' }, { ...sender, tabId: undefined }), null);
	assert.equal(prepareSelectedTextRequest({ selectionText: '   ', pageLanguage: 'en' }, sender), null);
});
```

Create `tests/unit/action_popup.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { requestActionPopup } from '../../src/background/action_popup.ts';

test('requests the action popup in the sender window', async () => {
	const calls: unknown[] = [];
	await requestActionPopup(7, {
		openPopup: async (options) => {
			calls.push(options);
		},
	});
	assert.deepEqual(calls, [{ windowId: 7 }]);
});

test('absorbs popup API rejection', async () => {
	await assert.doesNotReject(() =>
		requestActionPopup(7, {
			openPopup: async () => {
				throw new Error('Popup unavailable');
			},
		}),
	);
});
```

- [ ] **Step 2: Run boundary tests and verify RED**

Run:

```bash
node --experimental-strip-types --test tests/unit/selected_text_request.test.ts tests/unit/action_popup.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for both new background modules.

- [ ] **Step 3: Implement sender-derived request preparation**

Create `src/background/selected_text_request.ts`:

```ts
import type { Article } from '../shared/types';
import { createSelectedTextArticle } from './selected_text';

export interface SelectedTextMessageInput {
	selectionText: unknown;
	pageLanguage: unknown;
}

export interface SelectedTextSenderInput {
	frameId: unknown;
	tabId: unknown;
	windowId: unknown;
	title: unknown;
	url: unknown;
}

export interface PreparedSelectedTextRequest {
	tabId: number;
	windowId: number;
	title: string;
	url: string;
	article: Article;
}

export function prepareSelectedTextRequest(
	message: SelectedTextMessageInput,
	sender: SelectedTextSenderInput,
): PreparedSelectedTextRequest | null {
	if (sender.frameId !== 0 || !Number.isInteger(sender.tabId) || !Number.isInteger(sender.windowId)) {
		return null;
	}
	if (typeof sender.url !== 'string') {
		return null;
	}
	let protocol: string;
	try {
		protocol = new URL(sender.url).protocol;
	} catch (_error) {
		return null;
	}
	if (protocol !== 'http:' && protocol !== 'https:') {
		return null;
	}
	const title = typeof sender.title === 'string' ? sender.title : sender.url;
	const article = createSelectedTextArticle({
		selectionText: message.selectionText,
		pageLanguage: message.pageLanguage,
		title,
		url: sender.url,
	});
	if (!article) {
		return null;
	}
	return {
		tabId: sender.tabId as number,
		windowId: sender.windowId as number,
		title,
		url: sender.url,
		article,
	};
}
```

Create `src/background/action_popup.ts`:

```ts
export interface ActionPopupApi {
	openPopup(options: { windowId: number }): Promise<void>;
}

export async function requestActionPopup(windowId: number, action: ActionPopupApi): Promise<void> {
	try {
		await action.openPopup({ windowId });
	} catch (_error) {
		// Popup availability must not prevent a valid selected-text start.
	}
}
```

- [ ] **Step 4: Run boundary tests GREEN**

Run the Step 2 command.

Expected: 4 tests PASS.

- [ ] **Step 5: Route the runtime intent through the existing coordinator**

In `src/background/background.ts`:

1. Import `requestActionPopup` and `prepareSelectedTextRequest`.
2. Rename the message-listener parameter `_sender` to `sender`.
3. Add this switch branch before `PAUSE_READING`:

```ts
case 'START_SELECTED_TEXT': {
	const request = prepareSelectedTextRequest(
		{ selectionText: msg.selectionText, pageLanguage: msg.pageLanguage },
		{
			frameId: sender.frameId,
			tabId: sender.tab?.id,
			windowId: sender.tab?.windowId,
			title: sender.tab?.title,
			url: sender.url,
		},
	);
	if (!request) {
		sendResponse({ success: true });
		return undefined;
	}

	void requestActionPopup(request.windowId, chrome.action);
	return respondFromQueue(
		() => startArticlePlayback(request.tabId, request.title, request.url, request.article),
		sendResponse,
	);
}
```

Do not add another queue or pending state. Leave `startArticlePlayback()` unchanged so its first state-changing action remains:

```ts
await stopActiveSession('session-replaced');
```

Keep the context-menu handler using `createSelectedTextArticle()` followed by the same `startArticlePlayback()`.

- [ ] **Step 6: Add real popup and replacement E2E coverage**

Append to `tests/e2e/selection-button.spec.ts`:

```ts
test('opens the action popup and replaces the active session with a new selection', async ({ context, extensionId }) => {
	const page = await openSelectionPage(context);

	await selectNodeText(page, '#first', 'pointer');
	const firstPopupPromise = context.waitForEvent('page', {
		predicate: (candidate) => candidate.url() === `chrome-extension://${extensionId}/src/popup/popup.html`,
	});
	await page.locator(buttonSelector).click();
	const firstPopup = await firstPopupPromise;
	const firstState = await firstPopup.evaluate(
		() => new Promise<any>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)),
	);
	expect(firstState.session).toMatchObject({ status: 'loading', title: 'Selection page' });

	await page.bringToFront();
	await selectNodeText(page, '#second', 'pointer');
	const secondPopupPromise = context.waitForEvent('page', {
		predicate: (candidate) => candidate.url() === `chrome-extension://${extensionId}/src/popup/popup.html`,
	});
	await page.locator(buttonSelector).click();
	const secondPopup = await secondPopupPromise;
	const secondState = await secondPopup.evaluate(
		() => new Promise<any>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)),
	);
	expect(secondState.session).toMatchObject({ status: 'loading', title: 'Selection page' });
	expect(secondState.session.sessionId).not.toBe(firstState.session.sessionId);

	await secondPopup.evaluate((oldSessionId) => {
		chrome.runtime.sendMessage({
			action: 'PLAYBACK_PROGRESS_UPDATE',
			sessionId: oldSessionId,
			progress: { status: 'playing', currentParagraphIndex: 99, totalParagraphs: 100, progressPercentage: 99 },
		});
	}, firstState.session.sessionId);
	const stateAfterStaleProgress = await secondPopup.evaluate(
		() => new Promise<any>((resolve) => chrome.runtime.sendMessage({ action: 'GET_PLAYBACK_STATE' }, resolve)),
	);
	expect(stateAfterStaleProgress.session.sessionId).toBe(secondState.session.sessionId);
	expect(stateAfterStaleProgress.session.currentParagraphIndex).not.toBe(99);

	const persistedState = await secondPopup.evaluate(async () => ({
		local: await chrome.storage.local.get(),
		session: await chrome.storage.session.get(),
	}));
	expect(JSON.stringify(persistedState)).not.toContain('Đoạn văn bản thứ hai phải thay thế phiên đọc đang hoạt động.');
});

test('accepts only the first activation from the same rendered button', async ({ context, extensionId }) => {
	const page = await openSelectionPage(context);
	const observer = await context.newPage();
	await observer.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	await observer.evaluate(() => {
		(window as any).selectedTextStartCount = 0;
		chrome.runtime.onMessage.addListener((message) => {
			if (message?.action === 'START_SELECTED_TEXT') {
				(window as any).selectedTextStartCount += 1;
			}
		});
	});

	await page.bringToFront();
	await selectNodeText(page, '#first', 'pointer');
	await page.locator(buttonSelector).evaluate((button) => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});

	await expect.poll(() => observer.evaluate(() => (window as any).selectedTextStartCount)).toBe(1);
	await page.waitForTimeout(150);
	expect(await observer.evaluate(() => (window as any).selectedTextStartCount)).toBe(1);
});
```

- [ ] **Step 7: Run background unit and integration tests GREEN**

Run:

```bash
node --experimental-strip-types --test tests/unit/selected_text.test.ts tests/unit/selected_text_request.test.ts tests/unit/action_popup.test.ts tests/unit/playback_state.test.ts
CI=true pnpm build
CI=true pnpm exec playwright test tests/e2e/selection-button.spec.ts tests/e2e/reading-state.spec.ts
```

Expected: all focused unit and Playwright tests PASS; the replacement session ID differs and stale progress cannot mutate it.

- [ ] **Step 8: Commit the background entry point**

```bash
git add src/background/selected_text_request.ts src/background/action_popup.ts src/background/background.ts tests/unit/selected_text_request.test.ts tests/unit/action_popup.test.ts tests/e2e/selection-button.spec.ts
git commit -m "Start selected text from floating button"
```

---

### Task 5: Compact popup enablement setting

**Files:**
- Modify: `src/popup/App.tsx`
- Modify: `src/popup/popup.css`
- Modify: `tests/e2e/themes.spec.ts`
- Modify: `tests/e2e/selection-button.spec.ts`

**Interfaces:**
- Consumes: `STORAGE_KEYS.SELECTION_BUTTON_ENABLED`, `isSelectionButtonEnabled()`, and `showSelectionButton` translation from Task 1.
- Produces: a controlled native checkbox with class `selection-button-toggle` inside `.selection-button-setting`.
- The row is a direct child of `.app-container` immediately before `.app-footer` in every theme.

- [ ] **Step 1: Write failing popup-setting E2E tests**

Append to `tests/e2e/themes.spec.ts`:

```ts
test('selection button setting defaults on, persists, and stays before the footer in every theme', async ({ page, openPopup }) => {
	await installPopupRuntimeMock(page, { session: null, currentTabId: 7 });
	await openPopup(page);

	const toggle = page.getByRole('checkbox', { name: 'Hiện nút đọc cạnh văn bản đã chọn' });
	await expect(toggle).toBeChecked();
	await expect(page.locator('.selection-button-setting + .app-footer')).toHaveCount(1);

	for (const label of ['🕹️ Classic (1998)', '💿 Vista Aero (2006)', '📱 Hiện đại']) {
		await selectTheme(page, label);
		await expect(toggle).toBeVisible();
		await expect(page.locator('.selection-button-setting + .app-footer')).toHaveCount(1);
	}

	await toggle.uncheck();
	expect(
		await page.evaluate(async () => (await chrome.storage.local.get('readit_selection_button_enabled')).readit_selection_button_enabled),
	).toBe(false);
	await page.reload();
	await expect(page.getByRole('checkbox', { name: 'Hiện nút đọc cạnh văn bản đã chọn' })).not.toBeChecked();
});
```

Inside the existing English-locale test, add:

```ts
await expect(page.getByRole('checkbox', { name: 'Show read button for selected text' })).toBeChecked();
```

- [ ] **Step 2: Run popup tests and verify RED**

Run:

```bash
CI=true pnpm build
CI=true pnpm exec playwright test tests/e2e/themes.spec.ts
```

Expected: FAIL because the checkbox and `.selection-button-setting` row do not exist.

- [ ] **Step 3: Implement default-on popup state and persistence**

In `src/popup/App.tsx`:

1. Import `isSelectionButtonEnabled` from `../shared/selection_button`.
2. Add state beside voice and speed:

```ts
const [selectionButtonEnabled, setSelectionButtonEnabled] = useState(true);
```

3. Add `STORAGE_KEYS.SELECTION_BUTTON_ENABLED` to the initial `chrome.storage.local.get()` keys and hydrate it:

```ts
setSelectionButtonEnabled(isSelectionButtonEnabled(result[STORAGE_KEYS.SELECTION_BUTTON_ENABLED]));
```

4. Add the handler:

```ts
const handleSelectionButtonEnabledChange = (enabled: boolean) => {
	setSelectionButtonEnabled(enabled);
	void chrome.storage.local.set({ [STORAGE_KEYS.SELECTION_BUTTON_ENABLED]: enabled });
};
```

5. Insert this direct child immediately before `<footer className="app-footer">`:

```tsx
<label className="selection-button-setting">
	<span>{t('showSelectionButton')}</span>
	<input
		type="checkbox"
		className="selection-button-toggle"
		checked={selectionButtonEnabled}
		onChange={(event) => handleSelectionButtonEnabledChange(event.target.checked)}
	/>
</label>
```

- [ ] **Step 4: Add compact one-line styling**

Add to `src/popup/popup.css` before the footer section:

```css
.selection-button-setting {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 11px 14px;
	border: 1px solid var(--border-glass);
	border-radius: 12px;
	background: var(--bg-glass);
	color: var(--color-text-primary);
	font-size: 11px;
	font-weight: 600;
	line-height: 1.25;
	white-space: nowrap;
}

.selection-button-setting span {
	overflow: hidden;
	text-overflow: ellipsis;
}

.selection-button-toggle {
	appearance: none;
	flex: 0 0 auto;
	width: 34px;
	height: 20px;
	padding: 3px;
	border: 0;
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.18);
	cursor: pointer;
}

.selection-button-toggle::before {
	content: "";
	display: block;
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: #fff;
	transition: transform 0.15s ease;
}

.selection-button-toggle:checked {
	background: #008771;
}

.selection-button-toggle:checked::before {
	transform: translateX(14px);
}

.selection-button-toggle:focus-visible {
	outline: 2px solid #099fb5;
	outline-offset: 3px;
}
```

Do not add helper copy or a section heading. Let existing theme variables control the row background, border, and typography.

- [ ] **Step 5: Add live content-tab setting coverage**

Append to `tests/e2e/selection-button.spec.ts`:

```ts
test('popup setting disables and re-enables the affordance in an open tab', async ({ context, extensionId }) => {
	const page = await openSelectionPage(context);
	const popup = await context.newPage();
	await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
	const toggle = popup.getByRole('checkbox', { name: 'Hiện nút đọc cạnh văn bản đã chọn' });

	await toggle.uncheck();
	await page.bringToFront();
	await selectNodeText(page, '#first', 'pointer');
	await expect(page.locator(hostSelector)).toHaveCount(0);

	await popup.bringToFront();
	await toggle.check();
	await page.bringToFront();
	await selectNodeText(page, '#first', 'pointer');
	await expect(page.locator(buttonSelector)).toBeVisible();
});
```

- [ ] **Step 6: Run popup and live-setting E2E GREEN**

Run:

```bash
CI=true pnpm build
CI=true pnpm exec playwright test tests/e2e/themes.spec.ts tests/e2e/selection-button.spec.ts
```

Expected: all tests PASS; the setting is one line, remains directly before the footer, persists, and updates the open tab.

- [ ] **Step 7: Commit the popup setting**

```bash
git add src/popup/App.tsx src/popup/popup.css tests/e2e/themes.spec.ts tests/e2e/selection-button.spec.ts
git commit -m "Add selected-text button setting"
```

---

### Task 6: Documentation closure and release verification

**Files:**
- Modify: `_docs/specs/2026-07-12-free-mvp-design.md`
- Modify: `_docs/RELEASING.md`
- Modify: `_docs/specs/2026-07-16-selected-text-floating-button-design.md`
- Verify only: all source and test files changed by Tasks 1 through 5

**Interfaces:**
- Consumes: the finished runtime behavior and manifest contract from Tasks 1 through 5.
- Produces: canonical product/release documentation and an `Implemented` design status only after all verification commands pass.

- [ ] **Step 1: Update canonical Free behavior**

In `_docs/specs/2026-07-12-free-mvp-design.md`, extend the selected-text section with these exact requirements:

```markdown
On Chrome 127+, a default-on popup setting also enables a compact logo-only
button beside supported top-document selections. Activating the button opens
the action popup immediately and replaces the active session through the same
single-session coordinator used by full-page and context-menu starts. The
button is not shown in editable content or child frames, and disabling the
setting removes only the affordance without stopping playback.
```

Keep the existing context-menu requirement and local-only boundary.

- [ ] **Step 2: Update release guidance**

In `_docs/RELEASING.md`, document that `pnpm validate:manifest` now asserts:

```markdown
- `minimum_chrome_version` is exactly `127`;
- `assets/icon32.png` is exposed only to `http://*/*` and `https://*/*`;
- the existing ONNX web-accessible resources remain exact; and
- permissions and host permissions remain at the documented Free boundary.
```

- [ ] **Step 3: Run focused formatting and unit verification**

Run:

```bash
pnpm exec biome check --write src/shared/selection_button.ts src/shared/constants.ts src/content/selection_button_position.ts src/content/selection_button.ts src/content/content_script.ts src/background/selected_text_request.ts src/background/action_popup.ts src/background/background.ts src/popup/App.tsx src/popup/popup.css tests/unit/selection_button_contract.test.ts tests/unit/selection_button_position.test.ts tests/unit/selected_text_request.test.ts tests/unit/action_popup.test.ts tests/unit/manifest_validation.test.ts tests/e2e/selection-button.spec.ts tests/e2e/themes.spec.ts
pnpm exec biome check src/shared/selection_button.ts src/shared/constants.ts src/content/selection_button_position.ts src/content/selection_button.ts src/content/content_script.ts src/background/selected_text_request.ts src/background/action_popup.ts src/background/background.ts src/popup/App.tsx src/popup/popup.css tests/unit/selection_button_contract.test.ts tests/unit/selection_button_position.test.ts tests/unit/selected_text_request.test.ts tests/unit/action_popup.test.ts tests/unit/manifest_validation.test.ts tests/e2e/selection-button.spec.ts tests/e2e/themes.spec.ts
pnpm test:unit
```

Expected: Biome formats only the listed implementation/test files, the follow-up check exits 0, and the complete unit suite reports zero failures.

- [ ] **Step 4: Run build and built-manifest verification**

Run:

```bash
CI=true pnpm build
pnpm validate:manifest
```

Expected: TypeScript and Rsbuild exit 0; the built manifest passes the Chrome 127, resource, permission, and host checks.

- [ ] **Step 5: Run targeted real-extension E2E**

Run:

```bash
CI=true pnpm exec playwright test tests/e2e/selection-button.spec.ts tests/e2e/reading-state.spec.ts tests/e2e/themes.spec.ts tests/e2e/tts-controls.spec.ts
```

Expected: all targeted tests PASS, including real popup opening, session replacement, stale-progress rejection, setting persistence, and theme layout.

- [ ] **Step 6: Run the complete E2E suite**

Run:

```bash
CI=true pnpm test:e2e
```

Expected: the full Playwright suite reports zero failures and no focused test marker.

- [ ] **Step 7: Verify privacy, artifact contents, and diff integrity**

Run:

```bash
! rg -n "api\.readit\.dev" dist
git diff --check
git status --short
```

Expected:

- the negated `rg` check exits 0 because no backend endpoint exists in `dist`;
- `git diff --check` exits 0 with no output;
- `git status --short` lists only intended implementation/docs files plus the pre-existing untracked `context_improvement.md`.

Inspect `dist/manifest.json` and confirm it contains the Chrome 127 floor, the exact icon resource entry, unchanged permissions, and unchanged host permissions.

- [ ] **Step 8: Mark the feature implemented**

Only after Steps 3 through 7 pass, change the design header in `_docs/specs/2026-07-16-selected-text-floating-button-design.md` to:

```markdown
**Status:** Implemented
```

- [ ] **Step 9: Commit documentation closure**

```bash
git add _docs/specs/2026-07-12-free-mvp-design.md _docs/RELEASING.md _docs/specs/2026-07-16-selected-text-floating-button-design.md
git commit -m "Document selected-text button release"
```

- [ ] **Step 10: Record final evidence**

Run:

```bash
git log -6 --oneline
git status --short
```

Expected: the task commits are visible in order, the implementation files are clean, and `context_improvement.md` remains untracked and untouched.
