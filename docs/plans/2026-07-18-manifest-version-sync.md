# Đồng bộ Version Extension

Kế hoạch tự động cập nhật version cho `manifest.json` dựa vào `package.json` trong quá trình build qua Rsbuild.

## Proposed Changes

### Build Config

Cập nhật config của RSBuild để thêm một inline plugin. Plugin này hook vào quá trình build (`onAfterBuild` và `onDevCompileDone`) để đọc file `package.json`, và ghi đè thuộc tính `version` vào file `dist/manifest.json`.

#### [MODIFY] [rsbuild.config.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/rsbuild.config.ts)

- `import fs from 'node:fs'` và `import path from 'node:path'`
- Khai báo thêm plugin `manifest-version-sync` trong mảng `plugins`.
- Dùng `fs.readFileSync` đọc `package.json` để lấy version.
- Ghi đè vào `manifest.version` ở đường dẫn `dist/manifest.json`.

## Verification Plan

### Automated Tests
- Chạy `pnpm lint` kiểm tra format/linting.

### Manual Verification
- Chạy `pnpm build` và kiểm tra file `dist/manifest.json` xem version đã là `1.0.1` hay chưa.
- Chạy `pnpm dev` và kiểm tra tương tự.
