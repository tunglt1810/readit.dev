# Highlight Centered Scroll & Smart 3s Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement centered scrolling for highlighted text when out of 20%-80% safe zone, with a smart 3-second pause when user manually scrolls during TTS playback.

**Architecture:** Create a shared helper module `src/shared/scroll_helper.ts` that calculates scroll offsets and manages the 3s user-interaction pause state during active playback. Integrate it into `src/content/word_highlight.ts` and `src/reader/App.tsx`.

**Tech Stack:** TypeScript, React 19, Node.js built-in test runner (`pnpm test:unit`).

## Global Constraints

- Must follow strict TDD cycle (Red -> Verify Red -> Green -> Verify Green -> Commit).
- Specifications spec file: `docs/specs/2026-08-04-highlight-centered-scroll-design.md`.
- No placeholders or TBD items. Complete code snippets provided in plan.
- Safe zone thresholds: **0.20 (top) / 0.80 (bottom)** — matching existing code behavior.

---

### Task 1: Create `src/shared/scroll_helper.ts` (Centering Math & Safe Zone Logic)

**Files:**
- Create: `src/shared/scroll_helper.ts`
- Create: `tests/unit/scroll_helper.test.ts`

**Interfaces:**
- Produces: `calculateCenteredScrollOffset(rect: { top: number; height: number }, viewportHeight: number): { shouldScroll: boolean; deltaY: number }`

- [ ] **Step 1: Write the failing unit test for centered scroll calculation**

Create `tests/unit/scroll_helper.test.ts`:
```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCenteredScrollOffset } from '../../src/shared/scroll_helper.ts';

test('does not scroll when highlight is within 20%-80% viewport safe zone', () => {
	const viewportHeight = 1000;
	// Highlight at top=400, height=20 -> center is 410 (between 200 and 800)
	const result = calculateCenteredScrollOffset({ top: 400, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, false);
	assert.equal(result.deltaY, 0);
});

test('does not scroll when highlight center is exactly at 20% boundary', () => {
	const viewportHeight = 1000;
	// Highlight at top=190, height=20 -> center is 200 (exactly at 20%)
	const result = calculateCenteredScrollOffset({ top: 190, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, false);
	assert.equal(result.deltaY, 0);
});

test('does not scroll when highlight center is exactly at 80% boundary', () => {
	const viewportHeight = 1000;
	// Highlight at top=790, height=20 -> center is 800 (exactly at 80%)
	const result = calculateCenteredScrollOffset({ top: 790, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, false);
	assert.equal(result.deltaY, 0);
});

test('calculates correct deltaY to center highlight when above 20% safe zone', () => {
	const viewportHeight = 1000;
	// Highlight at top=100, height=20 -> center is 110 (< 200)
	// Target center is 500. Expected deltaY = 110 - 500 = -390
	const result = calculateCenteredScrollOffset({ top: 100, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, true);
	assert.equal(result.deltaY, -390);
});

test('calculates correct deltaY to center highlight when below 80% safe zone', () => {
	const viewportHeight = 1000;
	// Highlight at top=850, height=20 -> center is 860 (> 800)
	// Target center is 500. Expected deltaY = 860 - 500 = 360
	const result = calculateCenteredScrollOffset({ top: 850, height: 20 }, viewportHeight);
	assert.equal(result.shouldScroll, true);
	assert.equal(result.deltaY, 360);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL with "Cannot find module '../../src/shared/scroll_helper.ts'"

- [ ] **Step 3: Write minimal implementation in `src/shared/scroll_helper.ts`**

Create `src/shared/scroll_helper.ts`:
```typescript
export interface RectBounds {
	top: number;
	height: number;
}

export interface ScrollCalculationResult {
	shouldScroll: boolean;
	deltaY: number;
}

const DEFAULT_TOP_THRESHOLD = 0.20;
const DEFAULT_BOTTOM_THRESHOLD = 0.80;

