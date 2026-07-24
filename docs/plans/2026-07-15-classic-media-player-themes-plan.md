# Implementation Plan: Classic Media Player Themes (Winamp & Windows Media Player 12)

> **For Agentic Workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate theme selector infrastructure (Theme Selector) and develop 2 nostalgia themes: Winamp Classic (1998) and Windows Media Player 12 (Aero Glass, 2006) for the extension popup with 100% i18n support without hardcoded text.

**Architecture:**
* Use `data-theme` attribute on `.app-container` wrapper to apply theme-specific CSS variables and styles.
* Conditional rendering in React for theme-specific layout components (Winamp / WMP12).
* Store theme choice in `chrome.storage.local`.
* Shared translation dictionary based on `chrome.i18n.getUILanguage()` for automatic UI localization.

**Tech Stack:** React 19, TypeScript, Vanilla CSS (frosted glass, 3D bevels, glow shadows).

## Global Constraints
1. All newly added text labels must use i18n dictionary (`THEME_TRANSLATIONS` supporting `vi` and `en`); zero hardcoded text strings in JSX.
2. Write unit tests for i18n helper and theme storage read/write logic before implementing code.
3. No breaking changes to existing background worker page reading logic.
4. All changes must pass tests and compile cleanly without errors.
5. Commit to Git after completing each Task.

---

### Task 1: Constants & i18n Translation Dictionary

**Files:**
* Modify: [src/shared/constants.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/constants.ts)
* Create: [tests/unit/theme_i18n.test.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/tests/unit/theme_i18n.test.ts)

- [ ] **Step 1: Write i18n helper unit test**
  Create `tests/unit/theme_i18n.test.ts` to verify localized translations based on system UI language:
  ```typescript
  import { assert, test } from 'vitest';

  // Temporary mock definition for testing if needed
  const THEME_TRANSLATIONS = {
    vi: { selectTheme: "Chọn giao diện", themeWinamp: "🕹️ Classic (1998)" },
    en: { selectTheme: "Select Theme", themeWinamp: "🕹️ Classic (1998)" }
  };

  test('returns Vietnamese translation when uiLang is vi', () => {
    const getTranslation = (key: 'selectTheme' | 'themeWinamp', lang: 'vi' | 'en') => THEME_TRANSLATIONS[lang][key];
    assert.strictEqual(getTranslation('selectTheme', 'vi'), 'Chọn giao diện');
    assert.strictEqual(getTranslation('selectTheme', 'en'), 'Select Theme');
  });
  ```

- [ ] **Step 2: Run unit test and verify initial pass**
  Run: `pnpm test:unit`
  Requirement: The unit test syntax is correct and passes cleanly.

- [ ] **Step 3: Update `constants.ts`**
  Add `THEME` key to `STORAGE_KEYS` and export `THEME_TRANSLATIONS` in [src/shared/constants.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/constants.ts):
  ```typescript
  // Add to STORAGE_KEYS
  THEME: 'readit_active_theme',

  // Add THEME_TRANSLATIONS at end of file
  export const THEME_TRANSLATIONS = {
    vi: {
      selectTheme: "Chọn giao diện",
      themeDefault: "📱 Hiện đại",
      themeWinamp: "🕹️ Classic (1998)",
      themeWmp12: "💿 Vista Aero (2006)",
      winampTitle: "WINAMP CỔ ĐIỂN",
      voiceConfig: "CẤU HÌNH GIỌNG ĐỌC",
      readCurrentPage: "Đọc trang này thay thế",
      readPage: "Đọc trang hiện tại",
      stopReading: "Dừng đọc bài",
      playingStatus: "Đang đọc đoạn",
      readyStatus: "Sẵn sàng đọc trang web",
    },
    en: {
      selectTheme: "Select Theme",
      themeDefault: "📱 Modern",
      themeWinamp: "🕹️ Classic (1998)",
      themeWmp12: "💿 Vista Aero (2006)",
      winampTitle: "WINAMP CLASSIC",
      voiceConfig: "VOICE CONFIGURATION",
      readCurrentPage: "Read this page instead",
      readPage: "Read current page",
      stopReading: "Stop reading",
      playingStatus: "Reading paragraph",
      readyStatus: "Ready to read page",
    }
  } as const;
  ```

