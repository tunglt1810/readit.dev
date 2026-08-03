# Firefox AMO Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore tag-driven Firefox AMO publishing alongside the existing Chrome release flow, with an explicit Firefox manifest and runtime compatibility boundary.

**Architecture:** The Chrome-primary build job produces the Chrome archive, runs all release gates, and creates the GitHub Release. A dependent Firefox build job produces and attaches the Firefox archive without becoming a dependency of Chrome publication. Separate store-publish jobs use their own protected GitHub Environments, so Firefox failures do not block Chrome.

**Tech Stack:** GitHub Actions, pnpm 11.11.0, Node.js 24, Rsbuild, `web-ext` 10.5.0, Mozilla AMO JWT credentials.

## Global Constraints

- Keep Chrome Web Store upload, polling, and publication behavior unchanged.
- Use `AMO_JWT_ISSUER` as `web-ext --api-key` and `AMO_JWT_SECRET` as `web-ext --api-secret`.
- Use `--channel listed` because the AMO listing already exists and version 1.1.0 was approved.
- Write web-ext signing artifacts only below `.tmp/`.
- Do not log or persist secret values.
- Keep specifications in `docs/specs/` and implementation plans in `docs/plans/`.
- Firefox uses a background event-page audio host because Firefox has no Chrome
  offscreen document API; the Chrome Offscreen Document path remains unchanged.
- Firefox does not support `showSaveFilePicker()`. Its MP3 export uses a
  memory-backed encoder and the Firefox `downloads` API with `saveAs: true`;
  Chrome continues to write directly to the selected file handle.

---

### Task 1: Split build and store-publish jobs

**Files:**
- Modify: `.github/workflows/release-extension.yml`

**Interfaces:**
- `build-and-release` produces job outputs `version` and `chrome_archive`.
- `build-firefox` produces job output `firefox_archive`.
- Consumes environment secrets only in `publish-chrome` or `publish-firefox`.

- [x] **Step 1: Convert the current release job into `build-and-release`**

Keep tag validation, pnpm/Node setup, dependency installation, Chrome E2E setup,
unit/evaluation/E2E gates, and GitHub Release behavior. The primary build gate
uses `pnpm build:chrome` and validates only the Chrome production bundle.

- [x] **Step 2: Package and expose both archives**

Create `readit.dev-chrome-${RELEASE_VERSION}.zip` from `dist/chrome`, validate
it with `pnpm validate:release-zip`, upload the Chrome build artifact, and
create the GitHub Release with the Chrome archive. A separate Firefox build job
later creates and attaches `readit.dev-firefox-${RELEASE_VERSION}.zip`.

- [x] **Step 3: Move Chrome publishing into `publish-chrome`**

Make it depend only on `build-and-release`, use the `chrome-web-store`
environment, download the Chrome artifact, and use the Chrome archive output
for the archive path.
Preserve the existing token refresh, upload, polling, and publication steps.

- [x] **Step 4: Add Firefox publishing in `publish-firefox`**

Make it depend only on the Firefox build job, use the `addons-mozilla-org`
environment, set `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from environment
secrets, download the Firefox artifact, then run:

```bash
set -euo pipefail
test -n "$AMO_JWT_ISSUER"
test -n "$AMO_JWT_SECRET"
pnpm exec web-ext sign \
  --source-dir dist/firefox \
  --artifacts-dir .tmp/web-ext-artifacts \
  --channel listed \
  --no-input \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"