export function calculateCenteredScrollOffset(
	rect: RectBounds,
	viewportHeight: number,
	topThresholdFraction = DEFAULT_TOP_THRESHOLD,
	bottomThresholdFraction = DEFAULT_BOTTOM_THRESHOLD,
): ScrollCalculationResult {
	const center = rect.top + rect.height / 2;
	const topBound = viewportHeight * topThresholdFraction;
	const bottomBound = viewportHeight * bottomThresholdFraction;

	if (center >= topBound && center <= bottomBound) {
		return { shouldScroll: false, deltaY: 0 };
	}

	const targetCenter = viewportHeight / 2;
	const deltaY = center - targetCenter;
	return { shouldScroll: true, deltaY };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/scroll_helper.ts tests/unit/scroll_helper.test.ts
git commit -m "feat: add calculateCenteredScrollOffset helper with unit tests"
```

---

### Task 2: Implement Smart 3s User Scroll Pause Manager in `src/shared/scroll_helper.ts`

**Files:**
- Modify: `src/shared/scroll_helper.ts`
- Modify: `tests/unit/scroll_helper.test.ts`

**Interfaces:**
- Produces: `UserScrollPauseManager` class with `onUserInteraction()`, `isPaused()`, `setPlaybackState(isPlaying: boolean)`
- Produces: `performCenteredScroll(rect, viewportHeight, pauseManager?, scrollFn?, prefersReducedMotion?): boolean`

- [ ] **Step 1: Write failing tests for UserScrollPauseManager**

Append to `tests/unit/scroll_helper.test.ts`:
```typescript
import { UserScrollPauseManager, performCenteredScroll } from '../../src/shared/scroll_helper.ts';

test('UserScrollPauseManager ignores scroll interaction when playback is NOT active', () => {
	const manager = new UserScrollPauseManager(3000);
	manager.setPlaybackState(false);
	manager.onUserInteraction();
	assert.equal(manager.isPaused(), false);
});

test('UserScrollPauseManager pauses auto-scroll for 3s when playback IS active', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);

	assert.equal(manager.isPaused(), false);
	manager.onUserInteraction();
	assert.equal(manager.isPaused(), true);

	// Advance time by 2 seconds -> still paused
	currentTime += 2000;
	assert.equal(manager.isPaused(), true);

	// Advance time by another 1.1 seconds (total 3.1s) -> no longer paused
	currentTime += 1100;
	assert.equal(manager.isPaused(), false);
});

test('UserScrollPauseManager debounces: repeated interaction extends pause window', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);

	manager.onUserInteraction();
	assert.equal(manager.isPaused(), true);

	// After 2s, user scrolls again -> pausedUntil extends to currentTime + 3s
	currentTime += 2000;
	manager.onUserInteraction();

	// After another 2s (4s total from first, 2s from second) -> still paused
	currentTime += 2000;
	assert.equal(manager.isPaused(), true);

	// After another 1.1s (3.1s from second interaction) -> no longer paused
	currentTime += 1100;
	assert.equal(manager.isPaused(), false);
});

test('UserScrollPauseManager resets pause state when playback stops', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);
	manager.onUserInteraction();
	assert.equal(manager.isPaused(), true);

	// Stop playback -> pause reset immediately
	manager.setPlaybackState(false);
	assert.equal(manager.isPaused(), false);
});

test('performCenteredScroll returns false when paused', () => {
	let currentTime = 10000;
	const manager = new UserScrollPauseManager(3000, () => currentTime);
	manager.setPlaybackState(true);
	manager.onUserInteraction();

	let scrollCalled = false;
	const mockScrollFn = () => { scrollCalled = true; };

	const result = performCenteredScroll({ top: 50, height: 20 }, 1000, manager, mockScrollFn, false);
	assert.equal(result, false);
	assert.equal(scrollCalled, false);
});

test('performCenteredScroll scrolls with smooth behavior when not paused and out of safe zone', () => {
	let scrolledOffset = 0;
	let scrollBehavior = '';
	const mockScrollFn = (opts: { top: number; behavior: ScrollBehavior }) => {
		scrolledOffset = opts.top;
		scrollBehavior = opts.behavior;
	};

	const manager = new UserScrollPauseManager(3000);
	manager.setPlaybackState(true);

	// center = 50 + 10 = 60 (< 200 in 1000px viewport)
	// deltaY = 60 - 500 = -440
	const result = performCenteredScroll({ top: 50, height: 20 }, 1000, manager, mockScrollFn, false);
	assert.equal(result, true);
	assert.equal(scrolledOffset, -440);
	assert.equal(scrollBehavior, 'smooth');
});

test('performCenteredScroll uses auto behavior when prefersReducedMotion is true', () => {
	let scrollBehavior = '';
	const mockScrollFn = (opts: { top: number; behavior: ScrollBehavior }) => {
		scrollBehavior = opts.behavior;
	};

	const result = performCenteredScroll({ top: 50, height: 20 }, 1000, undefined, mockScrollFn, true);
	assert.equal(result, true);
	assert.equal(scrollBehavior, 'auto');
});

