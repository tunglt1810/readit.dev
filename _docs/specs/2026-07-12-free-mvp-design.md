# readit.dev Free MVP Design Specification

**Status:** Approved design; implementation pending
**Date:** July 12, 2026
**Scope:** Free release for Chrome and compatible Chromium-based browsers

## 1. Product decision

readit.dev Free is a Manifest V3 browser extension that extracts the readable
article from the active tab and reads it aloud with Supertonic 3 running on the
user's device.

The Free release is deliberately self-contained. It does not require an
account, license key, API service, backend deployment, payment, cloud TTS,
translation service, analytics, or crash-reporting service.

This document is the canonical product and technical specification for the
Free MVP. Pro functionality and the `backend/` workspace remain future work
and must not change the Free runtime or release artifact.

## 2. Goals

The release must let a user:

1. Open a supported web page and start reading the current article.
2. Read a text selection from the supported page's context menu.
3. Hear locally generated audio without sending the article to readit.dev or
   another application service.
4. Pause, resume, stop, select one of ten voice styles, and adjust playback
   speed.
5. Understand playback state from the popup and extension toolbar badge.
6. Use the popup in English or Vietnamese.
7. See the installed extension version and open a privacy-safe Feedback link.
8. Understand what the extension accesses, where model files come from, and
   what is not collected.

## 3. Non-goals

The Free MVP does not include:

- Pro UI, tier badges, activation, license validation, or license keys;
- requests to `api.readit.dev` or any other readit.dev API;
- deployment or runtime use of `backend/`;
- accounts, subscriptions, checkout, or payment processing;
- translation or language conversion;
- synchronized word highlighting, vocabulary tools, or learning mode;
- summaries, cloud AI, cloud TTS, or cross-device synchronization;
- telemetry, Google Analytics, Sentry, crash reporting, or advertising;
- a custom reader-mode screen or manual text-input fallback;
- Firefox support in this release.

## 4. User experience

### 4.1 Start reading

The popup exposes a primary action to read the current page. On activation:

1. The extension requests the article from the content script in the active
   tab.
2. The content script clones the document and parses it with Mozilla
   Readability.
3. The parsed article is reduced to its title, plain text, URL, and detected
   language.
4. The background service worker sends the article to the offscreen document.
5. The offscreen document loads the local TTS runtime/model if necessary and
   begins playback.

The article is held only in extension memory for the active reading session.
It is not persisted in `chrome.storage`.

### 4.2 Read selected text

When the user selects text on a supported HTTP or HTTPS page, the extension
offers one context-menu action to read that selection. The background worker
trims and validates the selection, reads and normalizes the page language, and
constructs the normal `Article` contract without running Readability.

A whitespace-only selection is ignored and does not interrupt active playback.
A valid selection replaces the current single session through the same
background/offscreen playback pipeline used by full-page reading. Selected text
and generated audio remain in memory and are not persisted.

### 4.3 Controls, status, and settings

The popup must provide:

- icon-only read, stop, pause, and resume controls with localized tooltips and
  explicit accessibility labels;
- a Stop control that remains available while playback is loading;
- ten voice styles: stable IDs `M1`–`M5` and `F1`–`F5`;
- playback speed from `0.70x` through `1.80x` in `0.05x` steps;
- visible loading and paragraph progress states;
- a toolbar badge for loading, playing, paused, error, and stopped states;
- translated error states;
- a language selector for the popup UI;
- a privacy disclosure link;
- one combined Feedback link for bug reports and feature requests;
- the standalone extension version in `v<version>` format.

Voice IDs are stable configuration values. Display names and gender labels are
translatable and must not be used as identifiers.

Voice and speed preferences may be persisted locally. The currently extracted
article and generated audio may not be persisted as product data.

### 4.4 UI internationalization

The popup supports English (`en`) and Vietnamese (`vi`). UI locale selection is
independent from article-language detection.

- First launch uses the browser locale when it is Vietnamese; all other browser
  locales default to English.
- The user can change the locale in the popup.
- The selected locale is persisted in `chrome.storage.local`.
- Every visible label, button, status, error, tooltip, disclosure, link label,
  context-menu label, and accessibility label uses a translation key.
