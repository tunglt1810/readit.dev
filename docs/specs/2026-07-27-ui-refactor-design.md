# Design Specification: Popup & Side Panel UI Refactoring

## 1. Overview
This specification details the complete UI refactoring for the Chrome Extension's Popup and Side Panel interfaces to improve visual hierarchy, consistency, theme accuracy, instant tooltip feedback, and real-time side panel toggle button state management, as well as extracting locale strings from `src/shared/constants.ts` into dedicated JSON translation files.

## 2. Key Changes

### 2.1. Extract Translations from constants.ts into JSON Locale Files
- **Location**: Move `THEME_TRANSLATIONS` out of `src/shared/constants.ts`.
- **Target Files**:
  - `src/shared/locales/vi.json`
  - `src/shared/locales/en.json`
- **Integration**: Update `src/shared/i18n.ts` to import `vi.json` and `en.json` directly, keeping strong TypeScript key safety (`keyof typeof en`). Added `"closeSidePanel"` locale keys for toggle button states.

### 2.2. Popup Side Panel Toggle Button & Real-time State Tracking
- **Location**: Repositioned from the bottom action buttons group into the right side of the top `status-display` badge.
- **Layout**: `status-display` is updated to a flex container containing status indicators on the left and the side panel icon button on the right.
- **Toggle State Synchronization**:
  - A long-lived `sidepanel-port` connection tracks active side panel instances per `windowId`.
  - When open for the active window: `aria-pressed="true"`, `.active` class with teal brand glow (`var(--gradient-brand)`), and dynamic tooltip `t('closeSidePanel')` ("Close side panel" / "Đóng side panel"). Clicking sends a request to close the side panel (`window.close()`).
  - When closed: `aria-pressed="false"`, tooltip `t('openSidePanel')` ("Open side panel" / "Mở side panel"). Clicking opens the side panel.
- **Instant Tooltip Feedback**:
  - Hovering over `.btn-icon-sidepanel` immediately reveals a CSS zero-delay (< 50ms) glassmorphism tooltip via `data-tooltip` attribute and `::after` pseudo-element.

### 2.3. Unified Control Box & Side Panel Player Alignment (1:1 with Popup)
- **Shared Playback Controls Component**:
  - `PlaybackIcon.tsx`: Shared vector SVG icons for play/pause/resume/stop/sidepanel.
  - `PlaybackControlButton.tsx`: Reusable circular primary playback button with active/stop state handling, correct tooltips, and ARIA labels.
- **Top Main Cards Layout**:
  - The Control Box (Metadata `Paragraph X/Y • Z%`, progress bar, and centered circular 52px Play/Pause + Stop controls) is embedded directly inside `.current-page-card` (for web reading) and `.manual-text-card` (for manual reading) at the top of the Side Panel.
  - The standalone bottom sticky section (`.side-panel-player`) is completely removed, establishing 1:1 layout alignment between Popup and Side Panel.

### 2.4. Modern Theme Gradient & Speed Constant Alignment
- **Modern Theme Colors**: `--gradient-brand` and `--gradient-brand-hover` transition cleanly from Teal (`#008771`) to Cyan (`#088195`), eliminating royal blue Vista colors.
- **Default Speed Alignment**: `DEFAULT_SPEED = 1.05` exported as a single source of truth in `src/shared/constants.ts` and shared across Popup, Side Panel, and Background.

## 3. Component Architecture
```
src/
├── shared/
│   ├── locales/
│   │   ├── vi.json
│   │   └── en.json
│   ├── components/
│   │   ├── PlaybackIcon.tsx          (Shared SVG playback & side panel icons)
│   │   ├── PlaybackControlButton.tsx (Reusable circular play/stop button)
│   │   └── SettingsCard.tsx
│   ├── constants.ts                  (Exports DEFAULT_SPEED = 1.05)
│   └── i18n.ts
├── popup/
│   ├── App.tsx                       (Status row with side panel toggle & instant tooltip)
│   └── popup.css
└── sidepanel/
    ├── App.tsx                       (Integrated top control box inside page & manual cards)
    └── sidepanel.css
```

## 4. Localization Strategy
- Translation dictionary moved from TS constants to `src/shared/locales/{vi,en}.json`.
- All tooltip text, ARIA labels, button titles, and `data-tooltip` use `t(...)` from `src/shared/i18n.ts`.
- Supported languages: English (`en`) and Vietnamese (`vi`).