test('performCenteredScroll returns false when within safe zone', () => {
	let scrollCalled = false;
	const mockScrollFn = () => { scrollCalled = true; };

	const result = performCenteredScroll({ top: 400, height: 20 }, 1000, undefined, mockScrollFn, false);
	assert.equal(result, false);
	assert.equal(scrollCalled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL with "UserScrollPauseManager is not exported" or similar

- [ ] **Step 3: Implement `UserScrollPauseManager` and `performCenteredScroll` in `src/shared/scroll_helper.ts`**

Append to `src/shared/scroll_helper.ts`:
```typescript
export class UserScrollPauseManager {
	private pauseDurationMs: number;
	private getTime: () => number;
	private isPlaying = false;
	private pausedUntil = 0;

	constructor(pauseDurationMs = 3000, getTimeFn: () => number = () => Date.now()) {
		this.pauseDurationMs = pauseDurationMs;
		this.getTime = getTimeFn;
	}

	public setPlaybackState(isPlaying: boolean): void {
		this.isPlaying = isPlaying;
		if (!isPlaying) {
			this.pausedUntil = 0;
		}
	}

	public onUserInteraction(): void {
		if (!this.isPlaying) return;
		this.pausedUntil = this.getTime() + this.pauseDurationMs;
	}

	public isPaused(): boolean {
		if (!this.isPlaying) return false;
		return this.getTime() < this.pausedUntil;
	}
}

export function performCenteredScroll(
	rect: RectBounds,
	viewportHeight: number,
	pauseManager?: UserScrollPauseManager,
	scrollFn: (options: { top: number; behavior: ScrollBehavior }) => void = (opts) => window.scrollBy(opts),
	prefersReducedMotion = false,
): boolean {
	if (pauseManager?.isPaused()) {
		return false;
	}

	const calc = calculateCenteredScrollOffset(rect, viewportHeight);
	if (!calc.shouldScroll) {
		return false;
	}

	const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';
	scrollFn({ top: calc.deltaY, behavior });
	return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/scroll_helper.ts tests/unit/scroll_helper.test.ts
git commit -m "feat: implement UserScrollPauseManager and performCenteredScroll"
```

---

### Task 3: Integrate `scroll_helper` into Content Script (`src/content/word_highlight.ts`)

**Files:**
- Modify: `src/content/word_highlight.ts`

**Interfaces:**
- Consumes: `UserScrollPauseManager`, `performCenteredScroll` from `src/shared/scroll_helper.ts`

**Key design decisions (from spec §2.2.1 & §2.2.3):**
- Playback state is inferred from the highlight lifecycle: call `setPlaybackState(true)` once when a valid `WORD_HIGHLIGHT_INIT` message starts a session, and `setPlaybackState(false)` when the session is disposed.
- Event listeners are attached once in `installWordHighlight()` and never detached (content script lives for the page's lifetime). The manager's internal `isPlaying` check makes them effectively no-op when not playing.

- [ ] **Step 1: Add module-level scrollPauseManager and user-scroll event listener registration**

In `src/content/word_highlight.ts`, add import at top:
```typescript
import { performCenteredScroll, UserScrollPauseManager } from '../shared/scroll_helper.ts';
```

Add module-level instance after existing `let` declarations (after `let styleInjected = false;`):
```typescript
const scrollPauseManager = new UserScrollPauseManager(3000);
```

- [ ] **Step 2: Replace `scrollIntoViewIfNeeded` with centered scroll logic**

Replace the existing `scrollIntoViewIfNeeded` function (lines ~235-247):
```typescript
function scrollIntoViewIfNeeded(range: Range): void {
	const rect = range.getBoundingClientRect();
	const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	performCenteredScroll(rect, window.innerHeight, scrollPauseManager, (opts) => window.scrollBy(opts), prefersReducedMotion);
}
```

- [ ] **Step 3: Set playback state on session lifecycle**

When a valid `WORD_HIGHLIGHT_INIT` message is handled, call:
```typescript
scrollPauseManager.setPlaybackState(true);
```

In `disposeCurrentHighlightSession()`, add at the beginning of the function body:
```typescript
scrollPauseManager.setPlaybackState(false);
```

This keeps the state transition out of the per-word `scrollIntoViewIfNeeded` hot path.

- [ ] **Step 4: Register user-scroll event listeners in `installWordHighlight()`**

Inside `installWordHighlight()`, after the early-return guards (after the `CSS.highlights` check), add:
```typescript
const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ']);
const handleUserScroll = () => scrollPauseManager.onUserInteraction();
const handleKeyScroll = (e: KeyboardEvent) => {
	if (SCROLL_KEYS.has(e.key)) {
		scrollPauseManager.onUserInteraction();
	}
};
window.addEventListener('wheel', handleUserScroll, { passive: true });
window.addEventListener('touchmove', handleUserScroll, { passive: true });
window.addEventListener('keydown', handleKeyScroll, { passive: true });
```

- [ ] **Step 5: Run build and unit tests**

Run: `pnpm build && pnpm test:unit`
Expected: PASS with 0 build errors.

- [ ] **Step 6: Commit**

```bash
git add src/content/word_highlight.ts
git commit -m "feat: integrate centered scroll and smart 3s pause into word_highlight content script"
```

---

### Task 4: Integrate `scroll_helper` into Reader View (`src/reader/App.tsx`)

**Files:**
- Modify: `src/reader/App.tsx`

**Interfaces:**
- Consumes: `performCenteredScroll`, `UserScrollPauseManager` from `src/shared/scroll_helper.ts`

**Key design decisions (from spec §2.2.1 & §2.2.3):**
- Reader has direct access to `status` (`'playing' | 'paused' | 'stopped'`). Use `status === 'playing'` for `setPlaybackState`.
- `UserScrollPauseManager` lives in a `useRef` to remain stable across re-renders.
- Event listeners are attached/detached via a `useEffect` keyed on `status`.

- [ ] **Step 1: Add imports and create manager ref**

Add import at top of `src/reader/App.tsx`:
```typescript
import { performCenteredScroll, UserScrollPauseManager } from '../shared/scroll_helper.ts';
```

Inside the component function, add ref (near other refs):
```typescript
const scrollPauseManagerRef = useRef(new UserScrollPauseManager(3000));
```

- [ ] **Step 2: Add useEffect for playback state sync and event listener lifecycle**

Add a new `useEffect` that manages the scroll pause manager state and listeners:
```typescript
useEffect(() => {
	const manager = scrollPauseManagerRef.current;
	const isPlaying = status === 'playing';
	manager.setPlaybackState(isPlaying);

	if (!isPlaying) return;

	const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ']);
	const handleUserScroll = () => manager.onUserInteraction();
	const handleKeyScroll = (e: KeyboardEvent) => {
		if (SCROLL_KEYS.has(e.key)) {
			manager.onUserInteraction();
		}
	};
	window.addEventListener('wheel', handleUserScroll, { passive: true });
	window.addEventListener('touchmove', handleUserScroll, { passive: true });
	window.addEventListener('keydown', handleKeyScroll, { passive: true });

	return () => {
		window.removeEventListener('wheel', handleUserScroll);
		window.removeEventListener('touchmove', handleUserScroll);
		window.removeEventListener('keydown', handleKeyScroll);
	};
}, [status]);
```

- [ ] **Step 3: Replace existing scroll block in highlight useEffect**

In the existing `useEffect([currentWordIndex, wordRanges])`, replace the scroll block:

**Before (lines ~127-131):**
```typescript
const bounds = range.getBoundingClientRect();
if (bounds.top < window.innerHeight * 0.2 || bounds.bottom > window.innerHeight * 0.8) {
	const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
	window.scrollBy({ top: bounds.top - window.innerHeight / 2, behavior });
}
```

**After:**
```typescript
const bounds = range.getBoundingClientRect();
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
performCenteredScroll(bounds, window.innerHeight, scrollPauseManagerRef.current, (opts) => window.scrollBy(opts), prefersReducedMotion);
```

- [ ] **Step 4: Run full build and unit tests**

Run: `pnpm build && pnpm test:unit`
Expected: PASS with 0 build errors.

- [ ] **Step 5: Commit**

```bash
git add src/reader/App.tsx
git commit -m "feat: integrate centered scroll helper into Reader View"
```

---

### Task 5: Verification & Final Polish

- [ ] **Step 1: Run linter**

Run: `pnpm lint`
Expected: Pristine output with no errors. Fix any issues before proceeding.

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: Build succeeds with 0 TypeScript errors.

- [ ] **Step 3: Run unit tests**

Run: `pnpm test:unit`
Expected: All tests pass.

- [ ] **Step 4: Final Commit (only if linter/build required fixes)**

```bash
git add -u
git commit -m "chore: lint/build fixes for centered scroll implementation"
```
