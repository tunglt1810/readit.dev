# Kế hoạch thực hiện Tác vụ 1: Định nghĩa hằng số và Bộ từ điển dịch thuật i18n

## Mục tiêu
- Định nghĩa khóa lưu trữ theme `STORAGE_KEYS.THEME` làm `readit_active_theme`.
- Tạo từ điển dịch thuật `THEME_TRANSLATIONS` hỗ trợ 2 ngôn ngữ `vi` và `en` với các bản dịch tương ứng.
- Thực hiện TDD (Test-Driven Development): Viết test unit trước, kiểm chứng test thất bại, bổ sung code tối thiểu để test pass, chạy lại toàn bộ test suite.

## Các bước thực hiện
1. **Viết test trước**: Tạo file `tests/unit/theme_i18n.test.ts` thực hiện kiểm tra `STORAGE_KEYS.THEME` và dịch thuật `THEME_TRANSLATIONS`. Do code thật chưa được viết nên test này sẽ lỗi hoặc không compile được.
2. **Chạy test và xác minh thất bại**: Chạy `pnpm test:unit` để xác nhận test thất bại.
3. **Cập nhật `constants.ts`**: Bổ sung `THEME: 'readit_active_theme'` vào `STORAGE_KEYS` và export từ điển `THEME_TRANSLATIONS` trong `src/shared/constants.ts`.
4. **Xác minh test thành công**: Chạy lại `pnpm test:unit` để kiểm tra.
5. **Commit thay đổi**: Thực hiện commit git cho Tác vụ 1.
6. **Viết báo cáo**: Điền báo cáo vào `.superpowers/sdd/task-1-report.md`.
