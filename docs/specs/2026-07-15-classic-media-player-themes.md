# Classic Media Player Themes Design Specification (Winamp & Windows Media Player 12)

This specification details the theme system architecture for the `readit.dev` Chrome extension, introducing two nostalgia themes: Winamp Classic (1998) and Windows Media Player 12 (Windows Vista Aero, 2006).

---

## 1. State & Storage Management

### New Storage Key
* **Key:** `readit_active_theme`
* **Defined in:** [src/shared/constants.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/constants.ts)
* **Valid Values:** `'default' | 'winamp' | 'wmp12'`
* **Behavior:** Stores user theme selection in `chrome.storage.local`. Upon popup mount, the extension reads this key to render the selected theme.

### React DOM Structure Changes
* Wraps the top-level app element with a `data-theme` attribute:
  ```tsx
  <div className="app-container" data-theme={activeTheme}>
  ```

### 1.2. Internationalization (i18n Localization)
To ensure all newly added text labels are not hardcoded and fully support i18n, a static local translation dictionary (Localization Dictionary) is defined directly in the popup or shared helpers:

* **Translation Dictionary:**
  ```typescript
  const THEME_TRANSLATIONS = {
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
  };
  ```

* **Translation Helper (t):**
  ```typescript
  const uiLang = (chrome.i18n.getUILanguage?.() || navigator.language || 'en').startsWith('vi') ? 'vi' : 'en';
  const t = (key: keyof typeof THEME_TRANSLATIONS.en) => THEME_TRANSLATIONS[uiLang][key];
  ```

---

## 2. Theme Selector UI

The theme selector is located in the bottom Settings row in [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx), positioned after the text selection and word highlight toggles, outside the Header. This item remains visible across all three themes so users using WMP12 can select a different theme.

* **HTML Structure:**
  ```tsx
  <div className="theme-selector">
    <button className="theme-btn active-theme-indicator" aria-label={t('selectTheme')}>🎨</button>
    <div className="theme-dropdown-menu">
      <button onClick={() => selectTheme('default')} className={activeTheme === 'default' ? 'active' : ''}>{t('themeDefault')}</button>
      <button onClick={() => selectTheme('winamp')} className={activeTheme === 'winamp' ? 'active' : ''}>{t('themeWinamp')}</button>
      <button onClick={() => selectTheme('wmp12')} className={activeTheme === 'wmp12' ? 'active' : ''}>{t('themeWmp12')}</button>
    </div>
  </div>
  ```
* **Additional CSS:** The dropdown menu is hidden by default and toggles open/closed via the palette button 🎨 or keyboard interaction. The dropdown background must be opaque without opacity or backdrop blur to ensure legibility across all themes.

---

## 3. Winamp Classic Theme Specification (Retro Player 1998)

When `data-theme="winamp"`, the interface switches to a 3D mechanical chassis texture and signature LED display screen:

### 3.1. Colors & Metallic Textures (CSS Variables)
```css
[data-theme="winamp"] {
  --bg-app: #28282b; /* Dark metallic grey */
  --bg-glass: #1c1c1f; /* Inner dark box */
  --border-glass: #8e8e93; /* Highlight bevel edge */
  --color-text-primary: #00e600; /* Primary fluorescent green LED text */
  --color-text-secondary: #008800; /* Dark green background LED text */
  --font-sans: 'Courier New', 'Courier', monospace;
  --font-display: 'Courier New', 'Courier', monospace;
}
```

### 3.2. Window Frame & Title Bar Enhancements
* **Popup Frame:** Adds double-line 3D raised bevel borders (`border: 2px solid; border-color: #8e8e93 #111 #111 #8e8e93`).
* **Chassis Texture:** Uses an ultra-fine 45-degree diagonal stripe `background-image` for empty panel areas to simulate rugged metallic texture.
* **Simulated Title Bar:**
  * Top window bar with dark blue gradient `#000080` to black `#000000`.
  * Silver text `WINAMP` on the left and pixel window control buttons on the right.

