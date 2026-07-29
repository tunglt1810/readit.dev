# UI Alignment & Playback Controller Flicker Fix Plan (Simple Global State Mappings)

Goal: Fix MP3 export button layout misalignment, fix distorted export progress ring, align initial state transport buttons horizontally, and eliminate UI flash/flicker during paragraph transitions using simple global playback state mapping (no timers, no offscreen edits).

## User Review Required

> [!IMPORTANT]
> **Key Solutions (Simple & Direct):**
> 1. **MP3 Export Button Alignment (Ảnh 1):** Remove the text label below the MP3 export button so its 52px circle aligns perfectly in a single row with Pause and Stop buttons. The status label will be shown via `title` tooltip and `aria-label`.
> 2. **SVG Export Progress Ring (Ảnh 2):** Replace CSS `conic-gradient` + `border` hack with a clean SVG circular progress ring for accurate 0-100% progress rendering.
> 3. **Horizontal Initial State Buttons (Ảnh 3):** Align the initial state Play button and MP3 Export button horizontally in a single row (`gap: 16px`), matching active playback layout.
> 4. **Eliminate Paragraph Transition Flash (Simple Macro State Mapping):** Keep it simple. Define the visual UI state based on macro reading state: if playback is currently active (`playing`), and offscreen sends an internal `status: 'loading'` update for the next paragraph, the UI maintains the macro `playing` state instead of flashing to `loading`.
> 5. **Spacing Fix:** Add missing space after percentage in session context (`0% Reading in this tab`).

---

## Proposed Changes

### Shared UI & Components

#### [MODIFY] [AudioExportButton.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/components/AudioExportButton.tsx)
- Remove `<div className="audio-export-status">` text element to eliminate extra vertical height.
- Update `title={label}` and `aria-label={accessibleLabel}` for native tooltip & accessibility.
- Replace CSS `.audio-export-progress` div with an SVG `<svg className="audio-export-progress-ring">` with animated `strokeDashoffset` for export progress, and a clean SVG spinner for preparing/cancelling states.

#### [MODIFY] [App.tsx (Popup)](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx) & [App.tsx (Sidepanel)](file:///Users/bez/Workspace/repos/bez/readit.dev/src/sidepanel/App.tsx)
- **Simple Macro Status Derivation:** Derive visual status directly:
  `const visualStatus = (session?.status === 'loading' && session.currentParagraphIndex > 0) ? 'playing' : (session?.status ?? 'stopped');`
- Lay out initial state buttons side-by-side horizontally in `.playback-controls` (`gap: 16px`).
- Fix space in `.session-context` formatting (`0% Reading in this tab`).

#### [MODIFY] [theme.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/theme.css), [popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/popup.css), [sidepanel.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/sidepanel/sidepanel.css)
- Clean up `.audio-export-control` and `.audio-export-button` to sit directly in `.playback-controls` as a 52px flex item.
- Add SVG progress ring styles.

---

## Verification Plan

### Automated Tests
- `XDG_CONFIG_HOME=/tmp pnpm test:unit`
- `XDG_CONFIG_HOME=/tmp pnpm test:e2e tests/e2e/audio-export-ui.spec.ts tests/e2e/audio-export-runtime.spec.ts tests/e2e/reading-state.spec.ts`

### Manual Verification
- Verify Popup and Sidepanel UI layout in initial state (side-by-side horizontal buttons).
- Verify active export MP3 button alignment and SVG progress ring rendering.
- Verify smooth paragraph transition without button flicker.
