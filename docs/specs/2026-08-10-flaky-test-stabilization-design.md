# Flaky Test Stabilization — Root Cause Fix

## Problem

2 e2e tests fail intermittently during full suite runs (182 tests, ~19 minutes) but pass when run individually:

1. **`word-highlight.spec.ts:780`** — `net::ERR_ABORTED; maybe frame was detached?` when `page.goto()` navigates to a routed URL. Occurs after ~170 preceding tests run.
2. **`reading-state.spec.ts:338`** — Session stuck in `loading` indefinitely, timing out at 240s. Test runs in the `chromium-audio` project (headed mode), which always runs last after the entire `chromium` project finishes.

## Root Causes

### Cause 1: Lack of startup timeout in `loadAndPlay`

`startPlayback` returns `{ success: true }` immediately and delegates `loadAndPlay` to run asynchronously:

```ts
pendingStart = loadAndPlay(session, playPayload, input).catch(() => undefined);
return { success: true };
```

`loadAndPlay` dispatches the PLAY command via `observeOffscreenPlay` (fire-and-forget) and returns. Session transition to `playing` relies on the offscreen document reporting back on its own. **No timeout guard exists** — if the offscreen document loads slowly, the PLAY command is lost, or the report message fails to arrive, the session remains in `loading` indefinitely.

This is a **production bug** — affecting user behavior, not just tests.

### Cause 2: Resource pressure after full suite run

182 tests run sequentially, with each test launching/closing a Chrome persistent context. After 170+ cycles:
- Orphan Chrome helper processes accumulate
- OS memory pressure increases
- Chrome navigation stability degrades → causing `net::ERR_ABORTED`

The `chromium-audio` project runs last in headed mode and is most sensitive to resource pressure.

### Cause 3: Missing test resilience

- `word-highlight:780` uses a default 30s timeout for 35+ IPC iterations — too tight
- No navigation retry mechanism for `page.goto` — single point of failure

## Proposed Changes

### 1. Startup Timeout Guard in `loadAndPlay`

**File**: [`background.ts`](file:///Users/bez/Workspace/repos/bez/readit.dev/src/background/background.ts)

After `observeOffscreenPlay` dispatches, set a 20-second `setTimeout`. Upon firing:
- Verify session matches the same `sessionId` AND status remains `loading`
- If true, call `failPendingStart(session.sessionId)` → transition session to `error`
- If session has transitioned to `playing`/`paused`/`stopped`/`error`, the timeout no-ops

```ts
// End of loadAndPlay, after observeOffscreenPlay:
const STARTUP_TIMEOUT_MS = 20_000;
setTimeout(() => {
    if (activeSession?.sessionId === session.sessionId && activeSession?.status === 'loading') {
        void failPendingStart(session.sessionId);
    }
}, STARTUP_TIMEOUT_MS);
```

The `STARTUP_TIMEOUT_MS` constant is declared alongside existing timeout constants in the file.

### 2. Orphan Chrome Process Cleanup

**File**: [`global_setup.ts`](file:///Users/bez/Workspace/repos/bez/readit.dev/tests/e2e/global_setup.ts)

Add function `killOrphanChromeProcesses()` — using `execSync('pkill')` or `pgrep`/`kill` to terminate orphan Chromium processes before the suite begins. Call inside `globalSetup()` right after `cleanOrphanProfiles()`.

**File**: [`playwright.config.ts`](file:///Users/bez/Workspace/repos/bez/readit.dev/playwright.config.ts)

Add `globalTeardown` script running a cleanup function after the entire suite finishes.

Add `teardown` project: create project `chromium-cleanup` running between `chromium` and `chromium-audio` to kill orphan processes.

> **Note**: Playwright 1.35+ supports `project.teardown`. Check version before using. Fall back to `dependencies` pattern or `globalTeardown` if version is lower.

### 3. Word-highlight Test Hardening

**File**: [`word-highlight.spec.ts`](file:///Users/bez/Workspace/repos/bez/readit.dev/tests/e2e/word-highlight.spec.ts)

- Add `test.setTimeout(60_000)` — sufficient for 35+ word iterations
- Wrap `page.goto` inside a retry helper (max 2 retries, 1s backoff):

```ts
async function gotoWithRetry(page: Page, url: string, options?: Parameters<Page['goto']>[1], retries = 2): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await page.goto(url, options);
            return;
        } catch (error) {
            if (attempt >= retries) throw error;
            await new Promise(r => setTimeout(r, 1_000));
        }
    }
}
```

Place helper in `fixtures.ts` for reuse across tests.

## Verification Plan

### Automated Tests
- `pnpm test:unit` — regression check, 583/583 pass required
- `pnpm test:e2e` — full suite, target 182/182 pass
- Run full suite 3 consecutive times to confirm stability

### Manual Verification
- Verify startup timeout functionality: simulate offscreen load failure → session transitions to error within 20s rather than hanging indefinitely
