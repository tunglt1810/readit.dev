# Thiết kế: Cuộn Căn Giữa Highlight & Dừng Thông Minh 3s Khi Cuộn Tay

## 1. Tổng quan & Mục tiêu

Khi ứng dụng highlight từ/câu đang đọc (TTS playback), trải nghiệm hiện tại gặp 2 hạn chế:
- **Cắt viền / Cuộn không hợp lý**: Đoạn highlight chỉ được cuộn khi trôi lọt hẳn ra khỏi màn hình, và được đẩy vào sát mép trên hoặc dưới (do dùng `block: 'nearest'`), khiến mắt người đọc phải nhìn xuống đáy hoặc sát đỉnh màn hình.
- **Tranh chấp cuộn với người dùng**: Nếu người dùng cuộn tay xem nội dung xung quanh trong khi đang phát đọc, extension tự động cuộn giật màn hình lại về từ highlight mới.

**Mục tiêu**:
1. Đưa vị trí highlight về **chính giữa màn hình** khi đi ra ngoài dải an toàn (20% - 80% viewport).
2. Tự động tạm ngưng cuộn 3 giây nếu phát hiện người dùng tự cuộn tay **trong lúc đang đọc**.

---

## 2. Chi tiết Kỹ thuật & Thuật toán

### 2.1. Căn giữa Highlight (Centering Math)
- **Vùng an toàn (Safe Zone)**: `TOP_THRESHOLD = 0.20` và `BOTTOM_THRESHOLD = 0.80`.
  > Giá trị 20%/80% khớp với ngưỡng mà code hiện tại đã dùng trong cả `word_highlight.ts` lẫn `App.tsx`, tránh thay đổi tần suất cuộn so với trước.
- **Điều kiện kích hoạt cuộn**:
  Giả sử `rect` là `getBoundingClientRect()` của phần tử/range highlight hiện tại, tâm của highlight là:
  $$\text{targetY} = \text{rect.top} + \frac{\text{rect.height}}{2}$$
  Kích hoạt cuộn khi $\text{targetY} < 0.20 \times \text{window.innerHeight}$ hoặc $\text{targetY} > 0.80 \times \text{window.innerHeight}$.
- **Khoảng cách cuộn ($\Delta Y$)**:
  $$\Delta Y = \text{targetY} - \frac{\text{window.innerHeight}}{2}$$
- **Hiệu ứng cuộn**:
  Sử dụng `window.scrollBy({ top: deltaY, behavior })` với `behavior` ưu tiên `'smooth'`, ngoại trừ trường hợp hệ thống bật `prefers-reduced-motion: reduce` sẽ dùng `'auto'`.
  `prefers-reduced-motion` được kiểm tra tại mỗi lần gọi cuộn (không cache), vì user có thể thay đổi setting giữa chừng.

### 2.2. Cơ chế Dừng Thông Minh 3s (Smart 3s Pause)

#### 2.2.1. Xác định trạng thái "đang phát" (Playback State Source)

Hai integration point có cách khác nhau để biết TTS đang phát:

| Context | Nguồn trạng thái | Giải thích |
|---------|-------------------|------------|
| **Content script** (`word_highlight.ts`) | Khi nhận `WORD_HIGHLIGHT_INIT` hợp lệ, gọi `setPlaybackState(true)` một lần cho session; gọi `setPlaybackState(false)` khi nhận message `WORD_HIGHLIGHT_CLEAR` hoặc khi `disposeCurrentHighlightSession()`. | Content script không nhận message pause/resume riêng — nó chỉ nhận `WORD_HIGHLIGHT_UPDATE` (mỗi từ mới) và `WORD_HIGHLIGHT_CLEAR` (kết thúc). Khi pause, background đơn giản ngừng gửi UPDATE. Sau 3s không có UPDATE mới, pause manager tự hết hiệu lực. |
| **Reader view** (`App.tsx`) | `status === 'playing'` từ `documentSession?.status` | Reader view có trực tiếp trạng thái playback qua state. |

#### 2.2.2. Chi tiết hoạt động

- **Ràng buộc trạng thái**: Cơ chế 3s chỉ hoạt động khi trạng thái đọc TTS đang phát. Nếu không đọc, event listener vẫn tồn tại nhưng `onUserInteraction()` sẽ no-op.
- **Bắt sự kiện cuộn tay**:
  - Đăng ký sự kiện: `wheel`, `touchmove`, và các phím cuộn trang (`PageDown`, `PageUp`, `ArrowDown`, `ArrowUp`, `Space`).
  - Khi có thao tác người dùng trong lúc đọc:
    1. Gọi `pauseManager.onUserInteraction()`.
    2. Manager ghi nhận `pausedUntil = now + 3000ms`.
    3. Mỗi lần `performCenteredScroll` được gọi, nó check `isPaused()` → nếu `now < pausedUntil` thì bỏ qua cuộn.
  - Nếu user cuộn thêm lần nữa trước khi hết 3s, `pausedUntil` được đẩy ra thêm 3s (debounce behavior).
