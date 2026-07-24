# Auto-Warm Model Cache Implementation Plan

**Status:** Implemented and verified — this document is the consolidated historical record of the feature (superseding the earlier, now-deleted `2026-07-23-fix-auto-warm-model-cache.md`, `2026-07-23-p2-auto-warm-fixes.md`, and `2026-07-24-e2e-model-cache-seed-fix.md`).

**Goal:** Download all Supertonic 3 model assets into the Cache API on extension install/startup so the first Play does not require a network fetch, without adding a new ONNX inference surface or blocking normal playback when a warm is in progress.

**Architecture:** Cache-only warming runs directly in the **service worker** (not the offscreen document — see "Rejected approach" below), where the Cache API is available. `src/shared/model_cache.ts` provides a context-neutral, single-flight `fetchWithCache()`. `src/shared/warm_cache.ts` is a pure, dependency-injected coordinator that loops over `MODEL_FILES`, skipping URLs already in Cache Storage. `src/background/model_cache_warmer.ts` wraps one `runWarm()` call in a single-flight promise so concurrent `onInstalled`/`onStartup` events (and a concurrent Play) share it; `src/background/model_cache_lifecycle.ts` registers that warm against `chrome.runtime.onInstalled`/`onStartup` through a Chrome-free, testable interface. `startPlayback()` waits for an in-progress warm to settle (`waitForCurrentWarm()`) before creating the offscreen document, so the service worker and the offscreen document never race a fetch for the same uncached URL — but it tolerates a warm rejection and falls through to the existing offscreen model loader. The offscreen document's responsibility stays narrowed to TTS synthesis and audio playback; it has no warm-cache protocol.

**Rejected approach (superseded):** The first implementation ran warming inside the **offscreen document** via a `WARM_CACHE` runtime message, with the background service worker creating the offscreen document just to warm it. This was corrected because Chrome closes an `AUDIO_PLAYBACK` offscreen document ~30 seconds after audio stops, so a large model download had no guaranteed host to finish in. Moving warming into the service worker (which has direct Cache API access and its own lifecycle) removed that dependency entirely.

**Tech Stack:** Chrome Extension Manifest V3 service worker, Cache API, TypeScript, `node:test`, Playwright.

## File Structure

- `src/shared/model_cache.ts` — `MODEL_CACHE_NAME` (`'supertonic-models'`) and single-flight `fetchWithCache(url, progressCallback?)`, usable from both the service worker and the offscreen document.
- `src/shared/warm_cache.ts` — pure `warmCache(deps: WarmCacheDeps): Promise<void>`; skips cached URLs, forwards progress only for a fetched URL, calls `onComplete()` only if every URL settled without throwing.
- `src/background/model_cache_warmer.ts` — `createModelCacheWarmer(runWarm)` → `{ warm(), waitForCurrentWarm() }`; one in-flight promise, cleared in `finally` so a later lifecycle event can retry after a failure.
- `src/background/model_cache_lifecycle.ts` — `registerModelCacheWarmLifecycle(events, warm)`; attaches `warm()` to `onInstalled` and `onStartup` through a structural (Chrome-free) event interface.
- `src/background/background.ts` — constructs the one shared `modelCacheWarmer`, registers the lifecycle triggers, keeps the service worker alive with a 20s heartbeat while a warm is active (`keepServiceWorkerAlive()`), and gates `startPlayback()` on `waitForCurrentWarm()` before `setupOffscreen()`.
- `src/background/offscreen_transport.ts` — `sendOffscreenCommand()` sends a command exactly once (no warm-driven retry loop) and lets a transport rejection propagate so callers can clean up the session.
- `src/offscreen/offscreen.ts` / `src/offscreen/supertonic_helper.ts` — TTS/audio only; import the shared `fetchWithCache()` for lazy per-Play model loading, no `WARM_CACHE` message handling.
- `tests/unit/fetch_with_cache.test.ts`, `tests/unit/warm_cache.test.ts`, `tests/unit/model_cache_warmer.test.ts`, `tests/unit/model_cache_lifecycle.test.ts`, `tests/unit/offscreen_transport.test.ts` — unit coverage for every module above.
- `tests/e2e/global_setup.ts`, `tests/e2e/model_cache_seed.ts`, `tests/e2e/extension_id.ts`, `tests/e2e/fixtures.ts` — e2e test infrastructure that pre-warms a real Chrome profile once so per-test runs don't race real network I/O against the warm-serialization behavior above (see Task 4).

---

## Task 1: Shared cache module and pure warm coordinator

**Files:** `src/shared/model_cache.ts`, `src/shared/warm_cache.ts`, `tests/unit/fetch_with_cache.test.ts`, `tests/unit/warm_cache.test.ts`