- English is the fallback for a missing key or invalid stored locale.
- Translation keys must have English and Vietnamese entries before release.
- Changing the UI locale must not change the voice language used for the
  current or next article.

### 4.5 Article language behavior

The content script starts with `document.documentElement.lang` and normalizes
regional values such as `en-US` to `en`.

The Free release guarantees automatic reading for English, Vietnamese, and
Chinese page language codes supported by the bundled Supertonic runtime. It
does not translate an article. If the detected language is unsupported or
missing, the runtime uses its `na`/fallback behavior and the UI must not claim
that translation occurred.

## 5. Architecture and boundaries

```text
Active tab
  │
  ▼
Content script ── Readability extraction ── Article message
  │                                      │
  └────────────── error response        ▼
Popup ◄──── status/messages ───── Background service worker
                                             │
                                             ▼
                                      Offscreen document
                                             │
                                             ▼
                                  Supertonic 3 / ONNX Runtime
                                  WebGPU first, WASM fallback
```

### 5.1 Content script

The content script owns page interaction and extraction. It must:

- parse a cloned document so page DOM is not modified;
- return only the `Article` contract (`title`, `content`, `url`, `lang`);
- trim and validate plain text before returning success;
- return a structured failure when Readability returns no article or empty
  content;
- never make a network request with article data.

The extension does not bypass paywalls, login restrictions, DRM, or other
technical access controls.

### 5.2 Background service worker

The background worker owns message orchestration and offscreen-document
lifecycle. It must remain Free-only: no license checks, activation calls,
backend URLs, or Pro state machine.

It also owns context-menu registration, selected-text playback coordination,
and the global toolbar badge. Full-page and selected-text inputs must converge
on one session-start pipeline after producing a valid `Article`. Badge updates
must follow the serialized playback state so stale asynchronous updates cannot
overwrite the latest state.

### 5.3 Offscreen TTS

The offscreen document owns model loading, text chunking, synthesis, audio
playback, and playback state. It must:

- prefer WebGPU when available;
- fall back to WASM when WebGPU is unavailable or fails;
- download model/runtime assets only when required;
- keep article text and generated audio in memory for the session;
- expose deterministic controls for play, pause, resume, stop, and speed;
- report model-loading and playback progress to the popup.

Model assets are fetched from the configured Supertonic 3 Hugging Face
repository. These requests must contain model/runtime asset requests only, not
article content.

### 5.4 Backend boundary

The `backend/` directory is retained as a future Pro foundation. It is not
imported by the extension, started by the Free build, deployed as part of a
Free release, or included in the extension ZIP. No Free code may depend on the
availability of `api.readit.dev`.

## 6. Error handling

Errors are user-visible, localized, and safe to display. They must be mapped
to stable translation keys rather than exposing raw exception text.

Required cases:

| Case                                   | Required behavior                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Browser-restricted or unavailable page | Explain that the current page cannot be accessed and stop the session.                |
| Readability returns no article         | Show a clear “could not find a readable article” message; do not read raw page text.  |
| Article text is empty                  | Treat as extraction failure.                                                          |
| Selected text is empty after trimming  | Ignore it and preserve the active session.                                            |
| Selected-page language is unavailable  | Use the documented `na` fallback and continue.                                        |
| Model download fails                   | Show a translated retryable model-download error; do not send article data elsewhere. |
| WebGPU unavailable or fails            | Fall back to WASM and continue when possible.                                         |
| TTS/playback failure                   | Stop safely, show a translated playback error, and allow retry.                       |
| Unsupported/missing article language   | Use the documented fallback; do not claim translation.                                |
| Stop requested during loading/playback | Cancel the active session and return to the stopped state.                            |

No error event is sent to a remote service. Local developer diagnostics may be
used during development but must not ship as telemetry.

## 7. Privacy, permissions, and legal disclosures

### 7.1 Data contract

The extension may temporarily access the active tab's title, readable text,
URL, and language after the user starts reading. The data is processed inside
the browser and is not sent to readit.dev, Google Analytics, Sentry, or any
other telemetry/crash-reporting service.

The extension stores only user settings such as voice, speed, and UI locale.
It does not intentionally collect or transmit article text, generated audio,
browsing history, passwords, form data, email addresses, license keys, device
identifiers, or advertising profiles.

