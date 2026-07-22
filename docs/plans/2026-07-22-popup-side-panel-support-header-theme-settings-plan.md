# Theme Selector Toggle-Row Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the popup Theme selector as the final compact Settings row, after both existing toggle rows.

**Architecture:** Relocate the existing Theme selector markup without changing its state, handlers, storage key, or dropdown. Reuse `.selection-button-setting` for the row shell and keep the palette button as the row's right-side control. Extend the existing theme keyboard/persistence Playwright test with placement assertions.

**Tech Stack:** React 19, TypeScript, CSS, Chrome Manifest V3 APIs, Playwright.

## Global Constraints

- Keep `themeMenuOpen`, `themeSelectorButtonRef`, `handleThemeChange()`, and `STORAGE_KEYS.THEME` unchanged.
- Preserve click, Enter, Escape, blur-close, opaque dropdown, and Default/Winamp/WMP12 persistence behavior.
- Use a non-label row container because it nests a focusable palette button.
- Do not change Popup header, Coffee, Footer, Side Panel, playback, storage, or localization behavior.
- Build `dist/` with `CI=true pnpm build` before running browser tests against changed extension source.
- Do not stage, edit, or commit pre-existing working-tree changes outside the files listed below.

---

### Task 1: Place Theme After the Toggle Rows

**Files:**
- Modify: `tests/e2e/themes.spec.ts:139-176`
- Modify: `src/popup/App.tsx:501-548,568-588`
- Modify: `src/popup/popup.css:458-477,602-610`

**Interfaces:**
- Consumes: `t('selectTheme')`, `themeMenuOpen`, `themeSelectorButtonRef`, and `handleThemeChange()` from `src/popup/App.tsx`.
- Produces: one `.selection-button-setting.theme-setting` directly after the word-highlight toggle; `.app-section.theme-setting` is absent.

- [ ] **Step 1: Write the failing placement regression**

  In `tests/e2e/themes.spec.ts`, add these assertions immediately before the existing `aria-expanded` assertion in `theme selector supports keyboard interaction and persists the selected theme`:

  ```ts
  await expect(page.locator('.app-section.theme-setting')).toHaveCount(0);
  await expect(page.locator('.selection-button-setting.theme-setting')).toHaveCount(1);
  await expect(page.locator('.selection-button-setting + .theme-setting')).toHaveCount(1);
  ```

  Keep the existing assertions that the selector is not in the header, opens with Enter, closes with Escape, persists WMP12, and remains visible.

- [ ] **Step 2: Run the regression to verify it fails**

  Run: `CI=true pnpm exec playwright test tests/e2e/themes.spec.ts --workers=1 --retries=0 --reporter=list`

  Expected: FAIL because the selector is currently inside `.app-section.theme-setting` before the two toggle rows.

- [ ] **Step 3: Relocate the existing selector markup after Word Highlight**

  Remove the standalone `<section className="app-section theme-setting">` block before Voice Configuration. Immediately after the word-highlight `<label className="selection-button-setting">`, add this complete non-label row, preserving every handler and option:

  ```tsx
  <div className="selection-button-setting theme-setting">
  	<span>{t('selectTheme')}</span>
  	<div
  		className="theme-selector-container"
  		onBlur={(event) => {
  			if (!event.currentTarget.contains(event.relatedTarget)) {
  				setThemeMenuOpen(false);
  			}
  		}}
  		onKeyDown={(event) => {
  			if (event.key === 'Escape') {
  				setThemeMenuOpen(false);
  				themeSelectorButtonRef.current?.focus();
  			}
  		}}
  	>
  		<button
  			ref={themeSelectorButtonRef}
  			className="theme-selector-btn"
  			aria-label={t('selectTheme')}
  			aria-controls="theme-options"
  			aria-expanded={themeMenuOpen}
  			onClick={() => setThemeMenuOpen((open) => !open)}
  		>
  			🎨
  		</button>
  		<div id="theme-options" className={`theme-dropdown ${themeMenuOpen ? 'open' : ''}`} hidden={!themeMenuOpen}>
  			<button className={`theme-opt-btn ${activeTheme === 'default' ? 'active' : ''}`} onClick={() => handleThemeChange('default')}>
  				{t('themeDefault')}
  			</button>
  			<button className={`theme-opt-btn ${activeTheme === 'winamp' ? 'active' : ''}`} onClick={() => handleThemeChange('winamp')}>
  				{t('themeWinamp')}
  			</button>
  			<button className={`theme-opt-btn ${activeTheme === 'wmp12' ? 'active' : ''}`} onClick={() => handleThemeChange('wmp12')}>
  				{t('themeWmp12')}
  			</button>
  		</div>
  	</div>
  </div>
  ```

- [ ] **Step 4: Make the selector fit the shared row**

  In `src/popup/popup.css`, keep `.selection-button-setting` unchanged and replace the dedicated Theme wrapper styling with:

  ```css
  .theme-selector-container {
  	position: relative;
  	display: inline-block;
  	flex: 0 0 auto;
  }
  ```

  Remove `.theme-setting { gap: var(--space-3); }` and the current `align-self: flex-start` declaration. Keep the existing `.theme-selector-btn` and opaque `.theme-dropdown` rules unchanged.

