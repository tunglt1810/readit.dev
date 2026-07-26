# PDF Service Worker Loader Design

**Date:** 2026-07-27

**Status:** Approved design

## Problem

The PDF adapter runs in the Manifest V3 background service worker. That context has no `Worker` constructor. PDF.js falls back to its fake-worker path, which dynamically imports its worker source. Chrome disallows dynamic `import()` in a service worker, so a valid text-layer PDF is reduced to `pdfExtractionFailed`.

The supplied Claude Opus 5 System Card PDF is valid: it has text on all 193 pages. The generic Playback Error therefore originates in the extension runtime rather than the file or its local-file permission check.

## Approved Design

Statically import `pdfjs-dist/build/pdf.worker.mjs` beside the existing `getDocument` import in `src/background/pdfjs_loader.ts`. That module registers `globalThis.pdfjsWorker.WorkerMessageHandler` during background-bundle evaluation. PDF.js then uses this handler in its fake-worker path without attempting dynamic import.

Remove the separate copied `assets/pdf.worker.mjs` asset and the `GlobalWorkerOptions.workerSrc` assignment. The existing PDF fetch, permission check, article conversion, error mapping, and playback path remain unchanged.

## Verification

The regression runs a fresh unpacked extension service worker and proves that `Worker` is unavailable while `pdfjsWorker.WorkerMessageHandler` is registered. It fails on the `main`-based loader and passes after the static import.
