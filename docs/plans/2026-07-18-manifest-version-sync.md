# Extension Version Synchronization Implementation Plan

Plan to automatically update `manifest.json` version based on `package.json` during the Rsbuild build process.

## Proposed Changes

### Build Config

Update Rsbuild configuration to include an inline plugin. This plugin hooks into build stages (`onAfterBuild` and `onDevCompileDone`) to read `package.json` and overwrite the `version` attribute in `dist/manifest.json`.

#### [MODIFY] [rsbuild.config.ts](file:///Users/bez/Workspace/repos/bez/readit.dev/rsbuild.config.ts)

- `import fs from 'node:fs'` and `import path from 'node:path'`
- Register `manifest-version-sync` plugin in `plugins` array.
- Use `fs.readFileSync` to read `package.json` and extract version.
- Overwrite `manifest.version` at `dist/manifest.json`.

## Verification Plan

### Automated Tests
- Run `pnpm lint` to check formatting/linting.

### Manual Verification
- Run `pnpm build` and verify `dist/manifest.json` version is updated to `1.0.1`.
- Run `pnpm dev` and perform identical verification.
