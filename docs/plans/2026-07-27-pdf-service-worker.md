# PDF Service Worker Loader Implementation Plan

**Goal:** Load text-layer PDFs in the Manifest V3 background service worker without forbidden dynamic worker import.

**Architecture:** Package PDF.js's worker module statically in the background entry. PDF.js detects the resulting global handler and uses its fake-worker path locally.

## Steps

1. Add a fresh-service-worker Playwright regression that expects `Worker` to be unavailable and `pdfjsWorker.WorkerMessageHandler` to be present.
2. Build and run the regression against the main-based loader; expect it to fail with an undefined handler.
3. Statically import `pdfjs-dist/build/pdf.worker.mjs` in `src/background/pdfjs_loader.ts`, and remove the copied worker asset from `rsbuild.config.ts`.
4. Rebuild and rerun the regression; expect it to pass.
5. Run the PDF unit tests, manifest validation, PDF Playwright tests, full E2E suite, and `git diff --check`. Record the pre-existing SettingsCard translation unit failure separately.
