# UI Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Popup and Side Panel UI by integrating the side panel toggle button into the popup status display badge, unifying player control boxes across both surfaces (1:1 layout alignment), supporting instant hover tooltips, and extracting translation dictionaries into JSON files.

**Architecture:** Move `THEME_TRANSLATIONS` from `src/shared/constants.ts` to `src/shared/locales/{vi,en}.json`. Extract reusable `PlaybackIcon` and `PlaybackControlButton` components. Update Popup `status-display` CSS/JSX to embed the side panel toggle button with real-time open/closed state tracking and zero-delay CSS hover tooltip. Embed the control box directly inside `.current-page-card` / `.manual-text-card` at the top of the Side Panel and remove the separate bottom player card. Export `DEFAULT_SPEED = 1.05` across Popup, Side Panel, and Background.

**Tech Stack:** React 19, TypeScript, CSS (Vanilla), Chrome Extension V3 API.

## Global Constraints
- All spec and plan files MUST be written in English.
- Use `t(...)` from `src/shared/i18n.ts` for localization (`title` tooltips, `data-tooltip`, and `aria-label`).
- Strictly adhere to Biome formatting rules (tabs, LF endings, 140 char line length).

---

### Task 1: Extract Translations from constants.ts into JSON Locale Files

**Files:**
- Create: `src/shared/locales/vi.json`
- Create: `src/shared/locales/en.json`
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/i18n.ts`
- Test: `pnpm build`

- [x] **Step 1: Create `src/shared/locales/vi.json` and `src/shared/locales/en.json`**
Move Vietnamese dictionary object into `src/shared/locales/vi.json` and English dictionary object into `src/shared/locales/en.json`. Add `"closeSidePanel"` locale keys.

- [x] **Step 2: Clean up `src/shared/constants.ts` and update `src/shared/i18n.ts`**
Remove `THEME_TRANSLATIONS` from `constants.ts`. In `src/shared/i18n.ts`, import `vi` from `./locales/vi.json` and `en` from `./locales/en.json`, and export `THEME_TRANSLATIONS = { vi, en }`.

- [x] **Step 3: Build & verify task 1**
Run `pnpm build` to verify module resolution and TypeScript types.

---

### Task 2: Extract Reusable PlaybackIcon & PlaybackControlButton Components

**Files:**
- Create: `src/shared/components/PlaybackIcon.tsx`
- Create: `src/shared/components/PlaybackControlButton.tsx`
- Modify: `src/popup/App.tsx`
- Modify: `src/sidepanel/App.tsx`
- Test: `pnpm build`

- [x] **Step 1: Create `PlaybackIcon.tsx` and `PlaybackControlButton.tsx`**
Extract reusable SVG icons and circular primary playback button with active/stop state handling, correct tooltips, and ARIA labels.

- [x] **Step 2: Update Popup and Side Panel to consume `PlaybackControlButton`**
Import and use `<PlaybackControlButton />` in both `src/popup/App.tsx` and `src/sidepanel/App.tsx`.

---

### Task 3: Refactor Popup Status Bar & Side Panel Toggle Button with Instant Tooltip

**Files:**
- Modify: `src/popup/App.tsx`
- Modify: `src/popup/popup.css`
- Modify: `src/shared/theme.css`
- Modify: `src/background/background.ts`

- [x] **Step 1: Track open side panel windows in background via runtime port `sidepanel-port`**
Listen to `onConnect` in `background.ts` and track open side panel window IDs in storage/state.

- [x] **Step 2: Update Popup Side Panel button to be a Toggle Button with Instant Tooltip**
Set `aria-pressed={isSidePanelOpen}`, `.active` class, `data-tooltip`, and dynamic tooltips `t('closeSidePanel')` / `t('openSidePanel')`.

- [x] **Step 3: Add CSS active glow and zero-delay `[data-tooltip]` hover styles**
Implement instant CSS hover/focus tooltip styling in `src/shared/theme.css`.

---

### Task 4: Relocate Control Box into Top Main Cards (Match Popup Layout 1:1)

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/sidepanel.css`
- Modify: `tests/e2e/side-panel.spec.ts`

- [x] **Step 1: Move progress bar & playback controls into `.current-page-card` and `.manual-text-card`**
In `src/sidepanel/App.tsx`, embed session metadata (`session-title`, `session-host`, `session-context`), `progress-bar-container`, and `playback-controls` directly inside `.current-page-card` when active tab reading is underway, and inside `.manual-text-card` when manual reading is underway.

- [x] **Step 2: Remove `.side-panel-player` bottom section**
Delete the standalone `<section className="side-panel-player">` at the bottom of the Side Panel component and clean up obsolete CSS rules from `src/sidepanel/sidepanel.css`.

---

### Task 5: Align Modern Theme Colors & Unify DEFAULT_SPEED Constant

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/theme.css`
- Modify: `src/popup/App.tsx`
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/background/background.ts`

- [x] **Step 1: Export `DEFAULT_SPEED = 1.05` in `constants.ts`**
Use `DEFAULT_SPEED` across Popup, Side Panel, and Background to eliminate default speed discrepancies (`1.05` vs `1.00`).

- [x] **Step 2: Refine Modern theme gradient variables**
Change `--gradient-brand` and `--gradient-brand-hover` in `src/shared/theme.css` to transition between teal and cyan, completely eliminating royal blue.

- [x] **Step 3: Run full build and E2E verification**
Run `pnpm build && pnpm test:e2e` to verify 100% pass rate.
