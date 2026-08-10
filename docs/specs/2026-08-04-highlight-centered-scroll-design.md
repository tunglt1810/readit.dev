# Design: Centered Highlight Scrolling & Smart 3s Manual Scroll Pause

## 1. Overview & Goals

When the application highlights the word/sentence currently being read during TTS playback, the existing experience faces two limitations:
- **Edge Clipping / Suboptimal Scrolling**: Highlighted text is only scrolled when it drifts completely off-screen, and is pushed directly against the top or bottom edge (due to `block: 'nearest'`), forcing the reader's eyes to look at the very bottom or top of the viewport.
- **Scroll Conflict with User**: If the user manually scrolls to view surrounding content during playback, the extension forcibly scrolls the viewport back to the newly highlighted word.

**Goals**:
1. Center the highlighted word/range at **the middle of the viewport** whenever it drifts outside the safe zone (20% - 80% of viewport height).
2. Automatically pause auto-scrolling for 3 seconds whenever manual user scrolling is detected **during playback**.

---

## 2. Technical Details & Algorithms

### 2.1. Centering Math
- **Safe Zone**: `TOP_THRESHOLD = 0.20` and `BOTTOM_THRESHOLD = 0.80`.
  > The 20%/80% threshold matches the existing bounds used in both `word_highlight.ts` and `App.tsx`, preserving scrolling frequency.
- **Scroll Trigger Condition**:
  Let `rect` be `getBoundingClientRect()` of the current highlight element/range. The vertical center of the highlight is:
  $$\text{targetY} = \text{rect.top} + \frac{\text{rect.height}}{2}$$
  Trigger scrolling when $\text{targetY} < 0.20 \times \text{window.innerHeight}$ or $\text{targetY} > 0.80 \times \text{window.innerHeight}$.
- **Scroll Offset ($\Delta Y$)**:
  $$\Delta Y = \text{targetY} - \frac{\text{window.innerHeight}}{2}$$
- **Scroll Behavior**:
  Use `window.scrollBy({ top: deltaY, behavior })` with `behavior` defaulting to `'smooth'`, except when `prefers-reduced-motion: reduce` is enabled on the OS, in which case `behavior: 'auto'` is used.
  `prefers-reduced-motion` is checked on every scroll invocation (un-cached) so mid-session OS setting changes are immediately respected.

### 2.2. Smart 3s Pause Mechanism

#### 2.2.1. Playback State Source

The two integration points determine TTS playback state as follows:

| Context | State Source | Explanation |
|---------|--------------|-------------|
| **Content script** (`word_highlight.ts`) | Calls `setPlaybackState(true)` once per session upon receiving a valid `WORD_HIGHLIGHT_INIT`; calls `setPlaybackState(false)` upon receiving `WORD_HIGHLIGHT_CLEAR` or during `disposeCurrentHighlightSession()`. | The content script does not receive distinct pause/resume messages — it receives `WORD_HIGHLIGHT_UPDATE` (per word) and `WORD_HIGHLIGHT_CLEAR` (end). When paused, background simply stops emitting updates. After 3s without updates, the pause manager naturally expires. |
| **Reader view** (`App.tsx`) | `status === 'playing'` from `documentSession?.status` | Reader view directly accesses playback status via React state. |

#### 2.2.2. Operational Details

- **State Constraint**: The 3s pause mechanism operates only while TTS playback state is active (`playing`). When not playing, event listeners remain attached but `onUserInteraction()` no-ops.
- **Capturing Manual Scroll Events**:
  - Registered events: `wheel`, `touchmove`, and page scroll keys (`PageDown`, `PageUp`, `ArrowDown`, `ArrowUp`, `Space`).
  - Upon user interaction during playback:
    1. Call `pauseManager.onUserInteraction()`.
    2. Manager records `pausedUntil = now + 3000ms`.
    3. Each time `performCenteredScroll` is invoked, it checks `isPaused()` → if `now < pausedUntil`, scrolling is skipped.
  - If the user scrolls again before 3s elapses, `pausedUntil` extends by an additional 3s (debounce behavior).
