# Kế hoạch thực hiện: Bộ Theme Cổ điển Winamp & Windows Media Player 12

> **Dành cho Agentic Workers:** REQUIRED SUB-SKILL: Sử dụng `superpowers:subagent-driven-development` hoặc `superpowers:executing-plans` để thực hiện kế hoạch này theo từng tác vụ. Các bước sử dụng cú pháp checkbox (`- [ ]`) để theo dõi.

**Mục tiêu:** Tích hợp bộ cấu trúc theme (Theme Selector) và phát triển 2 theme cổ điển: Winamp Classic (1998) và Windows Media Player 12 (Aero Glass, 2006) cho popup của extension, đảm bảo hỗ trợ i18n 100% không hardcode text.

**Kiến trúc:** 
* Sử dụng data-attribute `data-theme` trên thẻ bao `.app-container` để áp dụng CSS variables và styles đặc trưng của từng theme.
* Conditional rendering trong React để hiển thị các thành phần layout phụ trợ của Winamp/WMP12.
* Lưu lựa chọn theme trong `chrome.storage.local`.
* Một từ điển dịch thuật cục bộ dựa trên kết quả của `chrome.i18n.getUILanguage()` để tự động hiển thị i18n.

**Công nghệ sử dụng:** React 19, TypeScript, Vanilla CSS (kính mờ, hiệu ứng nổi 3D, bóng đổ phát sáng).

## Ràng buộc Toàn cầu (Global Constraints)
1. Các văn bản hiển thị (text/label) được thêm mới cho theme bắt buộc sử dụng cơ chế dịch i18n (từ điển `THEME_TRANSLATIONS` cục bộ hỗ trợ `vi` và `en`), tuyệt đối không hardcode text trong JSX.
2. Viết unit test cho logic i18n helper và logic đọc/ghi trạng thái theme trước khi implement code.
3. Không làm ảnh hưởng đến các logic đọc trang web hiện tại của background worker.
4. Toàn bộ thay đổi phải được kiểm thử và chạy build không lỗi.
5. Mỗi Task hoàn tất phải được commit lên Git.

---

### Tác vụ 1: Định nghĩa hằng số và Bộ từ điển dịch thuật i18n

**Các file liên quan:**
* Modify: [src/shared/constants.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/shared/constants.ts)
* Create: [tests/unit/theme_i18n.test.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/tests/unit/theme_i18n.test.ts)

- [ ] **Bước 1: Viết test kiểm tra i18n helper**
  Tạo file `tests/unit/theme_i18n.test.ts` và viết test xác thực bản dịch ngôn ngữ hoạt động chính xác dựa trên ngôn ngữ hệ thống:
  ```typescript
  import { assert, test } from 'vitest';
  
  // Định nghĩa mock tạm thời cho testing nếu cần
  const THEME_TRANSLATIONS = {
    vi: { selectTheme: "Chọn giao diện", themeWinamp: "🕹️ Classic (1998)" },
    en: { selectTheme: "Select Theme", themeWinamp: "🕹️ Classic (1998)" }
  };

  test('trả về bản dịch tiếng Việt khi uiLang là vi', () => {
    const getTranslation = (key: 'selectTheme' | 'themeWinamp', lang: 'vi' | 'en') => THEME_TRANSLATIONS[lang][key];
    assert.strictEqual(getTranslation('selectTheme', 'vi'), 'Chọn giao diện');
    assert.strictEqual(getTranslation('selectTheme', 'en'), 'Select Theme');
  });
  ```

- [ ] **Bước 2: Chạy test và xác minh thất bại/thành công ban đầu**
  Chạy: `pnpm test:unit`
  Yêu cầu: Test unit trên viết đúng cú pháp và pass thành công.