### 7.2 External services

The only runtime asset service is Hugging Face, used to download Supertonic 3
model/runtime files. GitHub Pages hosts the privacy policy. Explicit support
links may open Buy Me a Coffee and GitHub Issues; opening either link is a
user-initiated navigation.

The GitHub Feedback link may include the extension version and neutral bug or
feature-request prompts. It must not automatically include the current page
URL, page title, selected text, article content, or browsing history.

The privacy policy and Chrome Web Store disclosure must describe these
services, local article processing, model caching, and the absence of
telemetry.

### 7.3 Manifest permissions

The release must justify and periodically review the permissions used for:

- active-tab/page extraction;
- reading user-selected text through one context-menu action on supported
  pages;
- one-time content-script recovery after the user starts reading;
- local settings storage;
- the MV3 offscreen document and audio playback;
- model downloads from Hugging Face.

The manifest must not request identity, tabs, cookies, web history, or any
license-related permission for Free.

### 7.4 Third-party notices

The release artifact must include `THIRD_PARTY_NOTICES.txt` with attribution
and links for Supertonic 3, its OpenRAIL-M model license, MIT-licensed code,
and runtime dependencies. The notices are informational attribution and do
not replace the project's AGPL-3.0-or-later `LICENSE`.

## 8. Release and packaging requirements

The release pipeline must:

1. Validate a semantic version tag and build the extension.
2. Run strict TypeScript checking, unit tests, and Free E2E tests.
3. Verify the built manifest contains no Pro/license/API permissions or
   endpoint configuration.
4. Verify the built extension contains privacy disclosure access and
   `THIRD_PARTY_NOTICES.txt`.
5. Create a ZIP from `dist/` only.
6. Verify the ZIP contains no `backend/`, `.dev.vars`, secrets, or unrelated
   source files.
7. Publish the ZIP through the configured Chrome Web Store release flow only
   after the store privacy and permission disclosures are complete.

Backend deployment is a separate future-Pro operation and is not a prerequisite
for a Free release.

## 9. Verification matrix

The implementation is ready for release only when the following are verified:

| Area               | Acceptance criteria                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction         | A readable article starts; an unreadable/empty page shows a localized error and never falls back to raw text.                         |
| Playback           | Play, pause, resume, stop, speed, voice selection, progress, and retry work in the popup.                                             |
| Selection          | Valid selected text uses the shared playback pipeline; whitespace-only input preserves the active session.                            |
| Toolbar badge      | Loading, playing, paused, and error states map deterministically; stopped or no session clears the badge.                             |
| Popup interactions | Controls are icon-only and accessible, Stop works during loading, the footer shows `v<version>`, and Feedback supports bugs/features. |
| Runtime            | WebGPU is preferred and WASM fallback works. Model download failure is recoverable.                                                   |
| Language           | EN/VI/ZH article handling follows the documented detection/fallback contract.                                                         |
| UI i18n            | EN/VI labels, errors, accessibility text, locale selection, persistence, and English fallback work.                                   |
| Privacy            | No article data leaves the browser; no telemetry or crash-reporting request exists.                                                   |
| Feedback privacy   | GitHub receives no page URL, title, selected text, or article content from the generated Feedback link.                               |
| Free boundary      | No Pro UI, license flow, API client, or backend dependency exists in the built extension.                                             |
| Packaging          | `dist/` and the release ZIP contain the notices file and only Free extension artifacts.                                               |
| Documentation      | README, PRD, privacy policy, release/deployment docs, and ADR links agree with this spec.                                             |

## 10. Implementation delta from the current repository

The current repository already has the Free TTS orchestration, Readability
extraction, ten voice assets, release notices, and Free regression coverage.
The implementation plan must still address:

- replacing hardcoded popup strings with the EN/VI translation system;
- adding locale selection and persistence;
- translating voice names, status text, errors, controls, disclosure, and
  accessibility labels;
- aligning article-language fallback and user-facing error mapping;
- removing or preventing stale Pro/licensing/API references from the Free
  build and tests;
- updating release assertions and documentation to enforce this boundary.

These are implementation tasks, not additional product scope.
