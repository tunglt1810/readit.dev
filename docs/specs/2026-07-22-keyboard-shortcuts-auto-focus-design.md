# Thiết Kế Phím Tắt Mở Extension & Auto-Focus Nút Đọc Trang

## Tổng quan
Cung cấp phím tắt bàn phím cho Chrome extension readit.dev để nhanh chóng mở Popup và Side Panel, đồng thời tự động di chuyển con trỏ focus vào nút hành động đọc chính (Đọc trang / Tạm dừng / Tiếp tục) nhằm tối ưu trải nghiệm người dùng thao tác bằng phím tắt.

## Declared Keyboard Shortcuts
- **Open Popup**:
  - Windows / Linux: `Ctrl + Shift + K`
  - macOS: `Command + Shift + K`
  - Manifest V3 Command: `_execute_action`
- **Open Side Panel**:
  - Windows / Linux: `Ctrl + Shift + E`
  - macOS: `Command + Shift + E`
  - Manifest V3 Command: `open_side_panel`

## Cấu Trúc Thay Đổi

### 1. `public/manifest.json`
- Add `"commands"` as a top-level key defining default shortcuts for `_execute_action` and `open_side_panel`.
- **Permissions Note**: No new permissions need to be added to `"permissions"`. The `"sidePanel"` permission is already present in the project.

### 2. `src/background/background.ts`
Add a `chrome.commands.onCommand` listener to handle `open_side_panel` event and open the side panel for the active window via `chrome.sidePanel.open({ windowId })`.

### 3. `src/popup/App.tsx`
- Tạo `primaryButtonRef = useRef<HTMLButtonElement>(null)`.
- Gán ref linh hoạt theo trạng thái playback:
  - Khi `status === 'stopped'` hoặc `'error'`: Nút **Đọc trang** (`.btn-read` / themed primary).
  - Khi `status === 'playing'` hoặc `'paused'`: Nút **Tạm dừng / Tiếp tục** (`.btn-playpause` / themed primary).
- Dùng `useEffect` kích hoạt `primaryButtonRef.current?.focus()` khi Popup mount & nhận session ban đầu.

### 4. `src/sidepanel/App.tsx`
- Tạo `primaryButtonRef = useRef<HTMLButtonElement>(null)`.
- Gán ref vào nút đọc trang chính ("Đọc trang này" hoặc nút điều khiển playback).
- Kích hoạt focus tự động khi Side Panel mount & nhận session.

## Kế Hoạch Kiểm Thử (Verification Plan)
- Chạy `pnpm build` kiểm tra TypeScript & bundle không lỗi.
- Chạy `pnpm test:e2e` kiểm tra bộ test Playwright.
- Kiểm tra thủ công tính năng phím tắt và auto focus nút bấm chính.