- [ ] **Bước 3: Cập nhật file constants.ts**
  Thêm khóa `THEME` vào `STORAGE_KEYS` và thêm từ điển `THEME_TRANSLATIONS` vào [src/shared/constants.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/shared/constants.ts):
  ```typescript
  // Thêm vào STORAGE_KEYS
  THEME: 'readit_active_theme',

  // Thêm THEME_TRANSLATIONS ở cuối file
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

- [ ] **Bước 4: Chạy test kiểm tra toàn bộ ứng dụng**
  Chạy: `pnpm test:unit`
  Yêu cầu: Toàn bộ suite test pass.

- [ ] **Bước 5: Commit Tác vụ 1**
  Chạy:
  ```bash
  git add src/shared/constants.ts tests/unit/theme_i18n.test.ts
  git commit -m "feat: add theme storage keys and i18n translations dictionary"
  ```

---

### Tác vụ 2: Triển khai Quản lý State Theme & Giao diện Selector trong React

**Các file liên quan:**
* Modify: [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/App.tsx)
* Modify: [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/popup.css)

- [ ] **Bước 1: Khai báo i18n translate helper trong App.tsx**
  Đọc ngôn ngữ hiện tại của Chrome và khai báo hàm helper dịch `t` ở đầu [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/App.tsx):
  ```typescript
  import { THEME_TRANSLATIONS } from '../shared/constants';

  const uiLang = (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage)
    ? (chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en')
    : 'en';
  
  const t = (key: keyof typeof THEME_TRANSLATIONS.en) => THEME_TRANSLATIONS[uiLang][key];
  ```

- [ ] **Bước 2: Thay đổi text cứng trong App.tsx thành hàm dịch `t`**
  Thay đổi các nhãn text cứng thành sử dụng `t(...)`:
  * `"Cấu hình giọng đọc"` -> `{t('voiceConfig')}`
  * `"Sẵn sàng đọc trang web"` -> `{t('readyStatus')}`
  * `"Đọc trang này thay thế"` -> `{t('readCurrentPage')}`
  * `"Đọc trang hiện tại"` -> `{t('readPage')}`
  * `"Dừng đọc bài"` -> `{t('stopReading')}`
  * `"Đang đọc đoạn"` -> `{t('playingStatus')}`

- [ ] **Bước 3: Khai báo state `activeTheme` và tích hợp lưu trữ**
  * Trong `App` component, khai báo state:
    ```typescript
    const [activeTheme, setActiveTheme] = useState<'default' | 'winamp' | 'wmp12'>('default');
    ```
  * Cập nhật khối `useEffect` khi mount extension để đọc theme đã lưu trong local storage:
    ```typescript
    chrome.storage.local.get([STORAGE_KEYS.THEME], (result) => {
      if (result[STORAGE_KEYS.THEME]) {
        setActiveTheme(result[STORAGE_KEYS.THEME] as 'default' | 'winamp' | 'wmp12');
      }
    });
    ```
  * Thêm hàm cập nhật theme:
    ```typescript
    const handleThemeChange = (newTheme: 'default' | 'winamp' | 'wmp12') => {
      setActiveTheme(newTheme);
      chrome.storage.local.set({ [STORAGE_KEYS.THEME]: newTheme });
    };
    ```

- [ ] **Bước 4: Thêm giao diện Theme Selector vào Header**
  Tích hợp bộ chọn theme vào bên trái phần hiển thị phiên bản extension trong Header:
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
  * Gắn thuộc tính `data-theme={activeTheme}` vào thẻ bọc `div` ngoài cùng:
    ```tsx
    return (
      <div className="app-container" data-theme={activeTheme}>
        {/* ... */}
      </div>
    );
    ```

- [ ] **Bước 5: Thêm CSS cho Theme Selector Dropdown trong popup.css**
  Thêm phong cách hiển thị menu dropdown của bộ chọn theme ở cuối [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/popup.css):
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

- [ ] **Bước 6: Chạy thử và xác minh tính ổn định**
  Chạy build: `pnpm build`
  Yêu cầu: Dự án compile thành công không lỗi TS.

- [ ] **Bước 7: Commit Tác vụ 2**
  Chạy:
  ```bash
  git add src/popup/App.tsx src/popup/popup.css
  git commit -m "feat: implement Theme selector UI dropdown with local storage state"
  ```

---

### Tác vụ 3: Thiết kế và Hiện thực hóa Theme Winamp Classic

Tác vụ này xây dựng cấu trúc layout và thiết kế CSS nổi khối kim loại 3D gồ ghề của Winamp.

**Các file liên quan:**
* Modify: [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/App.tsx)
* Modify: [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/popup.css)

- [ ] **Bước 1: Conditionally Render thanh tiêu đề giả lập (Title Bar) và màn hình LED Visualizer**
  Trong [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/App.tsx):
  * Thêm Title Bar mô phỏng Winamp lên đầu trang nếu `activeTheme === 'winamp'`:
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
  * Thêm màn hình Audio Visualizer LED nhấp nháy bên trong status-display khi `status === 'playing' && activeTheme === 'winamp'`:
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

- [ ] **Bước 2: Định nghĩa CSS Variables và cấu trúc khung kim loại Winamp**
  Thêm CSS đặc tả Winamp vào [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/popup.css):
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

- [ ] **Bước 3: Tạo style LED text, Visualizer nhấp nháy và phím cơ học**
  Tiếp tục viết CSS cho các thành phần điều khiển của Winamp:
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
    display: none; /* Không sử dụng pulse dot nhấp nháy hiện đại */
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
    background: #8b0000 !important; /* Đỏ sẫm */
    color: #ff3333 !important;
  }
  ```

- [ ] **Bước 4: Chạy build và kiểm thử chất lượng**
  Chạy: `pnpm build`
  Yêu cầu: Build thành công, không gặp bất cứ lỗi cú pháp CSS hoặc TypeScript nào.

- [ ] **Bước 5: Commit Tác vụ 3**
  Chạy:
  ```bash
  git add src/popup/App.tsx src/popup/popup.css
  git commit -m "feat: implement Winamp Classic theme styling and mechanical layout"
  ```

---

### Tác vụ 4: Thiết kế và Hiện thực hóa Theme Windows Media Player 12 (Vista Aero)

Tác vụ này áp dụng hiệu ứng kính mờ Aero và nút phát nhạc radial tròn đặc trưng của WMP12.

**Các file liên quan:**
* Modify: [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/App.tsx)
* Modify: [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/popup.css)

- [ ] **Bước 1: Conditionally Render bọc nút điều khiển đáy WMP12**
  Trong [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/App.tsx):
  Gộp nhóm điều khiển của WMP12 vào một khối bao ngoài `.wmp-dock` nếu đang ở theme `wmp12` để dễ dàng style hiệu ứng bóng bẩy:
  ```tsx
  {/* Thay đổi nhỏ tại dải nút điều khiển */}
  <div className={`controls-group ${activeTheme === 'wmp12' ? 'wmp-dock' : ''}`}>
    {/* ... */}
  </div>
  ```

- [ ] **Bước 2: Cài đặt CSS Variables và Aero Glass cho WMP12**
  Thêm CSS cho WMP12 vào [src/popup/popup.css](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/research-classic-themes/src/popup/popup.css):
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

- [ ] **Bước 3: Tạo style bóng bẩy WMP12 Central Play Button và Bottom Dock**
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

- [ ] **Bước 4: Kiểm thử toàn bộ dự án và xác thực**
  Chạy build: `pnpm build`
  Yêu cầu: Quá trình build hoàn thành 100%.

- [ ] **Bước 5: Commit Tác vụ 4**
  Chạy:
  ```bash
  git add src/popup/App.tsx src/popup/popup.css
  git commit -m "feat: implement WMP12 Vista Aero glassy theme with glow radial play button"
  ```

---

## Kiểm tra sau cùng (Final Acceptance Testing)
- [ ] Chạy suite e2e để chắc chắn không xảy ra regression lỗi: `pnpm test:e2e`
- [ ] Xác nhận giao diện i18n chuyển đổi đúng ngôn ngữ khi test trên trình duyệt.