- [ ] **Step 5: Build and re-run the Theme regression**

  Run: `CI=true pnpm build`

  Expected: PASS; TypeScript and the Popup bundle accept the relocated markup.

  Run: `CI=true pnpm exec playwright test tests/e2e/themes.spec.ts --workers=1 --retries=0 --reporter=list`

  Expected: PASS. The selector is the final Settings row, retains keyboard interaction, and persists WMP12.

- [ ] **Step 6: Commit the refinement**

  ```bash
  git add src/popup/App.tsx src/popup/popup.css tests/e2e/themes.spec.ts
  git commit -m "refine: align theme selector with settings toggles"
  ```

### Task 2: Verify the Popup Refinement

**Files:**
- Verify: `src/popup/App.tsx`, `src/popup/popup.css`, `tests/e2e/themes.spec.ts`

**Interfaces:**
- Consumes: the completed Theme row markup, CSS, and regression test from Task 1.
- Produces: evidence that the Popup behavior and generated extension remain valid.

- [ ] **Step 1: Run unit tests**

  Run: `CI=true pnpm test:unit`

  Expected: PASS with zero failures.

- [ ] **Step 2: Rebuild the extension**

  Run: `CI=true pnpm build`

  Expected: PASS with the Popup bundle regenerated.

- [ ] **Step 3: Run the focused browser regressions**

  Run: `CI=true pnpm exec playwright test tests/e2e/support.spec.ts tests/e2e/themes.spec.ts --workers=1 --retries=0 --reporter=list`

  Expected: PASS; Coffee stays in the header, Footer support links remain correct, and Theme remains usable from all three themes.

- [ ] **Step 4: Inspect the patch**

  Run: `git diff --check HEAD~1..HEAD`

  Expected: no output. Confirm the refinement commit contains only `src/popup/App.tsx`, `src/popup/popup.css`, and `tests/e2e/themes.spec.ts`.

### Task 3: Show the Active Theme Name in the Row

**Files:**
- Modify: `src/shared/constants.ts:41-101`
- Modify: `src/popup/App.tsx:335-585`
- Modify: `src/popup/popup.css:603-617`
- Modify: `tests/unit/theme_i18n.test.ts:12-50`
- Modify: `tests/e2e/themes.spec.ts:139-180`

**Interfaces:**
- Consumes: `activeTheme`, `t()`, and the existing `themeMenuOpen` dropdown state in `src/popup/App.tsx`.
- Produces: localized, icon-free strings for the closed selector button while leaving the existing icon-bearing menu labels unchanged.

- [ ] **Step 1: Write failing translation and popup regressions**

  Add icon-free name assertions to `tests/unit/theme_i18n.test.ts`:

  ```ts
  assert.strictEqual(vi.themeDefaultName, 'Hiện đại');
  assert.strictEqual(vi.themeWinampName, 'Classic (1998)');
  assert.strictEqual(vi.themeWmp12Name, 'Vista Aero (2006)');
  assert.strictEqual(en.themeDefaultName, 'Modern');
  ```

  In `theme selector supports keyboard interaction and persists the selected theme`, assert the closed trigger text begins as `Hiện đại`, changes to `Vista Aero (2006)` after choosing WMP12, and never contains `🎨`.

- [ ] **Step 2: Run the regressions to verify RED**

  Run: `CI=true pnpm test:unit`

  Expected: FAIL because the icon-free translation keys do not yet exist.

  Run: `CI=true pnpm exec playwright test tests/e2e/themes.spec.ts --workers=1 --retries=0 --reporter=list`

  Expected: FAIL because the closed trigger still renders `🎨`.

- [ ] **Step 3: Add icon-free active-theme names and render the selected value**

  Add `themeDefaultName`, `themeWinampName`, and `themeWmp12Name` to both language blocks in `src/shared/constants.ts`. In `App.tsx`, derive the active key with:

  ```ts
  const activeThemeName =
  	activeTheme === 'winamp' ? t('themeWinampName') : activeTheme === 'wmp12' ? t('themeWmp12Name') : t('themeDefaultName');
  ```

  Render `{activeThemeName}` inside `.theme-selector-btn` in place of `🎨`. Keep the button's existing accessible name, handlers, menu IDs, and the icon-bearing `themeDefault`, `themeWinamp`, and `themeWmp12` menu labels.

- [ ] **Step 4: Size the text trigger without changing the shared row**

  Replace the icon-only sizing in `.theme-selector-btn` with text-button padding and inherit the row's text color. Keep hover feedback without enlarging text or changing the dropdown geometry.

- [ ] **Step 5: Build and verify GREEN**

  Run: `CI=true pnpm test:unit`

  Expected: PASS.

  Run: `CI=true pnpm build`

  Expected: PASS.

  Run: `CI=true pnpm exec playwright test tests/e2e/themes.spec.ts --workers=1 --retries=0 --reporter=list`

  Expected: PASS. The trigger displays the active localized name and preserves keyboard interaction and WMP12 persistence.

- [ ] **Step 6: Commit the active-name refinement**

  ```bash
  git add docs/specs/2026-07-22-popup-side-panel-support-header-and-theme-settings-design.md src/shared/constants.ts src/popup/App.tsx src/popup/popup.css tests/unit/theme_i18n.test.ts tests/e2e/themes.spec.ts
  git commit -m "refine: show active theme in settings"
  ```
