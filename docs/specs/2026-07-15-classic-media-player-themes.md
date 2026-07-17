# Tài liệu thiết kế: Bộ Theme Cổ điển Winamp & Windows Media Player 12 (Vista Aero)

Tài liệu này đặc tả chi tiết thiết kế hệ thống giao diện (Theme System) cho tiện ích mở rộng `readit.dev`, bổ sung hai giao diện hoài niệm: Winamp Classic (1998) và Windows Media Player 12 (Windows Vista Aero, 2006).

---

## 1. Lưu trữ và Quản lý Trạng thái (State & Storage)

### Khóa Storage mới
* **Key:** `readit_active_theme`
* **Vị trí định nghĩa:** [src/shared/constants.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/src/shared/constants.ts)
* **Giá trị hợp lệ:** `'default' | 'winamp' | 'wmp12'`
* **Hành vi:** Lưu trữ lựa chọn của người dùng trong `chrome.storage.local`. Khi mở popup, extension sẽ đọc giá trị này để tải giao diện tương ứng.

### Thay đổi cấu trúc DOM trong React
* Bọc phần tử ngoài cùng của ứng dụng bằng thuộc tính `data-theme`:
  ```tsx
  <div className="app-container" data-theme={activeTheme}>
  ```

### 1.2. Cơ chế Đa ngôn ngữ (i18n Localization)
Để đảm bảo tất cả các nhãn text mới không bị hardcode và hỗ trợ i18n, chúng ta sẽ định nghĩa một bản dịch tĩnh cục bộ (Localization Dictionary) ngay trong popup hoặc shared helpers:

* **Từ điển dịch thuật (Translation Dictionary):**
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

* **Helper dịch thuật (t):**
  ```typescript
  const uiLang = (chrome.i18n.getUILanguage?.() || navigator.language || 'en').startsWith('vi') ? 'vi' : 'en';
  const t = (key: keyof typeof THEME_TRANSLATIONS.en) => THEME_TRANSLATIONS[uiLang][key];
  ```

---

## 2. Giao diện Bộ chọn Theme (Theme Selector UI)

Bộ chọn theme sẽ được tích hợp ở góc trên bên phải của Header trong [src/popup/App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/src/popup/App.tsx). Thứ tự hiển thị là tiêu đề, số phiên bản extension (`v1.0.0`), rồi nút chọn theme ở sát mép phải.

* **Cấu trúc HTML:**
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
* **CSS bổ sung:** Dropdown menu sẽ ẩn mặc định và chỉ mở/đóng khi toggle nút bảng màu 🎨 hoặc dùng bàn phím. Nền dropdown phải đục, không dùng opacity hoặc backdrop blur, để lựa chọn dễ đọc trên mọi theme.

---

## 3. Đặc tả Giao diện Winamp Classic (Retro Player 1998)

Khi `data-theme="winamp"`, giao diện chuyển sang kết cấu cơ khí 3D nổi và màn hình hiển thị LED đặc trưng:

### 3.1. Màu sắc và Họa tiết kim loại (CSS Variables)
```css
[data-theme="winamp"] {
  --bg-app: #28282b; /* Màu xám kim loại tối */
  --bg-glass: #1c1c1f; /* Hộp đen bên trong */
  --border-glass: #8e8e93; /* Gờ nổi đón sáng */
  --color-text-primary: #00e600; /* Màu LED xanh dạ quang chính */
  --color-text-secondary: #008800; /* Màu LED xanh tối cho ký tự nền */
  --font-sans: 'Courier New', 'Courier', monospace;
  --font-display: 'Courier New', 'Courier', monospace;
}
```

### 3.2. Cải tiến Khung viền và Tiêu đề (Window Frame)
* **Khung Popup:** Thêm đường viền kép nổi khối 3D (`border: 2px solid; border-color: #8e8e93 #111 #111 #8e8e93`).
* **Họa tiết trang trí vỏ máy:** Sử dụng `background-image` kẻ sọc chéo 45 độ siêu mảnh làm nền cho các vùng trống của panel để tạo chất kim loại gồ ghề.
* **Thanh tiêu đề giả lập (Title Bar):**
  * Nằm trên cùng của cửa sổ, dải màu gradient từ xanh dương sẫm `#000080` sang đen `#000000`.
  * Hiển thị dòng chữ bạc `WINAMP` ở bên trái và 3 nút điều khiển cửa sổ pixel ở góc phải.

### 3.3. Màn hình LED kỹ thuật số (LED Display Screen)
* Khu vực thông tin trạng thái phát nhạc (Status) và chi tiết đoạn văn (Session Meta) sẽ gộp chung vào một hộp chìm màu đen tuyền `#000000`.
* Văn bản hiển thị màu xanh lá dạ quang rực rỡ, tất cả viết hoa (`text-transform: uppercase`).
* **Hiệu ứng sóng nhạc giả lập (Visualizer):** Một khối canvas/CSS gồm 8 cột dọc nhấp nháy ngẫu nhiên bằng CSS animation để mô tả mức tần số âm thanh khi trình đọc đang phát (trạng thái `playing`).