```

### Task 6: Isolate Firefox failures from the Chrome release

**Files:**
- Modify: `.github/workflows/release-extension.yml`
- Modify: `docs/RELEASING.md`
- Modify: `docs/specs/2026-08-03-firefox-amo-release-design.md`
- Modify: `docs/plans/2026-08-03-firefox-amo-release.md`

- [x] Keep `build-and-release` Chrome-only and preserve all existing Chrome
  release gates.
- [x] Add a Firefox build/package job that runs after the Chrome GitHub Release,
  attaches its archive only after successful validation, and is not a dependency
  of `publish-chrome`.
- [x] Make `publish-firefox` depend on the Firefox build/package job only.
- [x] Verify that Firefox failure leaves the Chrome job and `publish-chrome`
  runnable, while a Chrome failure still prevents publishing either store.

### Task 2: Synchronize release documentation

**Files:**
- Modify: `docs/RELEASING.md`

- [x] **Step 1: Document both release archives and AMO behavior**

Update the workflow description, first-release checklist, and environment
secret section to explain that a tag creates Chrome and Firefox archives,
publishes Chrome through `chrome-web-store`, and publishes Firefox through
`addons-mozilla-org` using `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. State that the
AMO listing is already initialized, so updates do not require an AMO metadata
file.

### Task 3: Restore Firefox target boundaries

**Files:**
- Modify: `rsbuild.config.ts`
- Modify: `scripts/validate-free-manifest.mjs`
- Modify: `src/background/background.ts`
- Add: `src/background/firefox_background.ts`
- Add: `src/background/firefox_audio_export_download.ts`
- Add: `src/offscreen/audio_host_messages.ts`
- Modify: `src/offscreen/offscreen.ts`
- Add: `src/offscreen/offscreen_entry.ts`
- Add: `src/shared/browser.ts`
- Add: `src/shared/direct_message.ts`
- Modify: `src/popup/App.tsx`
- Modify: `src/popup/side_panel.ts`
- Add: `tests/unit/browser.test.ts`
- Add: `tests/unit/direct_message.test.ts`
- Modify: `tests/unit/manifest_validation.test.ts`

- [x] Transform the Firefox manifest to `sidebar_action`, stable Gecko ID,
  background scripts, and Firefox-only permissions/host access.
- [x] Route sidebar opening through Firefox `sidebarAction` or Chrome
  `sidePanel` and add unit coverage for both branches.
- [x] Add a direct runtime-message bridge so Firefox background commands call
  the shared audio handler in-process and audio progress/events return to the
  background handler without a self-message round trip.
- [x] Keep Chrome's Offscreen Document adapter and runtime transport unchanged.
- [x] Add unit coverage for synchronous event delivery and asynchronous direct
  command responses.
- [x] Add Firefox's `downloads` permission, memory-backed MP3 output, and
  object-URL cleanup after the download completes or fails to start.

### Task 4: Verify the workflow and repository state

**Files:**
- Verify: `.github/workflows/release-extension.yml`
- Verify: `docs/RELEASING.md`
- Verify: `docs/specs/2026-08-03-firefox-amo-release-design.md`
- Verify: `docs/plans/2026-08-03-firefox-amo-release.md`

- [x] **Step 1: Run build and release validators**

Run `pnpm build:chrome`, `pnpm validate:manifest:chrome`, then separately run
`pnpm build:firefox`, `pnpm validate:manifest:firefox`, and `pnpm validate:firefox`.

- [x] **Step 2: Run static checks**

Run `pnpm lint`, `git diff --check`, and a YAML parse check using the available
workspace YAML parser or Ruby's standard YAML parser. Confirm no secret value or
unignored temporary file was introduced. `git diff --check`, YAML parsing,
targeted Biome checks, builds, manifest validation, unit tests, Chrome audio
export E2E, and Firefox `web-ext lint` pass. Repo-wide `pnpm lint` remains
blocked by the pre-existing nested `.worktrees/mp3-audio-export/biome.json`
configuration and existing diagnostics in `App.tsx`/`background.ts`.

- [ ] **Step 3: Refresh graphify**

Run `graphify update .` and inspect `git status --short` so generated graph
changes remain consistent with the repository's existing graphify policy.
Attempted with and without `--no-cluster`; both runs stopped on the existing
workspace `Operation not permitted` extraction failure.

### Task 5: Firefox runtime verification

- [ ] Run playback and MP3 export in Firefox, close the sidebar during an
  active job, and verify the background event-page host remains independent.
- [ ] Test a long export across event-page idle/suspend behavior and document
  the supported Firefox minimum version based on observed results.