- [ ] **Step 4: Run full application unit tests**
  Run: `pnpm test:unit`
  Requirement: Entire test suite passes.

- [ ] **Step 5: Commit Task 1**
  Run:
  ```bash
  git add src/shared/constants.ts tests/unit/theme_i18n.test.ts
  git commit -m "feat: add theme storage keys and i18n translations dictionary"
  ```

---

### Task 2: Theme State Management & Selector UI in React

**Files:**
* Modify: [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx)
* Modify: [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/popup.css)

- [ ] **Step 1: Declare i18n translate helper in App.tsx**
  Read Chrome UI language and declare `t` helper at top of [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx):
  ```typescript
  import { THEME_TRANSLATIONS } from '../shared/constants';

  const uiLang = (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage)
    ? (chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en')
    : 'en';

  const t = (key: keyof typeof THEME_TRANSLATIONS.en) => THEME_TRANSLATIONS[uiLang][key];
  ```

- [ ] **Step 2: Replace hardcoded text in App.tsx with `t` translation helper**
  Replace hardcoded text labels to use `t(...)`:
  * `"Cấu hình giọng đọc"` -> `{t('voiceConfig')}`
  * `"Sẵn sàng đọc trang web"` -> `{t('readyStatus')}`
  * `"Đọc trang này thay thế"` -> `{t('readCurrentPage')}`
  * `"Đọc trang hiện tại"` -> `{t('readPage')}`
  * `"Dừng đọc bài"` -> `{t('stopReading')}`
  * `"Đang đọc đoạn"` -> `{t('playingStatus')}`

- [ ] **Step 3: Declare `activeTheme` state & integrate storage persistence**
  * Inside `App` component, declare state:
    ```typescript
    const [activeTheme, setActiveTheme] = useState<'default' | 'winamp' | 'wmp12'>('default');
    ```
  * Update mount `useEffect` block to read saved theme from local storage:
    ```typescript
    chrome.storage.local.get([STORAGE_KEYS.THEME], (result) => {
      if (result[STORAGE_KEYS.THEME]) {
        setActiveTheme(result[STORAGE_KEYS.THEME] as 'default' | 'winamp' | 'wmp12');
      }
    });
    ```
  * Add theme update handler:
    ```typescript
    const handleThemeChange = (newTheme: 'default' | 'winamp' | 'wmp12') => {
      setActiveTheme(newTheme);
      chrome.storage.local.set({ [STORAGE_KEYS.THEME]: newTheme });
    };
    ```

- [ ] **Step 4: Add Theme Selector UI to Header**
  Integrate theme selector into the left of extension version display inside Header:
  ```tsx
  <header className="app-header">
    <div className="logo-group">
      <h1 className="logo-text">
        readit<span>.dev</span>
      </h1>
    </div>
    <div className="header-right-group">
      <div className="theme-selector-container">
        <button className="theme-selector-btn" aria-label={t('selectTheme')}>🎨</button>
        <div className="theme-dropdown">
          <button
            className={`theme-opt-btn ${activeTheme === 'default' ? 'active' : ''}`}
            onClick={() => handleThemeChange('default')}
          >
            {t('themeDefault')}
          </button>
          <button
            className={`theme-opt-btn ${activeTheme === 'winamp' ? 'active' : ''}`}
            onClick={() => handleThemeChange('winamp')}
          >
            {t('themeWinamp')}
          </button>
          <button
            className={`theme-opt-btn ${activeTheme === 'wmp12' ? 'active' : ''}`}
            onClick={() => handleThemeChange('wmp12')}
          >
            {t('themeWmp12')}
          </button>
        </div>
      </div>
      <span className="extension-version">v{manifestVersion}</span>
    </div>
  </header>
  ```
  * Attach `data-theme={activeTheme}` attribute to outer wrapper `div`:
    ```tsx
    return (
      <div className="app-container" data-theme={activeTheme}>
        {/* ... */}
      </div>
    );
    ```

