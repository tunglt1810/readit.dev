# Flaky Test Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate 2 flaky e2e test failures by fixing the root cause (missing startup timeout in production code) and hardening test infrastructure (orphan process cleanup + navigation retry).

**Architecture:** Three independent changes: (1) a startup timeout guard in `loadAndPlay` that transitions a stuck `loading` session to `error` after 20s, (2) orphan Chrome process cleanup in globalSetup + a teardown project between `chromium` and `chromium-audio`, (3) navigation retry helper + custom timeout for the word-highlight full-article test.

**Tech Stack:** TypeScript, Playwright 1.61.0, Chrome Extension MV3

## Global Constraints

- Follow existing Biome formatting: tabs, 4-space tab width, LF endings, 140-char line width
- `pnpm test:unit` must stay at 583/583 pass
- `pnpm test:e2e` must pass 182/182 in full suite run
- No new dependencies

---

### Task 1: Startup Timeout Guard in `loadAndPlay`

**Files:**
- Modify: `src/background/background.ts:92-99` (add timeout error message)
- Modify: `src/background/background.ts:984-988` (add timeout guard after `observeOffscreenPlay`)
- Test: `tests/unit/command_queue.test.ts` (existing — verify no regression)

**Interfaces:**
- Consumes: `failPendingStart(sessionId)` (existing, line 1178), `activeSession` (existing module-level state), `ERROR_MESSAGES` (existing constant)
- Produces: `STARTUP_TIMEOUT_MS` constant (20000), used only internally by `loadAndPlay`

- [ ] **Step 1: Add startup timeout error message to ERROR_MESSAGES**

In `src/background/background.ts`, add a new entry to `ERROR_MESSAGES` at line 98:

```ts
const ERROR_MESSAGES = {
	activeTab: 'Không tìm thấy trang web đang hoạt động.',
	restrictedPage: 'Tiện ích không thể chạy trên trang này. Vui lòng sử dụng trên một trang web bài viết khác.',
	extraction: 'Không thể trích xuất nội dung từ trang web này. Vui lòng tải lại trang và thử lại.',
	noSession: 'Không có phiên đọc đang hoạt động.',
	setup: 'Không thể bắt đầu đọc trang này. Vui lòng thử lại.',
	startupTimeout: 'Khởi tạo phát âm thanh quá lâu. Vui lòng thử lại.',
	invalidSpeed: 'Tốc độ đọc không hợp lệ.',
} as const;
```

- [ ] **Step 2: Add STARTUP_TIMEOUT_MS constant and timeout guard in loadAndPlay**

Add constant near line 132 (after `pendingStart` declaration):

```ts
let pendingStart: Promise<void> | null = null;
const STARTUP_TIMEOUT_MS = 20_000;
```

Modify `loadAndPlay` — after `observeOffscreenPlay` call (line 984-987), add the timeout guard before the closing brace:

```ts
	observeOffscreenPlay(session.sessionId, {
		action: 'PLAY',
		payload: playPayload,
	});

	// Guard against offscreen never reporting back — if the session is still loading
	// after STARTUP_TIMEOUT_MS, transition to error rather than hanging indefinitely.
	setTimeout(() => {
		if (activeSession?.sessionId === session.sessionId && activeSession?.status === 'loading') {
			void failPendingStart(session.sessionId);
		}
	}, STARTUP_TIMEOUT_MS);
}
```

- [ ] **Step 3: Run unit tests to verify no regression**

Run: `pnpm test:unit`
Expected: 583/583 pass, 0 fail

- [ ] **Step 4: Run build to verify TypeScript compiles**

Run: `pnpm build`
Expected: Build succeeds with no type errors

- [ ] **Step 5: Commit**

```bash
 git add src/background/background.ts
 git commit -m "fix: add startup timeout guard to prevent session stuck at loading"
```

---

### Task 2: Orphan Chrome Process Cleanup

**Files:**
- Modify: `tests/e2e/global_setup.ts` (add `killOrphanChromeProcesses` function)
- Create: `tests/e2e/global_teardown.ts` (cleanup after full suite)
- Create: `tests/e2e/chromium_cleanup.ts` (teardown project test file)
- Modify: `playwright.config.ts` (add `globalTeardown` + `chromium-cleanup` teardown project)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `killOrphanChromeProcesses()` function (exported from `global_setup.ts`, reused by `global_teardown.ts` and `chromium_cleanup.ts`)

- [ ] **Step 1: Add `killOrphanChromeProcesses` to global_setup.ts**

In `tests/e2e/global_setup.ts`, add after the `cleanOrphanProfiles` function (after line 67):

```ts
function killOrphanChromeProcesses(): void {
	if (process.platform !== 'darwin' && process.platform !== 'linux') {
		return;
	}
	try {
		const { execSync } = require('child_process');
		// Kill orphan Chromium/Chrome helper processes that outlived their test context.
		// The --signal TERM gives them a clean shutdown chance before force-killing.
		execSync('pkill -f "chromium.*--test-type" 2>/dev/null || true', { stdio: 'ignore' });
		execSync('pkill -f "chrome.*--test-type" 2>/dev/null || true', { stdio: 'ignore' });
	} catch (_error) {
		// pkill returns non-zero when no matching processes exist — safe to ignore.
	}
}

export { killOrphanChromeProcesses };
```