- **Bỏ qua cuộn tự động**: Trong khi `isPaused() === true`, hàm `performCenteredScroll` sẽ `return false` sớm, không can thiệp vào vị trí màn hình người dùng.
- **Reset trạng thái**: Khi `setPlaybackState(false)`, xóa sạch `pausedUntil` ngay lập tức.

#### 2.2.3. Lifecycle của Event Listeners

| Context | Attach | Detach | Lý do |
|---------|--------|--------|-------|
| **Content script** | Khi `installWordHighlight()` chạy (1 lần duy nhất khi content script inject vào trang) | Khi page unload (content script bị destroy cùng trang) | Content script sống suốt đời trang. Listener luôn tồn tại nhưng chỉ có hiệu lực khi `isPlaying === true` trong manager. |
| **Reader view** | Trong `useEffect` với dependency `[status]` khi `status === 'playing'` | Trong cleanup function của cùng `useEffect` | React lifecycle — clean attach/detach theo playback state. |

> **Tại sao content script không detach khi clear session?**
> Content script có thể nhận session mới bất kỳ lúc nào (user bấm play lại). Attach/detach liên tục tạo churn không cần thiết. Thay vào đó, `onUserInteraction()` check `isPlaying` bên trong — nếu false thì no-op, chi phí gần bằng 0.

---

## 3. Cấu trúc Component & Ảnh hưởng File

### 3.1. [NEW] `src/shared/scroll_helper.ts`
Tạo helper module tập trung cung cấp:
- `calculateCenteredScrollOffset(rect, viewportHeight, topThreshold?, bottomThreshold?)`: Pure function tính toán. Default thresholds 0.20/0.80.
- `UserScrollPauseManager`: Class quản lý trạng thái 3s pause. Methods: `setPlaybackState(isPlaying)`, `onUserInteraction()`, `isPaused()`.
- `performCenteredScroll(rect, viewportHeight, pauseManager?, scrollFn?, prefersReducedMotion?)`: Orchestrator kết hợp calculation + pause check + scroll execution.

### 3.2. [MODIFY] `src/content/word_highlight.ts`
- Thay thế hàm `scrollIntoViewIfNeeded` cũ bằng gọi `performCenteredScroll` từ `scroll_helper`.
- Thêm module-level `scrollPauseManager` instance.
- Gọi `scrollPauseManager.setPlaybackState(true)` một lần khi nhận `WORD_HIGHLIGHT_INIT` hợp lệ để bắt đầu session playback; không ghi lại trạng thái trong đường hot path cuộn từng từ.
- Gọi `scrollPauseManager.setPlaybackState(false)` trong `disposeCurrentHighlightSession()`.
- Đăng ký `wheel`, `touchmove`, `keydown` listeners 1 lần trong `installWordHighlight()`, handler gọi `scrollPauseManager.onUserInteraction()`.

### 3.3. [MODIFY] `src/reader/App.tsx`
- Import `performCenteredScroll` và `UserScrollPauseManager`.
- Tạo `useRef<UserScrollPauseManager>` để giữ instance ổn định qua renders.
- Trong `useEffect([status])`: gọi `manager.setPlaybackState(status === 'playing')`, attach/detach scroll listeners.
- Trong `useEffect([currentWordIndex, wordRanges])`: thay khối scroll cũ bằng `performCenteredScroll(...)`.

---

## 4. Kế hoạch Kiểm thử (Verification Plan)

### Automated Tests
- Unit tests cho `calculateCenteredScrollOffset`: boundary cases, edge cases (rect.height = 0, viewport nhỏ).
- Unit tests cho `UserScrollPauseManager`: no-op when not playing, pause duration, debounce on repeated interaction, reset on stop.
- Unit tests cho `performCenteredScroll`: integration of pause + calculation + scroll invocation.
- Chạy build TypeScript: `pnpm build`
- Chạy unit tests: `pnpm test:unit`

### Manual Verification
1. Mở trang web có nội dung dài, bật đọc TTS.
2. Kiểm tra khi highlight trôi xuống dưới 80% màn hình, trang web cuộn mượt đưa dòng highlight về chính giữa màn hình.
3. Khi đang đọc, dùng chuột/touchpad tự cuộn trang lên trên hoặc xuống dưới: Xác nhận extension tạm dừng tự động cuộn trong 3 giây.
4. Sau 3 giây không thao tác cuộn: Xác nhận ở từ highlight tiếp theo, extension tự động cuộn căn giữa lại bình thường.
5. Khi không đọc TTS, thử cuộn trang: Xác nhận cờ cuộn không bị kích hoạt vô ích (no console errors, no unexpected scrolls).
6. Bật `prefers-reduced-motion: reduce` trong OS → xác nhận cuộn dùng `behavior: 'auto'` (không animation).
7. Trong Reader View: pause TTS → cuộn tay → resume → xác nhận cuộn tự động hoạt động lại ngay (không chờ 3s vì pause đã reset state).