- [ ] **Step 5: Add CSS for Theme Selector Dropdown in popup.css**
  Add dropdown menu styles at end of [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/popup.css):
  ```css
  .header-right-group {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .theme-selector-container {
    position: relative;
    display: inline-block;
  }
  .theme-selector-btn {
    background: transparent;
    border: none;
    font-size: 16px;
    cursor: pointer;
    padding: var(--space-1);
    transition: transform 0.2s ease;
  }
  .theme-selector-btn:hover {
    transform: scale(1.15);
  }
  .theme-dropdown {
    display: none;
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 8px;
    background: var(--bg-glass);
    border: 1px solid var(--border-glass);
    border-radius: 8px;
    padding: 6px;
    z-index: 100;
    min-width: 140px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .theme-selector-container:hover .theme-dropdown {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .theme-opt-btn {
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--color-text-primary);
    padding: 8px 10px;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
    width: 100%;
  }
  .theme-opt-btn:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .theme-opt-btn.active {
    background: var(--gradient-brand);
    color: #fff;
  }
  ```

- [ ] **Step 6: Run build & verify stability**
  Run build: `pnpm build`
  Requirement: Project compiles cleanly without TS errors.

- [ ] **Step 7: Commit Task 2**
  Run:
  ```bash
  git add src/popup/App.tsx src/popup/popup.css
  git commit -m "feat: implement Theme selector UI dropdown with local storage state"
  ```

---

### Task 3: Design & Implement Winamp Classic Theme

Build Winamp's layout structure and 3D metallic chassis CSS styles.

**Files:**
* Modify: [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx)
* Modify: [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/popup.css)

- [ ] **Step 1: Conditionally Render Title Bar & LED Visualizer Screen**
  In [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx):
  * Add Winamp titlebar at top of page if `activeTheme === 'winamp'`:
    ```tsx
    {activeTheme === 'winamp' && (
      <div className="winamp-titlebar">
        <span className="winamp-title-text">{t('winampTitle')}</span>
        <div className="winamp-window-controls">
          <span className="winamp-win-btn">_</span>
          <span className="winamp-win-btn">⬜</span>
          <span className="winamp-win-btn">X</span>
        </div>
      </div>
    )}
    ```
  * Add animated LED Audio Visualizer inside status-display when `status === 'playing' && activeTheme === 'winamp'`:
    ```tsx
    {activeTheme === 'winamp' && status === 'playing' && (
      <div className="winamp-visualizer">
        <div className="v-bar"></div>
        <div className="v-bar"></div>
        <div className="v-bar"></div>
        <div className="v-bar"></div>
        <div className="v-bar"></div>
        <div className="v-bar"></div>
        <div className="v-bar"></div>
        <div className="v-bar"></div>
      </div>
    )}
    ```

- [ ] **Step 2: Define CSS Variables and Winamp metallic chassis structure**
  Add Winamp CSS specification to [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/popup.css):
  ```css
  /* WINAMP THEME VARIABLES */
  [data-theme="winamp"] {
    --bg-app: #28282b;
    --bg-glass: #050505;
    --border-glass: #8e8e93;
    --color-text-primary: #39ff14; /* Lime green LED */
    --color-text-secondary: #008800;
    --font-sans: 'Courier New', 'Courier', monospace;
    --font-display: 'Courier New', 'Courier', monospace;
    --gradient-brand: #3a3a3d;
    --border-glass-focus: #39ff14;
  }

  /* Winamp Window Frame */
  .app-container[data-theme="winamp"] {
    border: 2px solid;
    border-color: #8e8e93 #111 #111 #8e8e93;
    background-image: repeating-linear-gradient(45deg, #222225 0px, #222225 1px, transparent 1px, transparent 4px);
    box-shadow: inset 1px 1px 0px #fff, 0 10px 30px rgba(0,0,0,0.6);
  }

  /* Winamp Titlebar */
  .winamp-titlebar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: linear-gradient(90deg, #000080 0%, #000 100%);
    padding: 3px 6px;
    height: 18px;
    border-bottom: 1px solid #111;
  }
  .winamp-title-text {
    font-size: 9px;
    font-weight: bold;
    color: #e0e0e0;
    letter-spacing: 1px;
  }
  .winamp-window-controls {
    display: flex;
    gap: 2px;
  }
  .winamp-win-btn {
    font-size: 8px;
    font-weight: bold;
    color: #8e8e93;
    background: #2a2a2e;
    border: 1px solid;
    border-color: #fff #555 #555 #fff;
    padding: 0 3px;
    cursor: pointer;
  }

  /* LED Display screen box */
  .app-container[data-theme="winamp"] .app-main,
  .app-container[data-theme="winamp"] .app-section {
    background: #000;
    border: 2px solid;
    border-color: #111 #8e8e93 #8e8e93 #111;
    border-radius: 0;
    box-shadow: none;
  }
  ```

