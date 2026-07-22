# Kế Hoạch Thực Thi Phím Tắt Mở Extension & Auto-Focus Nút Đọc Trang

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keyboard shortcuts to open Popup (`Ctrl+Shift+K` / `Command+Shift+K`) and Side Panel (`Ctrl+Shift+E` / `Command+Shift+E`), while automatically focusing the primary read control button when Popup/Side Panel opens.

**Architecture:** Sử dụng khai báo `commands` chuẩn Manifest V3 trong `manifest.json` kết hợp listener `chrome.commands.onCommand` trong service worker. Cùng với đó sử dụng React `useRef` + `useEffect` trong Popup và Side Panel để tự động kích hoạt `focus()` cho nút hành động chính theo trạng thái playback.

**Tech Stack:** TypeScript, React, Chrome Extension API (Manifest V3 Commands & SidePanel).

## Global Constraints

- Default popup opening shortcut: `Ctrl+Shift+K` (Win/Linux), `Command+Shift+K` (Mac).
- Default side panel opening shortcut: `Ctrl+Shift+E` (Win/Linux), `Command+Shift+E` (Mac).
- Auto-focus primary read button (or pause/resume button if an active session exists) when UI mounts.
- Comply with shell command rule requiring a leading space.

---

### Task 1: Khai báo Phím tắt trong Manifest và Background Listener

**Files:**
- Modify: `public/manifest.json`
- Modify: `src/background/background.ts`

- [ ] **Step 1: Thêm phần `commands` vào `public/manifest.json`**

Thêm cấu hình `commands` vào `public/manifest.json`:
```json
	"commands": {
		"_execute_action": {
			"suggested_key": {
				"default": "Ctrl+Shift+K",
				"mac": "Command+Shift+K"
			}
		},
		"open_side_panel": {
			"suggested_key": {
				"default": "Ctrl+Shift+E",
				"mac": "Command+Shift+E"
			},
			"description": "Open side panel"
		}
	}
```

- [ ] **Step 2: Register `chrome.commands.onCommand` listener in `src/background/background.ts`**

Bổ sung xử lý lệnh mở side panel:
```typescript
chrome.commands.onCommand.addListener(async (command) => {
	if (command === 'open_side_panel') {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (tab?.windowId) {
			await chrome.sidePanel.open({ windowId: tab.windowId });
		}
	}
});
```

- [ ] **Step 3: Kiểm tra build TypeScript**

Run: ` pnpm build`
Expected: Biên dịch không lỗi.

- [ ] **Step 4: Commit**

```bash
 git add public/manifest.json src/background/index.ts
 git commit -m "feat: add keyboard shortcuts for popup and side panel"
```

---

### Task 2: Auto-focus Nút Điều Khiển Chính Trong Popup UI

**Files:**
- Modify: `src/popup/App.tsx`

- [ ] **Step 1: Tạo `primaryButtonRef` và thêm `useEffect` cho Auto-focus**

Trong `src/popup/App.tsx`:
```typescript
const primaryButtonRef = useRef<HTMLButtonElement>(null);

useEffect(() => {
	if (session !== null || status === 'stopped') {
		primaryButtonRef.current?.focus();
	}
}, [session, status]);
```

- [ ] **Step 2: Gán `ref={primaryButtonRef}` vào nút action tương ứng**

Gán `ref={primaryButtonRef}` cho nút primary (cả giao diện mặc định và giao diện chủ đề Winamp/WMP12):
```tsx
<button
	ref={primaryButtonRef}
	className={`btn btn-primary btn-icon-only btn-read ${status !== 'stopped' && status !== 'error' ? 'active' : ''}`}
	onClick={handleReadPage}
	aria-label={status === 'stopped' || status === 'error' ? t('readPage') : t('stopReading')}
	title={status === 'stopped' || status === 'error' ? t('readPage') : t('stopReading')}
>
	<PlaybackIcon name={status === 'stopped' || status === 'error' ? 'read' : 'stop'} />
</button>
```
Đồng thời gán `ref={primaryButtonRef}` khi ở nút play/pause nếu đang trong trạng thái playing/paused.

- [ ] **Step 3: Kiểm tra build TypeScript**

Run: ` pnpm build`
Expected: Biên dịch thành công.

- [ ] **Step 4: Commit**

```bash
 git add src/popup/App.tsx
 git commit -m "feat: auto-focus primary action button in popup"
```

---

### Task 3: Auto-focus Nút Điều Khiển Chính Trong Side Panel UI

**Files:**
- Modify: `src/sidepanel/App.tsx`

- [ ] **Step 1: Tạo `primaryButtonRef` và thêm `useEffect` auto-focus cho Side Panel**

Trong `src/sidepanel/App.tsx`:
```typescript
const primaryButtonRef = useRef<HTMLButtonElement>(null);

useEffect(() => {
	primaryButtonRef.current?.focus();
}, [session]);
```

- [ ] **Step 2: Gán `ref={primaryButtonRef}` vào nút đọc trang chính của Side Panel**

Gán ref vào nút "Đọc trang này" (`handleReadCurrentPage`).

- [ ] **Step 3: Kiểm tra build TypeScript**

Run: ` pnpm build`
Expected: Biên dịch thành công.

- [ ] **Step 4: Commit**

```bash
 git add src/sidepanel/App.tsx
 git commit -m "feat: auto-focus primary action button in side panel"
```

---

### Task 4: Kiểm Thử Toàn Bộ & Testcases Tự Động (Verification)

- [x] **Step 1: Viết testcases E2E kiểm tra auto-focus trong Popup & Side Panel**
  - Thêm test `tự động focus vào nút đọc trang khi mở popup` trong `tests/e2e/tts-controls.spec.ts`.
  - Thêm test `auto-focuses the primary action button when side panel opens` trong `tests/e2e/side-panel.spec.ts`.

- [x] **Step 2: Chạy build production**

Run: ` pnpm build`
Expected: BUILD SUCCESS

- [x] **Step 3: Chạy bộ test Playwright E2E**

Run: ` pnpm test:e2e`
Expected: Tất cả test case e2e đều PASS.

