# Auto-Warm Model Cache on Install

Automatically download Supertonic 3 model files into the Cache API immediately
after the extension is installed or updated, so the first Play action does not
require a network fetch.

## Problem

The four ONNX model files (~400 MB total — `vector_estimator.onnx` alone is
~256 MB — plus two small config files) are only fetched the first time the
user presses Play. This causes a long initial wait.

## Design

### Trigger

- `chrome.runtime.onInstalled` — fresh install or extension update
- `chrome.runtime.onStartup` — browser restart; ensures the cache survives
  eviction or manual clearing

### Flow

```text
onInstalled / onStartup
  → background service worker: warm Cache API
    → check each MODEL_FILES URL in Cache Storage
    → missing → fetchWithCache(url, progressCallback)
    → broadcast MODEL_LOADING_PROGRESS
```

Note: The offscreen document is not created by cache warming. It is created lazily when playback begins and ONNX sessions are required.

### Conflict with Playback

- If the user presses Play while warm is in progress, `startPlayback()` waits for the active service-worker warm to settle before creating the offscreen document.
- On a warm failure, Play proceeds through the existing offscreen cache/model loader.
- Warm cache only populates the Cache API; it does not create ONNX `InferenceSession` objects or audio contexts.

### Warm Level

- Cache API only (download files directly to browser Cache Storage in the service worker).
- ONNX `InferenceSession` instances are created lazily in the offscreen document when `initModels()` runs at Play time.

## Architecture & Responsibilities

### Service Worker (`src/background/background.ts`)

- Runs `modelCacheWarmer` on `onInstalled` and `onStartup`.
- Downloads missing `MODEL_FILES` into `supertonic-models` Cache Storage directly in the background worker.
- Emits `MODEL_LOADING_PROGRESS` events for popup/sidepanel UI.
- Keeps worker alive via `keepServiceWorkerAlive` heartbeat while download is active.
- `startPlayback()` awaits `modelCacheWarmer.waitForCurrentWarm()` before `setupOffscreen()`.

### Offscreen Document (`src/offscreen/offscreen.ts`)

- Handles TTS synthesis and audio playback only.
- Created lazily when Play begins; no `WARM_CACHE` protocol exists.

### Shared Cache Module (`src/shared/model_cache.ts` & `src/shared/warm_cache.ts`)

- Provides context-neutral `MODEL_CACHE_NAME`, `fetchWithCache()`, and pure `warmCache()` coordinator.

## Verification

- Install the extension fresh → verify model files appear in Cache Storage (`supertonic-models`) via DevTools → Application → Cache Storage
- Open the popup while downloading → confirm the progress bar is visible
- Press Play after the cache is warm → no network fetch; Play is near-instant
- Clear Cache Storage → restart browser → model files download again