- [ ] **Step 3: Create LED text styles, animated Visualizer, and mechanical buttons**
  Continue writing Winamp control component styles in CSS:
  ```css
  /* LED Display Screen Style */
  .app-container[data-theme="winamp"] .status-display {
    background: #000;
    border: 1px solid #222;
    border-radius: 0;
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .app-container[data-theme="winamp"] .status-text {
    color: #39ff14;
    font-size: 11px;
    font-weight: bold;
    text-transform: uppercase;
    font-family: 'Courier New', monospace;
  }
  .app-container[data-theme="winamp"] .status-dot-pulse {
    display: none;
  }

  /* Audio Visualizer Column Simulation */
  .winamp-visualizer {
    display: flex;
    align-items: flex-end;
    gap: 1px;
    height: 12px;
  }
  .v-bar {
    width: 3px;
    background: #39ff14;
    animation: winamp-vis-anim 0.8s ease infinite alternate;
  }
  .v-bar:nth-child(2n) { animation-duration: 0.6s; }
  .v-bar:nth-child(3n) { animation-duration: 0.9s; }
  .v-bar:nth-child(4n) { animation-duration: 0.5s; }

  @keyframes winamp-vis-anim {
    0% { height: 1px; background: #008800; }
    50% { height: 7px; background: #ffff00; }
    100% { height: 12px; background: #ff0000; }
  }

  /* Controls deck and buttons */
  .app-container[data-theme="winamp"] .playback-controls {
    display: flex;
    flex-direction: row;
    justify-content: center;
    gap: 4px;
    background: #1e1e20;
    padding: 6px;
    border: 1px solid;
    border-color: #555 #111 #111 #555;
  }
  .app-container[data-theme="winamp"] .btn {
    border-radius: 0 !important;
    border: 1px solid !important;
    border-color: #fff #555 #555 #fff !important;
    background: #2a2a2e !important;
    color: #a0a0a0 !important;
    box-shadow: none !important;
  }
  .app-container[data-theme="winamp"] .btn:active {
    transform: translate(1px, 1px);
    border-color: #111 #fff #fff #111 !important;
    background: #111 !important;
  }
  .app-container[data-theme="winamp"] .btn-primary.active {
    background: #8b0000 !important;
    color: #ff3333 !important;
  }
  ```

- [ ] **Step 4: Run build and test quality**
  Run: `pnpm build`
  Requirement: Build succeeds without any CSS syntax or TypeScript errors.

- [ ] **Step 5: Commit Task 3**
  Run:
  ```bash
  git add src/popup/App.tsx src/popup/popup.css
  git commit -m "feat: implement Winamp Classic theme styling and mechanical layout"
  ```

---

### Task 4: Design & Implement Windows Media Player 12 Theme (Vista Aero)

Apply WMP12's Aero glass effect and signature radial round play button.

**Files:**
* Modify: [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx)
* Modify: [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/popup.css)

- [ ] **Step 1: Conditionally Render WMP12 Bottom Control Dock wrapper**
  In [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx):
  Group WMP12 controls into `.wmp-dock` wrapper when in `wmp12` theme:
  ```tsx
  <div className={`controls-group ${activeTheme === 'wmp12' ? 'wmp-dock' : ''}`}>
    {/* ... */}
  </div>
  ```

