# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Upgraded all dependencies to their latest versions and pinned them. — [@bez]

### Fixed

- Fixed a TypeScript compile error in `background.ts` caused by a return-type change in the Chrome types library. — [@bez]
- Fixed CSP and `importScripts` issues with Blob URLs by limiting WASM execution to a single thread (`ort.env.wasm.numThreads = 1`). — [@bez]
- Fixed `Cannot use import statement outside a module` in `content_script` by building the content script as an independent IIFE bundle (`vite.config.content.ts`). — [@bez]
- Fixed `no available backend found. ERR: [wasm]` by declaring `.wasm` files in `web_accessible_resources` so Chrome allows the Web Worker to load local files. — [@bez]