### 3.3. Digital LED Display Screen
* Playback status and paragraph metadata are merged into a sunken black container (`#000000`).
* Fluorescent green uppercase text (`text-transform: uppercase`).
* **Visualizer Effect:** 8 vertical bars animated via CSS keyframes simulating audio frequency meters during playback (`playing`).

### 3.4. Mechanical Deck Horizontal Controls
* Changes `.playback-controls` layout to a horizontal strip: `flex-direction: row; gap: 4px; pack: center;`.
* **Mechanical Buttons:** Beveled rectangular grey buttons.
* **Button Symbols:**
  * Read/Resume button: Green fluorescent triangle `▶`
  * Pause button: Yellow double bar `‖`
  * Stop button: Red square `■`
* Active button press (`:active`) shifts 1px down and right (`transform: translate(1px, 1px)`) with inverted bevel borders (`border-color: #111 #8e8e93 #8e8e93 #111`).

### 3.5. Speed Control & Progress Bar
* **Progress Bar:** Deep recessed black groove displaying progress via tightly stacked vertical green LED bars.
* **Speed Slider:** Mechanical vertical EQ slider with a silver square slider knob and black border.

---

## 4. Windows Media Player 12 Theme Specification (Vista Aero 2006)

When `data-theme="wmp12"`, the interface switches to a translucent glass style of the Windows Aero era:

### 4.1. Colors & Glass Refraction Effects (CSS Variables)
```css
[data-theme="wmp12"] {
  --bg-app: radial-gradient(circle at 50% 50%, rgba(16, 46, 75, 0.4), rgba(4, 10, 20, 0.95));
  --bg-glass: rgba(255, 255, 255, 0.08);
  --border-glass: rgba(255, 255, 255, 0.2);
  --border-glass-focus: rgba(0, 229, 255, 0.6);
  --color-text-primary: #ffffff;
  --color-text-secondary: rgba(255, 255, 255, 0.6);
  --font-sans: "Segoe UI", -apple-system, sans-serif;
  --font-display: "Segoe UI", -apple-system, sans-serif;
}
```

### 4.2. Aero Glass Effect Setup
* **Popup Container:** Applies `backdrop-filter: blur(20px) saturate(125%)` for frosted glass depth filtering.
* Double refractive border: outer border `rgba(255, 255, 255, 0.25)` and inner highlight line `rgba(255, 255, 255, 0.15)`.
* Text drop shadows (`text-shadow: 0 1px 3px rgba(0,0,0,0.8)`) for legibility across glass backgrounds.

### 4.3. Glossy Bottom Control Dock
* Bottom section renders a fixed-height glossy blue-grey container.
* **Center Play/Pause Button:**
  * 52px x 52px circular button.
  * 3D radial gradient: `background: radial-gradient(circle at 50% 30%, #00E5FF 0%, #007799 65%, #004466 100%)`.
  * Silver metallic outer ring.
  * Cyan glow effect on hover (`box-shadow: 0 0 16px rgba(0, 229, 255, 0.85)`).
* Square grey **Stop** button situated beside the main transport control.

### 4.4. Progress Bar & Speed Slider
* **Progress Bar:** Translucent frosted track with cyan progress fill.
* **Speed Slider:** Glossy translucent cyan glass thumb.

---

## 5. Verification Plan

### Visual Verification
1. Verify complete CSS variable shifts across Default, Winamp, and WMP12 themes.
2. Confirm theme signature effects:
   - Winamp: 3D mechanical bevels, green LED monospace text, 1px active button press.
   - WMP12: Aero glass blur, cyan Play glow, white text drop shadow.
3. Confirm layout dimensions remain bounded within popup dimensions (width 360px, min height 480px) without overflow.

### Functional Verification
1. Verify storage persistence in `chrome.storage.local`.
2. Confirm Play/Pause/Stop playback triggers execute correctly across all themes.
3. Confirm speed slider updates propagate correctly to the service worker.
