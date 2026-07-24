# Extension Keyboard Shortcuts & Auto-Focus Primary Action Button Design

## Overview
Provide keyboard shortcuts for the readit.dev Chrome extension to quickly open the Popup and Side Panel, and automatically focus the primary action button (Read Page / Pause / Resume) upon opening to optimize keyboard-first user workflows.

## Declared Keyboard Shortcuts
- **Open Popup**:
  - Windows / Linux: `Ctrl + Shift + K`
  - macOS: `Command + Shift + K`
  - Manifest V3 Command: `_execute_action`
- **Open Side Panel**:
  - Windows / Linux: `Ctrl + Shift + E`
  - macOS: `Command + Shift + E`
  - Manifest V3 Command: `open_side_panel`

## Structural Changes

### 1. `public/manifest.json`
- Add `"commands"` as a top-level key defining default shortcuts for `_execute_action` and `open_side_panel`.
- **Permissions Note**: No new permissions need to be added to `"permissions"`. The `"sidePanel"` permission is already present in the project.

### 2. `src/background/background.ts`
Add a `chrome.commands.onCommand` listener to handle `open_side_panel` event and open the side panel for the active window via `chrome.sidePanel.open({ windowId })`.

### 3. `src/popup/App.tsx`
- Create `primaryButtonRef = useRef<HTMLButtonElement>(null)`.
- Dynamically attach ref based on playback state:
  - When `status === 'stopped'` or `'error'`: **Read Page** button (`.btn-read` / themed primary).
  - When `status === 'playing'` or `'paused'`: **Pause / Resume** button (`.btn-playpause` / themed primary).
- Use `useEffect` to trigger `primaryButtonRef.current?.focus()` on Popup mount & initial session load.

### 4. `src/sidepanel/App.tsx`
- Create `primaryButtonRef = useRef<HTMLButtonElement>(null)`.
- Attach ref to the primary read button ("Read Page" or active playback control button).
- Trigger automatic focus when Side Panel mounts & receives initial session.

## Verification Plan
- Run `pnpm build` to check TypeScript & bundle with zero errors.
- Run `pnpm test:e2e` to verify Playwright test suite.
- Manually test keyboard shortcuts and primary action button auto-focus.
