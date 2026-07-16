# Playwright Headless Parallel E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make routine extension E2E runs headless and restore Playwright's default file-level parallelism while preserving an explicit headed debug path and per-test isolation.

**Architecture:** The custom `context` fixture remains test-scoped and continues to own `chromium.launchPersistentContext(...)`, but it consumes Playwright's built-in `headless: boolean` worker option and launches the documented `chromium` channel. `playwright.config.ts` stops forcing one worker, so independent test files use Playwright's default worker pool while tests inside each file remain ordered.

**Tech Stack:** TypeScript 6, Playwright Test 1.61.0, bundled Chromium, Chrome Manifest V3, pnpm workspace.

## Global Constraints

- Default `pnpm test:e2e` must create no visible Chromium window.
- `pnpm exec playwright test --headed` must remain available for explicit visual debugging.
- Remove the global `workers: 1` limit; keep `fullyParallel: false`.
- Keep the persistent context test-scoped and retain one unique `.tmp/playwright-chrome-profile-*` directory per test.
- Use `channel: 'chromium'` for headless extension support.
- Remove `--start-minimized`; do not replace it with another window-management flag.
- Do not change application code, test assertions, dependencies, or storage/session reset behavior.
- Do not modify or commit the unrelated popup/theme work or `context_improvement.md`.
- Store timing output under `.tmp/playwright-headless-parallel/`.

---

### Task 1: Make the custom extension fixture headless-aware and restore parallel workers

**Files:**
- Modify: `playwright.config.ts:22-24`
- Modify: `tests/e2e/fixtures.ts:58-76`

**Interfaces:**
- Consumes: Playwright's built-in worker option `headless: boolean`, which defaults to `true` and is set to `false` by the CLI `--headed` flag.
- Produces: a test-scoped `BrowserContext` launched with `{ channel: 'chromium', headless, locale, args }`; Playwright controls the worker count.

- [ ] **Step 1: Run the pre-change contract assertion and verify RED**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const config=fs.readFileSync("playwright.config.ts","utf8"); const fixture=fs.readFileSync("tests/e2e/fixtures.ts","utf8"); if(config.includes("workers: 1")) throw new Error("RED: Playwright is restricted to one worker"); if(fixture.includes("headless: false")) throw new Error("RED: extension context is forced headed"); if(fixture.includes("--start-minimized")) throw new Error("RED: minimize workaround remains"); if(!fixture.includes("context: async ({ browserLocale, headless }, use)")) throw new Error("RED: fixture does not consume Playwright headless option"); if(!fixture.includes("channel: 'chromium'")) throw new Error("RED: Chromium channel is missing");'
```

Expected: exit 1 with `RED: Playwright is restricted to one worker`.

- [ ] **Step 2: Restore Playwright's default worker pool**

Remove these lines from `playwright.config.ts`:

```ts
	/* Run tests sequentially to avoid Chrome profile locks when using local Chrome */
	workers: 1,
```

Keep this setting unchanged:

```ts
	fullyParallel: false,
