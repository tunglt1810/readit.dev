# build-dev: Local Build Number for Extension

## Context

Currently `pnpm dev` runs watch mode and `pnpm build` creates the production bundle. Both sync the version from `package.json` into `dist/manifest.json` (e.g., `"version": "1.0.3"`). When developing locally, each time the extension is reloaded in Chrome, there is no way to distinguish this build from previous builds.

Goal: Add `pnpm build-dev` to create a snapshot build tagged with an **auto-incrementing build number** for easy identification during local development.

## Scope

- **Local dev only** — production build (`pnpm build`) is unaffected.
- Build number is saved to `.build-number` (gitignored), not committed to repository.
- No watch mode, no hot reload — single snapshot build execution.

## Proposed Changes

### 1. `scripts/build-dev.mjs` [NEW]

Pure Node ESM script:

1. Read `.build-number` at root (if it does not exist, initialize = `0`).
2. Increment by +1, save back to `.build-number`.
3. Set `process.env.BUILD_NUMBER` = new value.
4. Run `execSync('rsbuild build', { stdio: 'inherit', env: process.env })`.

### 2. `rsbuild.config.ts` — `manifest-version-sync` Plugin (Extended)

If `process.env.BUILD_NUMBER` exists:

- Write `version_name: "{version}-dev.{BUILD_NUMBER}"` into `dist/manifest.json`.  
  Example: `"version_name": "1.0.3-dev.42"`.
- The `version` field remains dot-separated integers (`1.0.3`) — satisfying Chrome Manifest V3 constraints.

### 3. `rsbuild.config.ts` — `source.define`

Inject constant `__BUILD_VERSION__`:

- When `BUILD_NUMBER` is present: `"1.0.3-dev.42"`
- When absent (production build): `"1.0.3"`

TypeScript declaration for this constant will be added to `src/shared/` or `src/env.d.ts`.

### 4. UI Display

Popup/sidepanel reads `__BUILD_VERSION__` and displays it at the current version location (if available), or adds it to the footer/About section.

> **Note:** Inspect current UI to determine exact display location during implementation.

### 5. `package.json`

```json
"build-dev": "node scripts/build-dev.mjs"
```

### 6. `.gitignore`

Add entry:
```
/.build-number
```

## Technical Constraints

| Field | Value | Notes |
|--------|---------|---------|
| `version` | `1.0.3` | Must be dot-separated integers, Chrome Manifest V3 requirement |
| `version_name` | `1.0.3-dev.42` | Arbitrary string, Chrome displays in `chrome://extensions` |
| `__BUILD_VERSION__` | `1.0.3-dev.42` | Compile-time constant for React UI |

## Verification

- Run `pnpm build-dev` first time → `.build-number` = 1, `dist/manifest.json` has `version_name: "1.0.3-dev.1"`.
- Run again → `.build-number` = 2, `version_name: "1.0.3-dev.2"`.
- Run `pnpm build` (production) → `dist/manifest.json` **does not have** `version_name`.
- Load extension on Chrome → `chrome://extensions` displays `1.0.3-dev.2`.
