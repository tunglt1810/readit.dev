# Instant Custom Tooltip Implementation Plan

Goal: Replace slow, laggy browser native OS tooltips with sleek, instant, theme-matched custom CSS tooltips across all action buttons in Popup and Sidepanel interfaces.

## User Review Required

> [!IMPORTANT]
> **Key Enhancements:**
> 1. **Instant Response (100ms):** Displays custom tooltip smoothly after 100ms hover/focus instead of waiting 1.5s for OS native tooltips.
> 2. **Consistent Glassmorphism UI:** Matches extension dark glassmorphism theme (`rgba(15, 23, 42, 0.95)` background, `backdrop-filter: blur(8px)`, 1px border, 11px medium font).
> 3. **E2E Test Compatibility:** Retains `title` attribute alongside `data-tooltip` so all Playwright `toHaveAttribute('title')` test assertions pass.

---

## Proposed Changes

### Styling & Theme

#### [MODIFY] [theme.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/theme.css)
- Add CSS rule for `[data-tooltip]`:
  - `::after` for tooltip bubble.
  - `::before` for tooltip arrow.
  - Support `data-tooltip-pos="bottom"` for top-row buttons.

### Components & Views

#### [MODIFY] [AudioExportButton.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/components/AudioExportButton.tsx)
- Add `data-tooltip={label}` to `<button className="audio-export-button">`.

#### [MODIFY] [PlaybackControlButton.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/components/PlaybackControlButton.tsx)
- Add `data-tooltip={label}` to `<button className="btn-playpause">`.

#### [MODIFY] [App.tsx (Popup)](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx)
- Add `data-tooltip` to Sidepanel toggle button, Play/Pause button, Stop button.

#### [MODIFY] [App.tsx (Sidepanel)](file:///Users/bez/Workspace/repos/bez/readit.dev/src/sidepanel/App.tsx)
- Add `data-tooltip` to Play/Pause button, Stop button.

---

## Verification Plan

### Automated Tests
- Build extension: `pnpm build`
- Unit tests: `XDG_CONFIG_HOME=/tmp pnpm test:unit`
- E2E tests: `XDG_CONFIG_HOME=/tmp pnpm test:e2e tests/e2e/tts-controls.spec.ts tests/e2e/side-panel.spec.ts`

### Manual Verification
- Hover over Play, Pause, Stop, MP3 Export, Side Panel buttons.
- Confirm tooltips appear instantly with sleek design.