### 3.4. Bố cục điều khiển nằm ngang (Mechanical Deck)
* Thay đổi cấu trúc của `.playback-controls` thành dải ngang: `flex-direction: row; gap: 4px; pack: center;`.
* **Phím bấm cơ học:** Các nút bấm chuyển thành hình chữ nhật xám mờ viền nổi.
* **Biểu tượng phím:**
  * Nút Đọc/Resume: Chứa ký hiệu tam giác màu xanh lá dạ quang `▶`
  * Nút Tạm dừng (Pause): Chứa hai vạch màu vàng `‖`
  * Nút Dừng hẳn (Stop): Chứa ô vuông màu đỏ `■`
* Khi nhấn nút (`:active`), dịch chuyển toàn bộ nút xuống dưới và sang phải 1px (`transform: translate(1px, 1px)`) đồng thời chuyển viền từ nổi thành chìm (`border-color: #111 #8e8e93 #8e8e93 #111`).

### 3.5. Thanh trượt tốc độ & Tiến trình
* **Thanh tiến trình (Progress Bar):** Nền đen xám rãnh sâu, hiển thị mức tiến trình bằng các vạch dọc màu xanh lá dạ quang xếp khít nhau.
* **Thanh trượt Tốc độ (Speed Slider):** Biến thành cần gạt EQ dạng trượt dọc cơ khí với nút trượt vuông màu bạc viền đen.

---

## 4. Đặc tả Giao diện Windows Media Player 12 (Vista Aero 2006)

Khi `data-theme="wmp12"`, giao diện chuyển sang phong cách kính mờ thủy tinh trong suốt sang trọng của thời đại Windows Aero:

### 4.1. Màu sắc và Hiệu ứng khúc xạ kính (CSS Variables)
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

### 4.2. Hiệu ứng kính mờ (Aero Glass Setup)
* **Popup container:** Áp dụng `backdrop-filter: blur(20px) saturate(125%)` để tạo chiều sâu kính mờ lọc bão hòa màu sắc.
* Viền ngoài của popup có viền đôi khúc xạ ánh sáng: Viền ngoài `rgba(255, 255, 255, 0.25)` và đường highlight mỏng phía trong `rgba(255, 255, 255, 0.15)`.
* Mọi dòng chữ trên giao diện đều có đổ bóng text bóng mờ (`text-shadow: 0 1px 3px rgba(0,0,0,0.8)`) để đảm bảo khả năng đọc tốt trên mọi nền kính.

### 4.3. Bảng điều khiển bóng bẩy đáy (Bottom Control Dock)
* Phần dưới cùng của popup sẽ hiển thị một khối nằm ngang màu xám xanh bóng bẩy (Glossy Dock) có chiều cao cố định.
* **Nút điều khiển Play/Pause tròn lớn ở trung tâm:**
  * Kích thước tròn 52px x 52px.
  * Phủ màu dốc 3D dạng cầu (radial gradient):
    `background: radial-gradient(circle at 50% 30%, #00E5FF 0%, #007799 65%, #004466 100%)`.
  * Có vòng kim loại bạc bảo vệ bao quanh.
  * Hiệu ứng hào quang phát sáng (Glow): Khi hover, nút tỏa ra vầng sáng màu xanh lam rực rỡ (`box-shadow: 0 0 16px rgba(0, 229, 255, 0.85)`).
* Nút **Stop** hình vuông nhỏ màu xám nhạt nằm khiêm tốn bên cạnh nút tròn trung tâm.

### 4.4. Thanh tiến trình và Slider tốc độ
* **Thanh tiến trình (Progress Bar):** Nền trong suốt mờ, phần đã chạy có màu xanh Cyan phát sáng dịu.
* **Thanh trượt Tốc độ:** Đầu trượt (Thumb slider) biến thành một hạt ngọc tròn bóng bẩy màu xanh lam nhạt trong suốt.

---

## 5. Kế hoạch kiểm thử và nghiệm thu (Verification Plan)

### Kiểm thử Giao diện (Visual Verification)
1. Kiểm tra sự thay đổi 100% của CSS biến khi chọn lần lượt 3 theme: Mặc định, Winamp, WMP12.
2. Xác minh các hiệu ứng đặc trưng:
   - Winamp: Đường viền cơ học 3D, màn hình LED chữ xanh monospace, hiệu ứng dịch chuyển 1px khi nhấn nút điều khiển.
   - WMP12: Độ mờ của kính Aero, vầng hào quang phát sáng của nút Play tròn khi hover, bóng mờ chữ trắng.
3. Xác minh tính tương thích kích thước: Giao diện khi thay đổi theme vẫn nằm trọn trong giới hạn popup (Rộng 360px, Cao tối thiểu 480px), không bị tràn hay lỗi bố cục.

### Kiểm thử Chức năng (Functional Verification)
1. Xác minh việc ghi/đọc theme vào `chrome.storage.local` hoạt động đúng (tắt popup đi bật lại vẫn giữ nguyên theme đã chọn).
2. Đảm bảo các nút điều khiển của cả 2 theme mới vẫn kích hoạt đúng logic phát/tạm dừng/dừng đọc của Extension.
3. Đảm bảo thanh trượt tốc độ (dưới dạng cần gạt cơ khí hoặc hạt ngọc Aero) vẫn truyền đúng tốc độ đọc về service worker.
