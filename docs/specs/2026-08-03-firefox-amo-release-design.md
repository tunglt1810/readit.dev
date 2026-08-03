# Firefox AMO Release Workflow Design

**Status:** Implemented

## Goal

Publish the existing Firefox extension to Mozilla Add-ons (AMO) from the same
semantic-version tag that releases the Chrome extension, without exposing AMO
credentials to the build job, changing the Chrome Web Store API flow, or
allowing Firefox failures to block the Chrome release.

## Context

The repository already builds both targets with `pnpm build`. The release
workflow only packages and publishes Chrome because the earlier Firefox
publishing jobs were removed when the release workflow was simplified. The AMO
listing already exists and version 1.1.0 was approved, so later releases do not
need first-submission metadata. The Firefox build also needs a target-specific
manifest boundary: its sidebar uses `sidebar_action`, it does not request
Chrome-only file/offscreen permissions, and its background event page hosts the
local audio engine because Firefox has no Chrome offscreen document API.

Mozilla's supported update command is:

```bash
pnpm exec web-ext sign \
  --source-dir dist/firefox \
  --artifacts-dir .tmp/web-ext-artifacts \
  --channel listed \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"
```

## Design

1. `build-and-release` is the Chrome-primary job. It checks out the tag, sets
   the release version, builds only Chrome, runs the existing Chrome asset,
   unit, evaluation, and E2E gates, packages the Chrome archive, and creates
   the GitHub Release with that archive.
2. `publish-chrome` depends only on the Chrome build job, uses the existing
   `chrome-web-store` environment, downloads the Chrome artifact, and keeps the
   current upload/status/publish sequence.
3. `build-firefox` starts only after the Chrome GitHub Release exists. It builds
   and validates Firefox, packages its archive, and uploads that archive to the
   existing GitHub Release. Its failure leaves the completed Chrome Release
   intact and prevents only Firefox publication.
4. `publish-firefox` depends only on `build-firefox`, uses the
   `addons-mozilla-org` environment, downloads the Firefox artifact, and submits
   `dist/firefox` with `web-ext sign --channel listed`.
   Missing AMO credentials fail this publish job clearly instead of silently
   reporting a Firefox submission.
5. AMO signing artifacts are written under `.tmp/web-ext-artifacts`, which is
   already ignored by the repository. No token or secret is written to an
   artifact or GitHub output.
6. The shared sidebar opener chooses Firefox's `sidebarAction.open()` when that
   API is present and falls back to Chrome's `sidePanel.open({ windowId })`.
7. Firefox uses its MV3 background event page as the audio host. The shared
   audio handler is called directly through a message bridge, while Chrome
   continues to use the Offscreen Document adapter. This keeps TTS playback,
   readable-surface updates, and MP3 export independent from the sidebar page.
   Because Firefox does not implement `showSaveFilePicker()`, Firefox export
   encodes into memory and submits a `blob:` URL to the WebExtension
   `downloads` API with `saveAs: true`; Chrome retains its direct writable-file
   stream path.

## Failure and retry behavior

- Chrome build, validation, or packaging failure prevents the store jobs because
  Chrome is the primary release path.
- Firefox build, validation, packaging, or AMO submission failure fails only
  the Firefox path. The already-created Chrome GitHub Release and Chrome Web
  Store publication remain available for retry or manual submission.
- A Chrome or AMO publish failure fails only that publish job while preserving
  the available GitHub Release archive.
- `web-ext sign` uses `--no-input` so CI cannot hang waiting for interaction.
- Firefox audio commands do not use `runtime.sendMessage` back to the same
  background document; the direct bridge resolves command responses and routes
  progress events to the background message handler.
- Firefox MP3 export uses the `downloads` permission and buffers the encoded
  file until the download is started. The output is still local; no audio is
  sent to a server.
- Existing Chrome upload polling and publication status handling remain
  unchanged.

## Verification

- Parse the workflow as YAML and inspect the job dependency/environment wiring.
- Run `pnpm build:chrome` for the primary release gates, then run
  `pnpm build:firefox`, both manifest validators, and `pnpm validate:firefox`.
- Run `pnpm test:unit` and the Chrome audio-export runtime E2E suite.
- Run Firefox playback/export E2E on a Firefox installation before advertising
  a release as runtime-verified for Firefox.
- Run `pnpm lint` and `git diff --check`.
- Run `graphify update .` after the source/document changes.

## Out of scope

- AMO listing metadata, because the add-on is already listed and version 1.1.0
  was approved.
- Firefox browser E2E automation in the existing Chrome-only Playwright
  harness; this remains a separate verification task.
- Changes to the Chrome Web Store API behavior.

References:

- [Mozilla web-ext sign reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
- [Mozilla AMO initial/update submission guide](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)
- [MDN `showSaveFilePicker()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)
- [MDN WebExtension `downloads.download()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download)
