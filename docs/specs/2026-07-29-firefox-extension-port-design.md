# Firefox Extension Port & CI/CD Pipeline Design

## Overview

This specification details the architecture, manifest transformations, API abstractions, and build/release pipeline updates required to publish **Readit.dev** as a Firefox Manifest V3 Extension on the Mozilla Add-ons Store (AMO), while maintaining full compatibility with the existing Chrome extension.

## Goals

1. **Single Codebase**: Build both Chrome and Firefox extensions from a unified codebase.
2. **Cross-Browser API Compatibility**: Standardize browser extension API calls using `webextension-polyfill` (`browser.*`).
3. **Automated Firefox Manifest Transformation**: Configure Rsbuild with environment flags to automatically output browser-specific manifests and bundles (`dist/chrome` and `dist/firefox`).
4. **Complete CI/CD Pipeline Updates**: Update build scripts, validation scripts, and GitHub Actions workflows to automate packaging and submission to both Chrome Web Store and Firefox AMO.

---

## 1. Browser API Abstraction (`webextension-polyfill`)

### 1.1 Dependency Setup
- Install `webextension-polyfill` and `@types/webextension-polyfill`.
- Create `src/shared/browser.ts` to export a unified `browser` instance.

### 1.2 Side Panel & Sidebar Adaptation
- Chrome MV3 uses `chrome.sidePanel.open()`.
- Firefox MV3 uses `browser.sidebarAction.open()`.
- In `src/shared/browser.ts`, create a helper `openSidebarOrPanel(tabId?: number)`:
  - If `browser.sidebarAction` exists, call `browser.sidebarAction.open()`.
  - Else if `browser.sidePanel` exists, call `browser.sidePanel.open({ tabId })`.

### 1.3 Offscreen Document Handling
- Chrome MV3 requires Offscreen Documents (`chrome.offscreen`) for background audio playback and ONNX Runtime WASM execution.
- Firefox 119+ supports Offscreen Documents via `browser.offscreen`.
- Maintain unified offscreen document creation logic in `src/background/background.ts` using `browser.offscreen`.

---

## 2. Build Tooling & Manifest Transformation

### 2.1 Target Browser Build Flag
- Introduce `TARGET_BROWSER` environment variable (`chrome` | `firefox`, default: `chrome`).
- Dist root path mapping:
  - `TARGET_BROWSER=chrome` -> `dist/chrome`
  - `TARGET_BROWSER=firefox` -> `dist/firefox`

### 2.2 Rsbuild Manifest Transformation Plugin
In `rsbuild.config.ts`, implement `manifest-transform-plugin`:
- **For Firefox Target**:
  - Replace `"background": { "service_worker": "background.js", "type": "module" }` with `"background": { "scripts": ["background.js"] }`.
  - Convert `"side_panel": { "default_path": "src/sidepanel/sidepanel.html" }` to `"sidebar_action": { "default_panel": "src/sidepanel/sidepanel.html", "default_icon": { ... } }`.
  - Update `commands`: Map `open_side_panel` to `_execute_sidebar_action` or sidebar command.
  - Inject `browser_specific_settings`:
    ```json
    "browser_specific_settings": {
      "gecko": {
        "id": "readit-dev@readit.dev",
        "strict_min_version": "115.0"
      }
    }
    ```
  - Adjust permissions: Remove Chrome-only permissions if incompatible; retain standard permissions (`activeTab`, `scripting`, `storage`, `offscreen`, `contextMenus`).

---

## 3. Build & CI/CD Pipeline Updates

### 3.1 `package.json` Scripts
Update `package.json` with multi-target build and validation commands:
```json
{
  "scripts": {
    "build:chrome": "TARGET_BROWSER=chrome tsc && TARGET_BROWSER=chrome rsbuild build",
    "build:firefox": "TARGET_BROWSER=firefox tsc && TARGET_BROWSER=firefox rsbuild build",
    "build": "pnpm build:chrome && pnpm build:firefox",
    "validate:manifest:chrome": "node scripts/validate-free-manifest.mjs dist/chrome/manifest.json --target chrome",
    "validate:manifest:firefox": "node scripts/validate-free-manifest.mjs dist/firefox/manifest.json --target firefox",
    "validate:release-zip:chrome": "node scripts/validate-extension-archive.mjs --target chrome",
    "validate:release-zip:firefox": "node scripts/validate-extension-archive.mjs --target firefox"
  }
}
```

### 3.2 Manifest & Archive Validation Scripts
- `scripts/validate-free-manifest.mjs`:
  - Support `--target chrome|firefox`.
  - For `firefox`: Ensure `browser_specific_settings.gecko.id` is present, `sidebar_action` is defined, and no unsupported Chrome keys (`minimum_chrome_version`, `side_panel`) exist.
- `scripts/validate-extension-archive.mjs`:
  - Validate zip contents for both Chrome and Firefox targets.

### 3.3 GitHub Actions Release Workflow (`.github/workflows/release-extension.yml`)
Enhance `.github/workflows/release-extension.yml` on release tag `v*.*.*`:
1. **Build Step**: Run `pnpm build:chrome` and `pnpm build:firefox`.
2. **Validation Step**: Validate both `dist/chrome` and `dist/firefox` manifests and assets.
3. **Packaging Step**:
   - `readit.dev-chrome-${RELEASE_VERSION}.zip` from `dist/chrome`.
   - `readit.dev-firefox-${RELEASE_VERSION}.zip` from `dist/firefox`.
4. **GitHub Release Step**: Attach both Chrome and Firefox zip packages to the GitHub release.
5. **Chrome Web Store Submission Step**: Maintain existing CWS API upload steps.
6. **Firefox AMO Submission Step**:
   - Add step using Mozilla `web-ext` or cURL to submission API endpoint:
     `https://addons.mozilla.org/api/v5/addons/addon/{extension_id}/versions/{version}/`
   - Secrets required: `AMO_ISSUER`, `AMO_SECRET`, `AMO_EXTENSION_ID`.

---

## 4. Verification & Testing Plan

### 4.1 Automated Tests
- Unit tests: `pnpm test:unit` must pass.
- Manifest validation: `pnpm validate:manifest:chrome` & `pnpm validate:manifest:firefox` must pass.
- Build test: `pnpm build` produces clean `dist/chrome` and `dist/firefox` bundles.

### 4.2 End-to-End Tests
- Playwright E2E tests: Run Playwright against Chrome dist and Firefox dist (or Firefox browser instance).

---

## 5. Security & Privacy Considerations
- No hardcoded secrets in codebase or manifest.
- Firefox AMO requires source code upload if code is minified/bundled. Add source package creation step (`readit.dev-source-${RELEASE_VERSION}.zip`) in GitHub Actions if required by AMO review guidelines.
