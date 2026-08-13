# CI E2E Runtime

**Status:** first pass landed — the suite went from 18.1 min to 5.4 min locally. See *Outcome* at the
end for what changed and what is still open. The sections before it are the original scoping note,
kept because they record how the leads were found.

## Problem

The Playwright suite is the long pole in CI. Measured locally on 2026-08-13, on the
`feat/epub-reading` branch:

| Run | Result |
| --- | --- |
| Full suite | 206 passed, 18.1 min |
| Full suite (earlier the same day) | 203 passed / 1 failed / 2 did not run, 16.0 min |

CI is slower still: `.github/workflows/release-extension.yml` runs the suite as a single
`xvfb-run --auto-servernum pnpm test:e2e` step on `ubuntu-latest`, with `retries: 2`, so one flaky
test can add two more full-length attempts of that test plus its setup.

## The main lead: `workers: 1` is an accidental revert

`playwright.config.ts` pins `fullyParallel: false` **and** `workers: 1`. The whole suite therefore
runs strictly sequentially, one Chrome context at a time.

The single-worker pin has no design behind it:

- `docs/specs/2026-07-16-playwright-headless-parallel-design.md` explicitly removed it. Its
  reasoning: the context fixture is test-scoped and each test already gets its own
  `fs.mkdtempSync(...'playwright-chrome-profile-')` profile (`tests/e2e/fixtures.ts:219`), so
  nothing forces a single worker. `fullyParallel: false` was kept on purpose, so tests within one
  file stay ordered while independent files run in parallel.
- `ef2927e fix: run extension e2e headlessly in parallel` implemented that removal.
- `c7dae60 refactor: modularize readable surfaces` (2026-07-28) added `workers: 1` back as a lone
  line in a commit about readable surfaces. Nothing in that commit's subject or in any design doc
  asks for it.
- `docs/specs/2026-08-10-flaky-test-stabilization-design.md` is the obvious suspect for having
  wanted serialization, but it does not: its three root causes were a missing startup timeout in
  `loadAndPlay` (a production bug), orphan Chrome processes, and test timeouts that were too tight.
  It addressed resource pressure with `killOrphanChromeProcesses()` and the `chromium-cleanup`
  project, not with worker count.

So the first thing to measure is simply restoring default workers. Because the resource-pressure
root cause was fixed independently, the conditions that made a serial run feel safer may no longer
hold.

**Caveat worth respecting:** the flaky failures that motivated the stabilization work were
resource-pressure failures, and more workers means more concurrent Chrome contexts. Restoring
parallelism has to be validated by repeated full runs, not one green run.

## Other leads, roughly in order of expected value

1. **Measure before optimizing.** Run with `--reporter=json` (or `--reporter=line,json`) and rank
   tests and files by duration. 206 tests over 18 minutes averages ~5s each, so the distribution
   matters more than the mean. Store output under `.tmp/`.
2. **Project chaining forces a tail.** The three projects are strictly serial via `dependencies`:
   `chromium` → `chromium-cleanup` → `chromium-audio`. The audio project runs headed and can never
   overlap anything. Check what that tail actually costs; it may be small enough to ignore.
3. **Sharding.** If in-machine parallelism stays capped by the extension/service-worker model, a CI
   matrix over `--shard=i/n` moves wall-clock down without touching test isolation.
4. **Split stubbed tests from real-TTS tests.** Tests that wait on the real model dominate the
   timeout budget. Running the stubbed majority first gives a much faster fail-fast signal.
5. **Avoid rebuilding the extension per job.** If sharding or splitting lands, cache `dist/chrome`
   between jobs rather than rebuilding it in each.
6. **Reporter and artifacts.** `reporter: 'html'` always writes a report; `trace`/`video` are
   already limited to `on-first-retry`, which is right. Check whether the HTML report costs
   meaningful time in CI versus `line` plus an uploaded artifact.

## Known flaky test

`tests/e2e/word-highlight.spec.ts:569` — *clears instead of matching a word after the selected
range*. Failed once during a full run on 2026-08-13, passed on its own immediately afterwards, and
passed in the subsequent full run. With `retries: 2` on CI, each such flake costs two extra
attempts. Worth root-causing as part of this work rather than separately, since it is the same
resource-pressure family the 2026-08-10 work addressed.

