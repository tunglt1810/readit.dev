# Playwright Headless Parallel E2E Design

## Goal

Make routine extension E2E runs visually quiet and faster: `pnpm test:e2e` must not open or focus Chromium windows, while an explicit headed debug run remains available.

## Root Cause

`tests/e2e/fixtures.ts` owns browser startup through `chromium.launchPersistentContext(...)`. The fixture currently forces `headless: false`, creates a new persistent context for every test, and closes it after the test. `--start-minimized` runs too late to prevent macOS from focusing the newly launched application, so every short test can still flash a window.

`playwright.config.ts` also forces `workers: 1`. This serializes test files but does not reduce the number of browser contexts because the context fixture remains test-scoped. Each context already receives a unique `mkdtemp` profile, so the current implementation does not require a single worker to avoid profile locks.

## Selected Design

### Routine execution

- Remove the explicit `workers: 1` setting and use Playwright's default worker count.
- Keep `fullyParallel: false`, so tests within one file remain ordered while independent files can run in parallel.
- Make the custom context fixture consume Playwright's `headless` option instead of hard-coding `false`.
- Launch with `channel: 'chromium'`, which Playwright documents as the supported channel for headless Chrome-extension testing.
- Remove `--start-minimized`; a headless process has no window to minimize.

The default command remains:

```bash
pnpm test:e2e
```

It runs headlessly because Playwright's default is headless.

### Debug execution

The same fixture respects Playwright's CLI override:

```bash
pnpm exec playwright test --headed
```

This is the only routine path that intentionally opens Chromium. Debug mode may take focus; the non-disruptive guarantee applies to the default headless command.

### Isolation

Keep the persistent context test-scoped and retain the unique `.tmp/playwright-chrome-profile-*` directory per test. This preserves storage, session, locale, and playback isolation and allows separate workers to run safely.

Do not make the context worker-scoped. Sharing it would still open a visible window in headed mode and would require explicit reset logic for `chrome.storage`, local storage, pages, routes, sessions, and playback state.

## Scope

### In scope

- `playwright.config.ts`: restore default worker parallelism.
- `tests/e2e/fixtures.ts`: use the Playwright headless option, the Chromium channel, and remove minimize behavior.
- Verification of default headless and explicit headed launch paths.

### Out of scope

- Sharing one browser or context across tests.
- Changing test assertions or application behavior.
- Adding worker-specific storage reset infrastructure.
- Cleaning historical profile directories already left under `.tmp`.

## Verification

1. A pre-change contract check must fail because the fixture forces `headless: false`, includes `--start-minimized`, and config forces one worker.
2. TypeScript and Biome checks must pass after the config change.
3. A focused default-mode probe must load the MV3 service worker in headless Chromium without a visible window.
4. A focused `--headed` probe must still load the extension when explicitly requested; it should be kept short to avoid disrupting the desktop.
5. The full default `CI=true pnpm test:e2e` suite must pass with more than one worker when the machine exposes enough capacity.
6. `git diff --check` must pass and unrelated `context_improvement.md` must remain untouched.

The OS-level focus event has no stable repository-local assertion seam. The regression boundary is therefore the launch-mode contract plus a real headless extension run, rather than a mocked unit test that cannot observe application focus.

## Success Criteria

- Default E2E execution creates no visible Chromium window and does not steal focus.
- The suite is no longer globally restricted to one worker.
- `--headed` remains an explicit debugging option.
- All existing E2E tests retain isolated profiles and pass without application changes.

## References

- [Playwright: Chrome extensions](https://playwright.dev/docs/chrome-extensions)
- [Playwright: Parallelism](https://playwright.dev/docs/test-parallel)
- [Playwright: Command line](https://playwright.dev/docs/test-cli)