Call it in `globalSetup()` before `cleanOrphanProfiles()`:

```ts
export default async function globalSetup(): Promise<void> {
	killOrphanChromeProcesses();
	cleanOrphanProfiles();
	// ... rest unchanged
```

- [ ] **Step 2: Create global_teardown.ts**

Create `tests/e2e/global_teardown.ts`:

```ts
import { killOrphanChromeProcesses } from './global_setup';

export default async function globalTeardown(): Promise<void> {
	killOrphanChromeProcesses();
}
```

- [ ] **Step 3: Create chromium_cleanup.ts teardown project test**

Create `tests/e2e/chromium_cleanup.ts`:

```ts
import { test } from '@playwright/test';
import { killOrphanChromeProcesses } from './global_setup';

test('cleanup orphan chrome processes between projects', async () => {
	killOrphanChromeProcesses();
	// Brief pause to let OS reclaim resources.
	await new Promise((resolve) => setTimeout(resolve, 2_000));
});
```

- [ ] **Step 4: Update playwright.config.ts**

Add `globalTeardown`, add `chromium-cleanup` teardown project, and wire dependencies:

```ts
import { defineConfig, devices } from '@playwright/test';

const AUDIO_LIFECYCLE_TEST = /resumes the same session after Chrome audio idle cutoff/;

export default defineConfig({
	testDir: './tests/e2e',
	globalSetup: './tests/e2e/global_setup.ts',
	globalTeardown: './tests/e2e/global_teardown.ts',
	timeout: 30 * 1000,
	expect: {
		timeout: 5000,
	},
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: 'html',
	use: {
		trace: 'on-first-retry',
		video: 'on-first-retry',
	},
	projects: [
		{
			name: 'chromium',
			grepInvert: AUDIO_LIFECYCLE_TEST,
			use: {
				...devices['Desktop Chrome'],
			},
		},
		{
			name: 'chromium-cleanup',
			testMatch: /chromium_cleanup\.ts/,
			dependencies: ['chromium'],
		},
		{
			name: 'chromium-audio',
			testMatch: /reading-state\.spec\.ts/,
			grep: AUDIO_LIFECYCLE_TEST,
			dependencies: ['chromium-cleanup'],
			use: {
				...devices['Desktop Chrome'],
				headless: false,
			},
		},
	],
});
```

- [ ] **Step 5: Run build to verify TypeScript compiles**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
 git add tests/e2e/global_setup.ts tests/e2e/global_teardown.ts tests/e2e/chromium_cleanup.ts playwright.config.ts
 git commit -m "test: add orphan Chrome process cleanup between e2e projects"
```

---

### Task 3: Word-highlight Test Navigation Retry + Timeout

**Files:**
- Modify: `tests/e2e/fixtures.ts` (add `gotoWithRetry` helper)
- Modify: `tests/e2e/word-highlight.spec.ts:780-820` (use retry helper + custom timeout)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `gotoWithRetry(page, url, options?, retries?)` helper (exported from `fixtures.ts`)

- [ ] **Step 1: Add `gotoWithRetry` helper to fixtures.ts**

At the end of `tests/e2e/fixtures.ts` (after existing exports), add:

```ts
/**
 * Retries page.goto on transient navigation failures (e.g. net::ERR_ABORTED)
 * that occur under Chrome resource pressure during long suite runs.
 */
export async function gotoWithRetry(
	page: Page,
	url: string,
	options?: Parameters<Page['goto']>[1],
	retries = 2,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await page.goto(url, options);
			return;
		} catch (error) {
			if (attempt >= retries) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
}
```

- [ ] **Step 2: Update word-highlight test to use retry + custom timeout**

In `tests/e2e/word-highlight.spec.ts`, add import for `gotoWithRetry`:

```ts
import { gotoWithRetry } from './fixtures';
```

In the test at line 780, add `test.setTimeout(60_000)` and replace `page.goto` with `gotoWithRetry`:

```ts
test('highlights every real word of a realistic multi-paragraph Vietnamese article in order, with no dead zones', async ({ context }) => {
	test.setTimeout(60_000);
	// ... existing code unchanged until line 819-820 ...
	const page = await context.newPage();
	await gotoWithRetry(page, targetUrl, { waitUntil: 'domcontentloaded' });
	// ... rest unchanged ...
```

- [ ] **Step 3: Run the specific test to verify it passes**

Run: `pnpm test:e2e --grep "highlights every real word"`
Expected: 1 passed

- [ ] **Step 4: Commit**

```bash
 git add tests/e2e/fixtures.ts tests/e2e/word-highlight.spec.ts
 git commit -m "test: add navigation retry and custom timeout for word-highlight full-article test"
```

---

### Task 4: Full Suite Verification

- [ ] **Step 1: Run unit tests**

Run: `pnpm test:unit`
Expected: 583/583 pass

- [ ] **Step 2: Run full e2e suite**

Run: `pnpm test:e2e`
Expected: All tests pass (182+ with new chromium-cleanup test = 183)

- [ ] **Step 3: Run full e2e suite a second time to confirm stability**

Run: `pnpm test:e2e`
Expected: All tests pass again

- [ ] **Step 4: Commit all changes if not already committed**

```bash
 git log --oneline -5
```

Verify 3 commits from Tasks 1-3 are present.
