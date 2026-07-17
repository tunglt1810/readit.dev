# Classic Theme Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the accessibility, styling, localization, Playwright-locale, test-coverage, and formatting findings from the review of merge commit `76a4c22`.

**Architecture:** Keep the existing popup component and translation dictionary. Add controlled state for the theme menu, make browser locale an explicit Playwright fixture option, apply theme backgrounds inside the themed container, and style the WMP12 Start/Stop and Play/Pause states according to their actual semantics. Cover each behavior through focused unit or extension E2E tests before changing production code.

**Tech Stack:** React 19, TypeScript, Vanilla CSS, Chrome MV3 storage, Node test runner, Playwright.

## Global Constraints

- Preserve the existing `default | winamp | wmp12` storage contract and `readit_active_theme` key.
- Keep article content and playback processing local-only.
- Preserve all unrelated working-tree changes.
- Put temporary browser profiles, reports, and screenshots under `/.tmp`.
- Do not add dependencies or refactor unrelated popup behavior.

---

### Task 1: Theme selector accessibility and persistence

**Files:**
- Create: `tests/e2e/themes.spec.ts`
- Modify: `src/popup/App.tsx`
- Modify: `src/popup/popup.css`

**Interfaces:**
- Consumes: `STORAGE_KEYS.THEME`, `chrome.storage.local`, and the existing theme identifiers.
- Produces: a selector that opens on hover or click, exposes `aria-expanded`, supports Tab/Enter/Escape, closes after selection, and restores the persisted theme after reload.

- [ ] **Step 1: Write failing E2E tests** for keyboard opening/closing, option visibility, selection, storage persistence, and reload hydration.
- [ ] **Step 2: Build the unchanged extension and run** `playwright test tests/e2e/themes.spec.ts`; expect failures because the current menu is hover-only and lacks ARIA state.
- [ ] **Step 3: Add minimal controlled menu state** with mouse enter/leave, click toggle, focus-leave close, Escape close, and selection close behavior.
- [ ] **Step 4: Replace hover-only CSS display logic** with an `.open` state while preserving the existing visual style.
- [ ] **Step 5: Rebuild and rerun the focused E2E test**; expect the selector and persistence assertions to pass.

### Task 2: Theme background and WMP12 control semantics

**Files:**
- Modify: `tests/e2e/themes.spec.ts`
- Modify: `src/popup/popup.css`

**Interfaces:**
- Consumes: `.app-container[data-theme]`, `.btn-playpause`, and `.btn-read.active`.
- Produces: visible Winamp/WMP12 backgrounds and a large cyan Play/Pause control with a smaller Stop control during active playback.

- [ ] **Step 1: Add failing computed-style assertions** for Winamp background color, WMP12 radial background, Play/Pause styling, and compact Stop styling.
- [ ] **Step 2: Run the focused E2E test**; expect failures because `--bg-app` is not consumed in descendant scope and WMP12 targets `.btn-read` unconditionally.
- [ ] **Step 3: Apply `--bg-app` directly to each themed container** and split WMP12 styling between the idle Start button, active Play/Pause button, and active Stop button.
- [ ] **Step 4: Rebuild and rerun the focused E2E test**; expect all computed-style assertions to pass.

### Task 3: Complete popup EN/VI translations

**Files:**
- Modify: `tests/unit/theme_i18n.test.ts`
- Modify: `tests/e2e/themes.spec.ts`
- Modify: `src/shared/constants.ts`
- Modify: `src/popup/App.tsx`

**Interfaces:**
- Consumes: the browser UI locale and stable voice IDs.
- Produces: English and Vietnamese strings for statuses, errors, session metadata, disclosures, footer links, and voice display names.

- [ ] **Step 1: Add failing unit assertions** for every new translation key and both locale-specific voice-name maps.
- [ ] **Step 2: Run** `node --experimental-strip-types --test tests/unit/theme_i18n.test.ts`; expect missing-key failures.
- [ ] **Step 3: Add the minimal dictionary entries** and voice-name maps for `vi` and `en`.
- [ ] **Step 4: Replace remaining visible hardcoded popup text** with translation lookups and translated voice names.
- [ ] **Step 5: Run the focused unit test**; expect all dictionary assertions to pass.

### Task 4: Make Playwright locale explicit and test English UI

**Files:**
- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/themes.spec.ts`
- Modify: `playwright.config.ts`

**Interfaces:**
- Consumes: a `browserLocale` Playwright option with default `vi-VN`.
- Produces: `launchPersistentContext(..., { locale: browserLocale })` and per-describe English-locale testing.

- [ ] **Step 1: Add an English-locale E2E block** using `test.use({ browserLocale: 'en-US' })` and assert translated status, session metadata, disclosure, footer, and voice labels.
- [ ] **Step 2: Run the focused E2E test**; expect fixture-option or English-copy failures.
- [ ] **Step 3: Add the typed `browserLocale` fixture option**, pass it directly to the persistent context, and remove the ineffective config-level locale.
- [ ] **Step 4: Rebuild and rerun the focused E2E test**; expect both locale variants to pass.

### Task 5: Cleanup and full verification

**Files:**
- Modify: `_docs/plans/2026-07-15-classic-media-player-themes-plan.md`

**Interfaces:**
- Produces: a clean reviewed range and full regression evidence.

- [ ] **Step 1: Remove the six trailing whitespace occurrences** reported by `git diff --check`.
- [ ] **Step 2: Run** `pnpm test:unit`.
- [ ] **Step 3: Run** `pnpm build`.
- [ ] **Step 4: Run** `pnpm validate:manifest`.
- [ ] **Step 5: Run** `pnpm test:e2e` with artifacts under `.tmp`.
- [ ] **Step 6: Run Biome on every changed code/test file** and `git diff --check`.
- [ ] **Step 7: Review the final diff** to confirm unrelated working-tree changes were preserved.