- [x] `fetchWithCache(url, progressCallback?)` keeps one in-flight `Promise<ArrayBuffer>` per URL (`inFlightCacheFetches: Map<string, Promise<ArrayBuffer>>`), so concurrent callers for the same uncached URL share one network request; the map entry is removed on either fulfillment or rejection so a later call can retry.
- [x] `warmCache(deps: WarmCacheDeps)` is a pure sequential loop with **no internal error handling** — a `fetchAndCache` rejection propagates out of `warmCache()` immediately (does not attempt remaining URLs, does not call `onComplete()`), so the caller can distinguish an incomplete warm from a completed one.
- [x] Unit tests cover: cache hit skips fetch, cache miss fetches once and is shared across concurrent callers, a rejected fetch is retried on the next call, progress is forwarded only for a fetched (not cached) URL, and `onComplete()` is never called when a fetch fails.

Verify: `pnpm test:unit` (covers `fetch_with_cache.test.ts` and `warm_cache.test.ts`).

## Task 2: Background lifecycle warmer and Play serialization

**Files:** `src/background/model_cache_warmer.ts`, `src/background/model_cache_lifecycle.ts`, `src/background/background.ts`, `tests/unit/model_cache_warmer.test.ts`, `tests/unit/model_cache_lifecycle.test.ts`

- [x] `createModelCacheWarmer(runWarm)` returns `warm()` (idempotent — returns the same in-flight promise identity to overlapping callers, deliberately non-`async` so it hands back the exact stored promise) and `waitForCurrentWarm()` (resolves immediately when idle, otherwise waits for the active run and **tolerates** its rejection at the call site).
- [x] `registerModelCacheWarmLifecycle({ onInstalled, onStartup }, warm)` attaches one listener to each event through a structural interface with no Chrome import, so it's unit-testable with fake event emitters.
- [x] `background.ts` constructs one shared `modelCacheWarmer` wired to a real `warmCache({ urls: Object.values(MODEL_FILES), isCached, fetchAndCache, onProgress, onComplete })` run, wrapped in `keepServiceWorkerAlive()` (a 20s `chrome.runtime.getPlatformInfo()` heartbeat, cleared in `finally`) so the worker isn't killed mid-download.
- [x] `registerModelCacheWarmLifecycle()` is called once at module load with `onInstalled`/`onStartup` bound to a `beginModelCacheWarm()` wrapper that swallows a warm rejection (non-critical — a later lifecycle event or normal Play still works).
- [x] `startPlayback()` calls `await modelCacheWarmer.waitForCurrentWarm()` (wrapped in try/catch) immediately before `await setupOffscreen()`, so the service worker and the offscreen document never fetch the same uncached URL concurrently. A warm failure does not block Play — it falls through to the existing offscreen model-load path.
- [x] Unit tests cover: two concurrent `warm()` calls share one `runWarm` invocation and the same promise identity; a rejected run clears itself so the next lifecycle event retries; `waitForCurrentWarm()` resolves immediately when idle and waits correctly when active; `onInstalled`/`onStartup` each trigger exactly one `warm()` call through fake Chrome-free event emitters, and through **real** `chrome.runtime.onInstalled`/`onStartup`-shaped fakes (P2 hardening, Task 3 below).

Verify: `pnpm test:unit`, `pnpm build`.

## Task 3: Hardening — transport error propagation and lifecycle test realism (P2 code review fixes)

**Files:** `src/background/offscreen_transport.ts`, `src/background/background.ts`, `tests/unit/offscreen_transport.test.ts`, `tests/unit/model_cache_lifecycle.test.ts`, `tests/unit/model_cache_warmer.test.ts`

A code-review pass on Task 1-2 found two P2 gaps, closed here:

- [x] **Transport error propagation:** `sendOffscreenCommand()` no longer swallows a `sendMessage` rejection in a `try/catch` — it lets the rejection propagate so callers' own `catch` blocks run. `routeSessionCommand()` and `changeSpeed()` in `background.ts` now check `if (!response.success)` explicitly and call `failSession()` + `closeOffscreenWhenIdle()` on that path too (previously only the `catch` branch did this, missing the "response resolved but reported failure" case).
- [x] Added a unit test asserting `sendOffscreenCommand()` rethrows a transport rejection (`/Extension context invalidated/`), and that a malformed/`undefined` response still normalizes to `{ success: false }`.
- [x] **Lifecycle test realism:** added a unit test that binds `registerModelCacheWarmLifecycle()` against fakes shaped exactly like `chrome.runtime.onInstalled`/`onStartup` (not just a generic `{ addListener, emit }` double), and a "Play-during-warm" test asserting `waitForCurrentWarm()` blocks a simulated `setupOffscreen()` call until the warm settles — for both a successful warm and a rejected one (the gate must tolerate the rejection and still let Play proceed).

