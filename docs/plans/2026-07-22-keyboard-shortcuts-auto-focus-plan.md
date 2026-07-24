# Extension Keyboard Shortcuts & Auto-Focus Primary Action Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keyboard shortcuts to open Popup (`Ctrl+Shift+K` / `Command+Shift+K`) and Side Panel (`Ctrl+Shift+E` / `Command+Shift+E`), while automatically focusing the primary read control button when Popup/Side Panel opens.

**Architecture:** Use standard Manifest V3 `commands` in `manifest.json` combined with a `chrome.commands.onCommand` listener in the service worker. Additionally, use React `useRef` + `useEffect` in Popup and Side Panel UI to automatically trigger `focus()` on the primary action button based on playback state.

**Tech Stack:** TypeScript, React, Chrome Extension API (Manifest V3 Commands & SidePanel).

## Global Constraints

- Default popup opening shortcut: `Ctrl+Shift+K` (Win/Linux), `Command+Shift+K` (Mac).
- Default side panel opening shortcut: `Ctrl+Shift+E` (Win/Linux), `Command+Shift+E` (Mac).
- Auto-focus primary read button (or pause/resume button if an active session exists) when UI mounts.
- Comply with shell command rule requiring a leading space.

---

### Task 1: Declare Shortcuts in Manifest and Background Listener

**Files:**
- Modify: `public/manifest.json`
- Modify: `src/background/background.ts`

- [ ] **Step 1: Add `commands` section to `public/manifest.json`**

Add `commands` configuration to `public/manifest.json`:
```json
	"commands": {
		"_execute_action": {
			"suggested_key": {
				"default": "Ctrl+Shift+K",
				"mac": "Command+Shift+K"
			}
		},
		"open_side_panel": {
			"suggested_key": {
				"default": "Ctrl+Shift+E",
				"mac": "Command+Shift+E"
			},
			"description": "Open side panel"
		}
	}
```

- [ ] **Step 2: Register `chrome.commands.onCommand` listener in `src/background/background.ts`**

Add side panel open handler:
```typescript
chrome.commands.onCommand.addListener(async (command) => {
	if (command === 'open_side_panel') {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (tab?.windowId) {
			await chrome.sidePanel.open({ windowId: tab.windowId });
		}
	}
});
```

- [ ] **Step 3: Check TypeScript build**

Run: ` pnpm build`
Expected: Compilation completes without errors.

- [ ] **Step 4: Commit**

```bash
 git add public/manifest.json src/background/index.ts
 git commit -m "feat: add keyboard shortcuts for popup and side panel"
```

---

### Task 2: Auto-focus Primary Action Button in Popup UI

**Files:**
- Modify: `src/popup/App.tsx`

- [ ] **Step 1: Create `primaryButtonRef` and add `useEffect` for Auto-focus**

In `src/popup/App.tsx`:
```typescript
const primaryButtonRef = useRef<HTMLButtonElement>(null);

useEffect(() => {
	if (session !== null || status === 'stopped') {
		primaryButtonRef.current?.focus();
	}
}, [session, status]);
```

- [ ] **Step 2: Attach `ref={primaryButtonRef}` to corresponding action button**

Attach `ref={primaryButtonRef}` to primary button (both default UI and Winamp/WMP12 themed UI):
```tsx
<button
	ref={primaryButtonRef}
	className={`btn btn-primary btn-icon-only btn-read ${status !== 'stopped' && status !== 'error' ? 'active' : ''}`}
	onClick={handleReadPage}
	aria-label={status === 'stopped' || status === 'error' ? t('readPage') : t('stopReading')}
	title={status === 'stopped' || status === 'error' ? t('readPage') : t('stopReading')}
>
	<PlaybackIcon name={status === 'stopped' || status === 'error' ? 'read' : 'stop'} />
</button>
```
Also attach `ref={primaryButtonRef}` to play/pause button when in playing/paused state.

- [ ] **Step 3: Check TypeScript build**

Run: ` pnpm build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
 git add src/popup/App.tsx
 git commit -m "feat: auto-focus primary action button in popup"
```

---

### Task 3: Auto-focus Primary Action Button in Side Panel UI

**Files:**
- Modify: `src/sidepanel/App.tsx`

- [ ] **Step 1: Create `primaryButtonRef` and add `useEffect` auto-focus for Side Panel**

In `src/sidepanel/App.tsx`:
```typescript
const primaryButtonRef = useRef<HTMLButtonElement>(null);

useEffect(() => {
	primaryButtonRef.current?.focus();
}, [session]);
```

- [ ] **Step 2: Attach `ref={primaryButtonRef}` to main read button of Side Panel**

Attach ref to "Read Page" button (`handleReadCurrentPage`).

- [ ] **Step 3: Check TypeScript build**

Run: ` pnpm build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
 git add src/sidepanel/App.tsx
 git commit -m "feat: auto-focus primary action button in side panel"
```

---

### Task 4: Complete Verification & Automated Testcases

- [x] **Step 1: Write E2E testcases verifying auto-focus in Popup & Side Panel**
  - Add `tự động focus vào nút đọc trang khi mở popup` test in `tests/e2e/tts-controls.spec.ts`.
  - Add `auto-focuses the primary action button when side panel opens` test in `tests/e2e/side-panel.spec.ts`.

- [x] **Step 2: Run production build**

Run: ` pnpm build`
Expected: BUILD SUCCESS

- [x] **Step 3: Run Playwright E2E test suite**

Run: ` pnpm test:e2e`
Expected: All E2E testcases pass.