## Verification

Whatever lands must show:

- Wall-clock before and after, from the same machine, recorded in this document.
- Three consecutive green full runs, matching the bar the 2026-08-10 stabilization work set.
- No change to per-test isolation: each test keeps its own profile directory.

## Outcome

### What restoring workers actually exposed

Removing `workers: 1` on its own did not work: the first parallel run finished in 10.5 min with only
9 tests passing. Every failure landed on the same line — `resolveExtensionId` timing out on the
`#readit-dev-ext-info` marker.

The cause was a real defect in the helper rather than anything about parallelism. It checked
`context.serviceWorkers()` exactly once, immediately after the wake page finished loading, and fell
through to a 10-second marker wait when that single check came up empty. With one browser starting
at a time the worker happened to be registered by then; with several starting together it usually
was not. `tests/e2e/extension_id.ts` now waits for the `serviceworker` event instead of sampling
once, and the three startup waits share one named budget:

```ts
const EXTENSION_STARTUP_TIMEOUT_MS = 45_000;
```

A three-worker run over three spec files went from all-failing to 21/21 in 37.5 s with that change.

The second exposure was `expect.timeout: 5000`. A round trip through the background service worker —
`sendBackgroundMessage` → session lane → `broadcastSession` → `chrome.action.setBadgeText` — does not
reliably fit in five seconds when several extension browsers are competing, and
`reading-state.spec.ts:818` failed twice consecutively on the badge poll. Raised to `15_000`. It
cannot mask a defect that the assertion would otherwise catch; it only grants more time.

### Worker count

Full-suite runs, 206 tests, on a 12-core machine, `retries: 0` (locally Playwright does not retry, so
this is a harsher bar than CI, which retries twice):

| Workers | Wall-clock | Result |
| --- | --- | --- |
| 1 (previous) | 18.1 min | baseline |
| 3 | 6.6 min | clean ×2 |
| 4 | 5.4 min | clean ×3 |
| 6 (Playwright default here) | 4.5 min | failed in 3 of 6 runs |

The six-worker failures were not slowness. Values stayed unchanged across every poll of a 15-second
window — a slider stuck at `1.10x` for 34 consecutive polls, a rule element never appearing — which
reads as synthesized input landing before the page was ready, not as an assertion that needed longer.
Four workers is therefore the ceiling this suite tolerates on a 12-core machine, at 3.4× faster.

Config: `workers: process.env.CI ? 2 : 4`.

**The CI half of that is reasoned, not measured.** GitHub's `ubuntu-latest` runners have four cores,
so Playwright would default to two there anyway, and `retries: 2` absorbs the occasional flake. The
ratio that stayed clean locally was three cores per worker, which a four-core runner cannot offer at
two workers — so if CI starts retrying more often, drop it to one worker and take the win from
sharding instead.

### Still open

**Sharding is the remaining CI lever, and it needs a decision.** The e2e run is one step in the middle
of the single `build-and-release` job in `.github/workflows/release-extension.yml`, between the build
and the packaging steps. Sharding means splitting that job into build → e2e matrix → package, passing
`dist/chrome` between them as an artifact. That is a restructure of a tag-triggered release pipeline
that cannot be rehearsed locally, so it should not be done as a drive-by.

Not pursued, with reasons:

- **The 380 MB per-test profile copy** (`copyDirectoryTreeSync`, ~500 ms warm locally) is real but
  minor: ~1.7 min of the serial 18, and it overlaps once workers are parallel. Hard-linking instead
  of copying would be near-free but unsafe — Chrome writes to its Cache Storage, so linked tests
  would corrupt the shared seed. APFS `clonefile` would help only on macOS, not on CI.
- **The project chain** (`chromium` → `chromium-cleanup` → `chromium-audio`) stays serial by design:
  `chromium_cleanup.ts` runs `pkill` against every test-type Chromium, which is only safe as a
  barrier between projects. Its cost is one cleanup test plus one headed audio test.