- **Skipping Auto-Scroll**: While `isPaused() === true`, `performCenteredScroll` returns early (`return false`) without altering the user's viewport position.
- **State Reset**: When `setPlaybackState(false)` is called, `pausedUntil` is cleared immediately.

#### 2.2.3. Event Listener Lifecycle

| Context | Attach | Detach | Rationale |
|---------|--------|--------|-----------|
| **Content script** | Inside `installWordHighlight()` (runs once when content script is injected) | On page unload (content script destroyed with page) | Content script lives for the page lifecycle. Listener remains attached constantly but only activates when `isPlaying === true` inside the manager. |
| **Reader view** | Inside `useEffect` with `[status]` dependency when `status === 'playing'` | Inside cleanup function of the same `useEffect` | Standard React lifecycle — clean attach/detach aligned with playback state. |

> **Why doesn't the content script detach when clearing a session?**
> The content script may receive a new playback session at any time (e.g. user clicks play again). Continual attach/detach adds unnecessary DOM churn. Instead, `onUserInteraction()` checks internal `isPlaying` — if false, cost is near zero.

---

## 3. Component Architecture & Affected Files

### 3.1. [NEW] `src/shared/scroll_helper.ts`
Creates a centralized helper module providing:
- `calculateCenteredScrollOffset(rect, viewportHeight, topThreshold?, bottomThreshold?)`: Pure calculation function. Default thresholds 0.20/0.80.
- `UserScrollPauseManager`: Class managing 3s pause state. Methods: `setPlaybackState(isPlaying)`, `onUserInteraction()`, `isPaused()`.
- `performCenteredScroll(rect, viewportHeight, pauseManager?, scrollFn?, prefersReducedMotion?)`: Orchestrator combining calculation + pause check + scroll execution.

### 3.2. [MODIFY] `src/content/word_highlight.ts`
- Replace legacy `scrollIntoViewIfNeeded` with `performCenteredScroll` from `scroll_helper`.
- Add module-level `scrollPauseManager` instance.
- Call `scrollPauseManager.setPlaybackState(true)` once when receiving a valid `WORD_HIGHLIGHT_INIT` to start the playback session; do not re-record state in the per-word hot path.
- Call `scrollPauseManager.setPlaybackState(false)` in `disposeCurrentHighlightSession()`.
- Register `wheel`, `touchmove`, `keydown` listeners once in `installWordHighlight()`, handler invoking `scrollPauseManager.onUserInteraction()`.

### 3.3. [MODIFY] `src/reader/App.tsx`
- Import `performCenteredScroll` and `UserScrollPauseManager`.
- Create `useRef<UserScrollPauseManager>` to maintain instance stability across renders.
- Inside `useEffect([status])`: call `manager.setPlaybackState(status === 'playing')`, attach/detach scroll listeners.
- Inside `useEffect([currentWordIndex, wordRanges])`: replace legacy scroll block with `performCenteredScroll(...)`.

---

## 4. Verification Plan

### Automated Tests
- Unit tests for `calculateCenteredScrollOffset`: boundary cases, edge cases (`rect.height = 0`, small viewport).
- Unit tests for `UserScrollPauseManager`: no-op when not playing, pause duration, debounce on repeated interaction, reset on stop.
- Unit tests for `performCenteredScroll`: integration of pause + calculation + scroll invocation.
- TypeScript build check: `pnpm build`
- Unit test execution: `pnpm test:unit`

### Manual Verification
1. Open a long web page and start TTS reading.
2. Verify that when highlighted text drifts below 80% of the viewport, the page scrolls smoothly to center the highlight line.
3. During reading, manually scroll up or down using mouse/touchpad: Confirm the extension pauses auto-scrolling for 3 seconds.
4. After 3 seconds of no scroll interaction: Confirm the next highlighted word resumes smooth centered scrolling.
5. When TTS is not reading, manually scroll the page: Confirm scroll flags do not trigger unnecessarily (no console errors, no unexpected scrolls).
6. Enable `prefers-reduced-motion: reduce` in OS settings → confirm scrolling uses `behavior: 'auto'` (no animation).
7. In Reader View: pause TTS → manual scroll → resume → confirm auto-scrolling resumes immediately (without waiting 3s, as pause reset the state).
