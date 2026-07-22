# build-dev: Local Build Number cho Extension

## Bối cảnh

Hiện tại `pnpm dev` chạy watch mode và `pnpm build` tạo production bundle. Cả hai đều sync version từ `package.json` vào `dist/manifest.json` (ví dụ `"version": "1.0.3"`). Khi dev local, mỗi lần reload extension trên Chrome, không có cách nào phân biệt build này với build trước.

Mục tiêu: thêm `pnpm build-dev` tạo một snapshot build có đính kèm **build number tự tăng** để dễ nhận diện khi dev local.

## Scope

- **Chỉ áp dụng local dev** — production build (`pnpm build`) không bị ảnh hưởng.
- Build number lưu vào `.build-number` (gitignored), không commit lên repo.
- Không watch, không hot reload — chỉ build một lần (snapshot).

## Thay đổi đề xuất

### 1. `scripts/build-dev.mjs` [NEW]

Script Node ESM thuần:

1. Đọc `.build-number` ở root (nếu chưa tồn tại, khởi tạo = `0`).
2. Tăng +1, ghi lại vào `.build-number`.
3. Set `process.env.BUILD_NUMBER` = giá trị mới.
4. `execSync('rsbuild build', { stdio: 'inherit', env: process.env })`.

### 2. `rsbuild.config.ts` — plugin `manifest-version-sync` (mở rộng)

Nếu `process.env.BUILD_NUMBER` tồn tại:

- Ghi `version_name: "{version}-dev.{BUILD_NUMBER}"` vào `dist/manifest.json`.  
  Ví dụ: `"version_name": "1.0.3-dev.42"`.
- Trường `version` vẫn là số nguyên (`1.0.3`) — đáp ứng ràng buộc Chrome Manifest V3.

### 3. `rsbuild.config.ts` — `source.define`

Inject constant `__BUILD_VERSION__`:

- Khi có `BUILD_NUMBER`: `"1.0.3-dev.42"`
- Khi không có (production build): `"1.0.3"`

TypeScript declaration cho constant này sẽ được thêm vào `src/shared/` hoặc `src/env.d.ts`.

### 4. Hiển thị trong UI

Popup/sidepanel đọc `__BUILD_VERSION__` và hiển thị tại vị trí đang có thông tin version (nếu có), hoặc thêm vào footer/About section.

> **Lưu ý:** Cần khảo sát UI hiện tại để xác định điểm hiển thị chính xác khi implementation.

### 5. `package.json`

```json
"build-dev": "node scripts/build-dev.mjs"
```

### 6. `.gitignore`

Thêm dòng:
```
/.build-number
```

## Ràng buộc kỹ thuật

| Trường | Giá trị | Ghi chú |
|--------|---------|---------|
| `version` | `1.0.3` | Bắt buộc là số nguyên, Chrome Manifest V3 |
| `version_name` | `1.0.3-dev.42` | String tùy ý, Chrome hiển thị trong chrome://extensions |
| `__BUILD_VERSION__` | `1.0.3-dev.42` | Compile-time constant cho React UI |

## Verification

- Chạy `pnpm build-dev` lần đầu → `.build-number` = 1, `dist/manifest.json` có `version_name: "1.0.3-dev.1"`.
- Chạy lại → `.build-number` = 2, `version_name: "1.0.3-dev.2"`.
- Chạy `pnpm build` (production) → `dist/manifest.json` **không có** `version_name`.
- Load extension trên Chrome → chrome://extensions hiển thị `1.0.3-dev.2`.