```

This allows separate files to run in parallel without making tests inside one file fully parallel.

- [ ] **Step 3: Make the persistent context follow Playwright's headless option**

Replace the context fixture signature and launch options in `tests/e2e/fixtures.ts` with:

```ts
	context: async ({ browserLocale, headless }, use) => {
		const pathToExtension = path.join(process.cwd(), 'dist');
		const tempDir = path.join(process.cwd(), '.tmp');
		fs.mkdirSync(tempDir, { recursive: true });
		const userDataDir = fs.mkdtempSync(path.join(tempDir, 'playwright-chrome-profile-'));

		// Khởi chạy Chromium với extension được unpack từ thư mục dist/
		const context = await chromium.launchPersistentContext(userDataDir, {
			channel: 'chromium',
			headless,
			locale: browserLocale,
			args: [
				`--disable-extensions-except=${pathToExtension}`,
				`--load-extension=${pathToExtension}`,
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-sync',
			],
		});
```

Leave the existing `try/finally`, `context.close()`, and profile cleanup unchanged.

- [ ] **Step 4: Re-run the contract assertion and verify GREEN**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const config=fs.readFileSync("playwright.config.ts","utf8"); const fixture=fs.readFileSync("tests/e2e/fixtures.ts","utf8"); if(config.includes("workers: 1")) throw new Error("Playwright remains restricted to one worker"); if(fixture.includes("headless: false")) throw new Error("extension context remains forced headed"); if(fixture.includes("--start-minimized")) throw new Error("minimize workaround remains"); if(!fixture.includes("context: async ({ browserLocale, headless }, use)")) throw new Error("fixture does not consume Playwright headless option"); if(!fixture.includes("channel: 'chromium'")) throw new Error("Chromium channel is missing"); console.log("Playwright launch contract passed");'
```

Expected: prints `Playwright launch contract passed`.

- [ ] **Step 5: Run TypeScript/build and focused formatting checks**

Run:

```bash
CI=true pnpm build
CI=true pnpm exec biome check playwright.config.ts tests/e2e/fixtures.ts
```

Expected: the build exits 0 and Biome reports no fixes or errors.

- [ ] **Step 6: Commit only the Playwright configuration fix**

Run:

```bash
git add playwright.config.ts tests/e2e/fixtures.ts
git commit -m "fix: run extension e2e headlessly in parallel"
```

Expected: one commit containing exactly the two Playwright files; existing popup/theme changes and `context_improvement.md` remain outside the commit.

---

### Task 2: Verify headless extension loading, headed opt-in, and parallel speed

**Files:**
- Create at runtime: `.tmp/playwright-headless-parallel/workers-1-time.txt`
- Create at runtime: `.tmp/playwright-headless-parallel/default-workers-time.txt`
- Verify: `dist/`
- Verify: `tests/e2e/`

**Interfaces:**
- Consumes: the headless-aware fixture and restored default worker pool from Task 1.
- Produces: runtime evidence that the MV3 extension works headlessly, headed mode remains available, and default workers are not slower than the same suite forced to one worker.

- [ ] **Step 1: Prepare the repository-local measurement directory**

Run:

```bash
mkdir -p .tmp/playwright-headless-parallel
```

Expected: the directory exists under the ignored `.tmp` tree.

- [ ] **Step 2: Run one default-mode MV3 smoke test**

Run outside a restrictive macOS browser sandbox:

```bash
CI=true pnpm exec playwright test tests/e2e/free-tier.spec.ts --reporter=line
```

Expected: `1 passed`; the extension service worker and popup load without any visible Chromium window or focus change.

- [ ] **Step 3: Measure the full headless suite with one worker**

Run:

```bash
/usr/bin/time -p -o .tmp/playwright-headless-parallel/workers-1-time.txt env CI=true pnpm exec playwright test --workers=1 --reporter=line
```

Expected: all tests pass headlessly; timing is written without opening Chromium windows.

- [ ] **Step 4: Measure the full headless suite with Playwright's default workers**

Run:

```bash
/usr/bin/time -p -o .tmp/playwright-headless-parallel/default-workers-time.txt env CI=true pnpm exec playwright test --reporter=line
```

Expected: all tests pass. On a machine with more than one available worker, output reports multiple workers and the measured real time is no greater than the one-worker run.

- [ ] **Step 5: Print the factual timing comparison**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; console.log({workers1:fs.readFileSync(".tmp/playwright-headless-parallel/workers-1-time.txt","utf8").trim(),defaultWorkers:fs.readFileSync(".tmp/playwright-headless-parallel/default-workers-time.txt","utf8").trim()});'
```

Expected: prints both `real`, `user`, and `sys` measurements. Report a speed improvement only when the values support it.

- [ ] **Step 6: Run one explicit headed smoke test**

Run outside the browser sandbox:

```bash
CI=true pnpm exec playwright test tests/e2e/free-tier.spec.ts --headed --workers=1 --reporter=line
```

Expected: `1 passed` and a visible Chromium window opens only for this explicit command. Do not run the full suite headed.

- [ ] **Step 7: Run final contract and repository checks**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; const config=fs.readFileSync("playwright.config.ts","utf8"); const fixture=fs.readFileSync("tests/e2e/fixtures.ts","utf8"); if(config.includes("workers: 1")||fixture.includes("headless: false")||fixture.includes("--start-minimized")) throw new Error("legacy launch behavior remains"); if(!fixture.includes("context: async ({ browserLocale, headless }, use)")||!fixture.includes("channel: 'chromium'")) throw new Error("headless launch contract missing"); console.log("Final Playwright launch contract passed");'
git diff --check
git status --short
```

Expected: the contract and whitespace checks pass; only pre-existing popup/theme changes and `context_improvement.md` remain outside the committed Playwright work.

- [ ] **Step 8: Report the diagnosis and evidence**

Report:

```text
- root cause: test-scoped fixture forced headed Chromium; minimize could not prevent macOS focus;
- default behavior: headless Chromium with no visible window;
- debug behavior: explicit --headed smoke test remains available;
- isolation: unique test-scoped persistent profiles retained;
- worker behavior: Playwright default file-level parallelism restored;
- one-worker and default-worker timings;
- smoke and full-suite pass counts;
- unrelated dirty files left untouched.
```

Expected: every completion claim is backed by output from the preceding steps.