Verify: `pnpm test:unit` (216 tests pass), `pnpm build`.

## Task 4: E2E test reliability — pre-seeded model cache profile

**Files:** `tests/e2e/extension_id.ts`, `tests/e2e/model_cache_seed.ts`, `tests/e2e/global_setup.ts`, `tests/e2e/fixtures.ts`, `playwright.config.ts`

**Problem found during verification:** `tests/e2e/fixtures.ts`'s `context` fixture starts every single test from a brand-new, empty Chrome profile. On a fresh profile, `onInstalled` fires and the real auto-warm from Task 2 starts downloading the six `MODEL_FILES` (~400 MB total) from Hugging Face. Because `startPlayback()` correctly waits for that warm to settle before creating the offscreen document (Task 2's serialization), any e2e test that triggers `START_CURRENT_PAGE`/`START_MANUAL_TEXT` etc. does not get a response until the real download finishes — which reliably exceeds the tests' short internal timeouts (2-5s). Two approaches were tried and rejected: `context.route()` cannot intercept requests from a service worker (Playwright's own documented limitation), and blocking `huggingface.co` at the network level makes the background warm fail fast but also breaks other tests that depend on the offscreen document's own lazy per-Play model load succeeding for real.

- [x] `tests/e2e/extension_id.ts` extracts the wake-page/service-worker extension-ID detection (previously inlined in the `extensionId` fixture) so it can be reused by both the per-test fixture and the one-time seed below.
- [x] `tests/e2e/global_setup.ts` (registered via `playwright.config.ts`'s `globalSetup`) launches a real persistent Chrome context once, lets the real auto-warm complete for real (polling Cache Storage for all six `MODEL_FILES` URLs, generous 900s ceiling to tolerate slow/throttled networks), then closes it. A marker file (`.tmp/e2e-model-cache-seed/.seed-complete.json`, pinned to the current `MODEL_FILES` URL list) makes this a no-op on every subsequent run unless the model URLs change.
- [x] `tests/e2e/fixtures.ts`'s `context` fixture clones that seed profile (`fs.cpSync`, ~0.4s) into each test's own fresh temp directory instead of starting empty, then strips `SingletonLock`/`SingletonCookie`/`SingletonSocket` so the clone can be launched independently. This keeps full per-test isolation (each test still gets its own throwaway profile) while the model Cache Storage is already populated when Chrome launches — so `isCached()` is true for all six URLs immediately, `waitForCurrentWarm()` resolves in milliseconds instead of tens of seconds, and the real, valid ONNX bytes are still used by any test that goes through actual offscreen model loading.

Verify:
```bash
CI=true pnpm test:e2e          # 90 passed, run twice to confirm no flakiness
pnpm test:unit                 # 216 pass
pnpm build                     # succeeds
```

## Task 5: Fix the selection-button re-enable flake exposed by Task 4's verification

**Files:** `tests/e2e/selection-button.spec.ts`

Task 4's verification runs surfaced one more, **unrelated** intermittent failure: `popup setting disables and re-enables the affordance in an open tab` occasionally timed out waiting for the selection-button UI to appear after re-enabling the affordance from the popup.

- [x] **Root cause:** re-checking the popup toggle writes `chrome.storage.local`; the content script only learns about it through `chrome.storage.onChanged` — a real cross-process IPC hop measured at ~100-150ms even on an idle machine. The test dispatched its synthetic `pointerup` right after re-checking the toggle, leaving only ~16ms of natural margin; under CPU contention that margin flips, the content script reads a stale cached `enabled` flag, and no other event re-triggers it.
- [x] **Fix:** added `selectAndAwaitButtonAfterToggle()`, which retries the selection (via `expect(...).toPass()`) until the button becomes visible instead of assuming the storage change has already propagated by the time the synthetic `pointerup` fires — mirroring the self-healing `toHaveCount(0)` pattern already used for the disable path in the same test.

Verify: `CI=true pnpm exec playwright test tests/e2e/selection-button.spec.ts --repeat-each=5`.

---

## Verification (final, consolidated)

```bash
pnpm test:unit                 # 216 pass, 0 fail
pnpm build                     # tsc + rsbuild build succeed
CI=true pnpm test:e2e          # 90 passed
```

Manual acceptance (Chrome DevTools):
1. Load `dist/` as an unpacked extension in a fresh profile without opening the popup first.
2. **Application → Cache Storage → supertonic-models** gains all six `MODEL_FILES` entries (four `.onnx`, `unicode_indexer.json`, `tts.json`) without any Play interaction.
3. Press Play while a warm is still in progress: the click waits for that warm to settle, then plays — DevTools shows no duplicate request for an already-cached URL.
4. Clear Cache Storage, restart the browser: `onStartup` warms again.