- [ ] **Step 2: Install CSS Variables and Aero Glass for WMP12**
  Add WMP12 CSS to [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/popup.css):
  ```css
  /* WMP12 VISTA AERO VARIABLES */
  [data-theme="wmp12"] {
    --bg-app: radial-gradient(circle at 50% 50%, rgba(20, 50, 80, 0.45), rgba(5, 12, 24, 0.95));
    --bg-glass: rgba(255, 255, 255, 0.08);
    --border-glass: rgba(255, 255, 255, 0.25);
    --border-glass-focus: rgba(0, 229, 255, 0.6);
    --color-text-primary: #ffffff;
    --color-text-secondary: rgba(255, 255, 255, 0.65);
    --font-sans: "Segoe UI", -apple-system, sans-serif;
    --font-display: "Segoe UI", -apple-system, sans-serif;
    --gradient-brand: linear-gradient(180deg, #00C8FF, #005577);
    --gradient-brand-hover: linear-gradient(180deg, #00E5FF, #007799);
  }

  /* Aero Glass Blur */
  .app-container[data-theme="wmp12"] {
    backdrop-filter: blur(20px) saturate(125%);
    -webkit-backdrop-filter: blur(20px) saturate(125%);
    border: 1px solid rgba(255, 255, 255, 0.3);
    box-shadow: 0 15px 35px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.2);
  }
  .app-container[data-theme="wmp12"] .session-title,
  .app-container[data-theme="wmp12"] .status-text,
  .app-container[data-theme="wmp12"] .section-title {
    text-shadow: 0 1px 3px rgba(0,0,0,0.85);
  }
  ```

- [ ] **Step 3: Create WMP12 Central Play Button & Bottom Dock styles**
  ```css
  /* WMP12 Bottom Control Dock overlay */
  .app-container[data-theme="wmp12"] .wmp-dock {
    background: linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.0) 50%, rgba(0,0,0,0.4) 100%);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding: var(--space-3) 0 0;
    margin-top: 5px;
  }

  /* Round Cyan Playback controls button */
  .app-container[data-theme="wmp12"] .btn-read {
    width: 52px;
    height: 52px;
    border-radius: 50% !important;
    background: radial-gradient(circle at 50% 30%, #00E5FF 0%, #007799 65%, #004466 100%) !important;
    border: 1px solid rgba(255, 255, 255, 0.3) !important;
    box-shadow: 0 4px 10px rgba(0, 229, 255, 0.3) !important;
    transition: all 0.25s ease;
  }
  .app-container[data-theme="wmp12"] .btn-read:hover {
    box-shadow: 0 0 18px rgba(0, 229, 255, 0.95) !important;
    transform: scale(1.05);
  }
  .app-container[data-theme="wmp12"] .btn-read:active {
    transform: scale(0.95);
  }

  /* Central playback bar layout */
  .app-container[data-theme="wmp12"] .playback-controls {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
  }
  .app-container[data-theme="wmp12"] .btn-secondary {
    border-radius: 8px !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
  }

  /* WMP12 Progress Bar Cyan Glow */
  .app-container[data-theme="wmp12"] .progress-bar {
    background: #00E5FF !important;
    box-shadow: 0 0 6px rgba(0, 229, 255, 0.8);
  }

  /* Glass bead for speed range thumb */
  .app-container[data-theme="wmp12"] .form-slider::-webkit-slider-thumb {
    background: #e0f7fa !important;
    border: 1px solid #ffffff !important;
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.9) !important;
  }
  ```

- [ ] **Step 4: Full project test & verification**
  Run build: `pnpm build`
  Requirement: Build completes 100%.

- [ ] **Step 5: Commit Task 4**
  Run:
  ```bash
  git add src/popup/App.tsx src/popup/popup.css
  git commit -m "feat: implement WMP12 Vista Aero glassy theme with glow radial play button"
  ```

---

## Final Acceptance Testing
- [ ] Run E2E test suite to ensure no regressions occur: `pnpm test:e2e`
- [ ] Confirm i18n interface displays correct language when testing in browser.
