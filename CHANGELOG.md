# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- enhance Chrome Web Store upload process with detailed logging and status checks - [@tunglt1810]


## [1.0.2] - 2026-07-22

### Added

- Add Side Panel reading workspace - [@tunglt1810]
- Open Side Panel from popup - [@tunglt1810]
- Add Side Panel extension entry - [@tunglt1810]
- Coordinate manual text playback - [@tunglt1810]
- Prepare manual text locally - [@tunglt1810]

### Changed

- Distinguish manual playback sessions - [@tunglt1810]
- Move Buy me a coffee into Popup and Side Panel headers and place Theme in Settings - [@tunglt1810]

### Fixed

- Harden Side Panel runtime transport - [@tunglt1810]
- Preserve Side Panel user gesture - [@tunglt1810]
- Reject manual playback metadata - [@tunglt1810]

### Chore

- Tighten Free network boundary - [@tunglt1810]
- Finalize Side Panel release behavior - [@tunglt1810]
- Cover manual playback replacement privacy - [@tunglt1810]
- Add side panel implementation plan - [@tunglt1810]
- Add side panel manual text design - [@tunglt1810]

## [1.0.1] - 2026-07-18

### Added

- Highlight the currently spoken word during TTS playback - [@tunglt1810]

### Chore

- Design README extension flow diagram - [@tunglt1810]
- Refactor docs folder - [@tunglt1810]

## [1.0.0] - 2026-07-17

### Added

- Add selected-text floating read button - [@tunglt1810]
- Refine classic player themes - [@tunglt1810]
- Merge classic themes and review fixes - [@tunglt1810]
- Add classic Winamp and WMP12 themes with i18n - [@tunglt1810]
- Add Latin speech segmentation and pauses - [@tunglt1810]
- Add weighted speech segmentation and playback - [@tunglt1810]
- Improve UX and Vietnamese NSW processing - [@tunglt1810]
- Improve extension interactions - [@tunglt1810]
- Build initial MVP - [@tunglt1810]

### Changed

- Enhance theme selector UI and improve pause duration for speech synthesis - [@tunglt1810]

### Fixed

- Attach selection-button listeners before storage read resolves - [@tunglt1810]
- Normalize Vietnamese semantic text - [@tunglt1810]

### Chore

- Run extension e2e headlessly in parallel - [@tunglt1810]
- Migrate to Rsbuild 2.1 - [@tunglt1810]
- Optimize playwright config to reduce annoying flash chrome test window spam - [@tunglt1810]
- Ignore worktree directories - [@tunglt1810]
- Refresh popup styling and brand assets - [@tunglt1810]

## [0.1.0] - 2026-07-12

### Changed

- Upgraded all dependencies to their latest versions and pinned them. - [@tunglt1810]

### Fixed

- Fixed a TypeScript compile error in `background.ts` caused by a return-type change in the Chrome types library. - [@tunglt1810]
- Fixed CSP and `importScripts` issues with Blob URLs by limiting WASM execution to a single thread (`ort.env.wasm.numThreads = 1`). - [@tunglt1810]
- Fixed `Cannot use import statement outside a module` in `content_script` by building the content script as an independent IIFE bundle (`vite.config.content.ts`). - [@tunglt1810]
- Fixed `no available backend found. ERR: [wasm]` by declaring `.wasm` files in `web_accessible_resources` so Chrome allows the Web Worker to load local files. - [@tunglt1810]
