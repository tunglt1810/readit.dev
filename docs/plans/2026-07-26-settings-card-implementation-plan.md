# Settings Card Redesign & Side Panel Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all extension settings into a unified, reusable `SettingsCard` component titled `"Configuration"`, format all settings as consistent inline rows, position the status display at the top of the Current Page card, place the SettingsCard at the bottom of the Side Panel, and enforce full localization and theme styling.

**Architecture:** Create `SettingsCard` component in `src/shared/components/SettingsCard.tsx`. Place shared form control, inline row, and theme override styles in `src/shared/theme.css`. Update `src/popup/App.tsx` and `src/sidepanel/App.tsx` to consume `SettingsCard`.

**Tech Stack:** React, TypeScript, Chrome Storage API, CSS Variables (Manifest V3 extension).

## Global Constraints

- Biome formatting: tabs, tabWidth: 4, line length limit 140.
- Strict TypeScript & React functional components.
- State persistence: `chrome.storage.local` keys `ACTIVE_VOICE`, `SPEED`, `THEME`, `SELECTION_BUTTON_ENABLED`, `WORD_HIGHLIGHT_ENABLED`.
- 100% localization via `t(...)` in `src/shared/i18n.ts` and `src/shared/constants.ts`.

---

### Task 1: Reusable Collapsible SettingsCard Component & Shared CSS Styles

**Files:**
- Create: `src/shared/components/SettingsCard.tsx`
- Modify: `src/shared/theme.css`
- Modify: `src/shared/constants.ts`

- [x] **Step 1: Update localization strings in constants.ts**
  - Update `voiceConfig` to `'Cấu hình'` (vi) and `'Configuration'` (en).
  - Update `selectVoice` to `'Chọn giọng đọc'` (vi) and `'Select Voice'` (en).

- [x] **Step 2: Create SettingsCard component with inline rows**
  - Render card header with title `t('voiceConfig')` and collapsible toggle arrow (▲/▼).
  - Render 5 uniform inline rows with `.setting-label`:
    1. Select Voice dropdown (`.form-select.inline-select`)
    2. Reading Speed slider (`.form-slider.inline-slider`)
    3. Show Selection Button toggle (`.selection-button-toggle`)
    4. Show Word Highlight toggle (`.selection-button-toggle`)
    5. Select Theme dropdown (`.theme-selector-btn`)

- [x] **Step 3: Add shared inline styles to theme.css**
  - Define `.setting-label` (12px, font-weight 500, color text-primary).
  - Define `.form-select.inline-select` and `.form-slider.inline-slider`.
  - Enforce transparent borderless `.selection-button-setting` row containers.

---

### Task 2: Integrate SettingsCard into Popup App

**Files:**
- Modify: `src/popup/App.tsx`
- Modify: `src/popup/popup.css`

- [x] **Step 1: Render SettingsCard in Popup App.tsx**
  - Consume `<SettingsCard collapsible={false} ... />`.

- [x] **Step 2: Verify build**
  - Run `pnpm build`.

---

### Task 3: Integrate SettingsCard & Move Status Display in SidePanel App

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/sidepanel.css`

- [x] **Step 1: Move status display to Current Page Card**
  - Move `<div className="status-display">` to top inside `current-page-card`.

- [x] **Step 2: Position Collapsible SettingsCard at the bottom**
  - Render `<SettingsCard collapsible defaultExpanded={false} ... />` above sticky player footer.
  - Set `margin-top: auto` on `.side-panel .settings-card`.

- [x] **Step 3: Verify with build & E2E tests**
  - Run `pnpm build && CI=true pnpm test:e2e`.
