# Reading State and Tab Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Keep one local reading session observable after popup reopen and stop it reliably when its owning tab closes, reloads, or navigates.

**Architecture:** The background service worker is the session coordinator and stores a UI-safe snapshot in `chrome.storage.session`. The offscreen document remains responsible for article text, Supertonic inference, and audio, while the popup queries the coordinator instead of treating its React state as authoritative. A session ID is carried through every playback progress message so late asynchronous work cannot overwrite a newer session.

**Tech Stack:** Strict TypeScript, Chrome MV3 service worker/offscreen document, React popup, Node test runner, Playwright E2E.

## Global Constraints

- Keep article text and generated audio in memory only; never write either to extension storage.
- Use `chrome.storage.session`, not `chrome.storage.local`, for the active-session snapshot.
- Support one reading session at a time; starting a new page replaces the old session.
- Closing the popup must not stop playback.
- Closing, reloading, or navigating the owning tab must stop and clear playback.
- Do not add permissions, dependencies, backend/API calls, telemetry, or browser-restart recovery.
- Preserve the existing voice and speed preference keys in `chrome.storage.local`.
- Follow the repository's strict TypeScript, tab-indentation, and existing naming conventions.

## File Map

- Modify `src/shared/types.ts`: add the session snapshot and typed playback messages.
- Modify `src/shared/constants.ts`: add the session storage key.
- Create `src/background/playback_state.ts`: pure session creation, progress merge, ownership, and clearing helpers.
- Create `tests/unit/playback_state.test.ts`: deterministic tests for those helpers.
- Modify `src/background/background.ts`: hydrate/persist state, route commands, and observe tab lifecycle.
- Modify `src/offscreen/offscreen.ts`: attach extension session IDs to progress and guard session replacement.
- Modify `src/popup/App.tsx`: hydrate from the background, render active-page metadata, and route controls.
- Modify `src/popup/popup.css`: add compact active-session title/context styles without changing the existing layout system.
- Create `tests/e2e/reading-state.spec.ts`: verify popup hydration and active-session UI using the existing Playwright fixture pattern.
- Modify `tests/e2e/tts-controls.spec.ts`: teach the existing runtime mock to answer `GET_PLAYBACK_STATE` and use the new command names.

---

### Task 1: Freeze Shared Session Contracts and Pure State Helpers

**Files:**
- Modify: `src/shared/types.ts:15-25`
- Modify: `src/shared/constants.ts:27-31`
- Create: `src/background/playback_state.ts`
- Create: `tests/unit/playback_state.test.ts`

**Interfaces:**

Add these shared types:

```ts
export interface PlaybackSessionSnapshot {
	sessionId: string;
	tabId: number;
	title: string;
	url: string;
	lang: string;
	status: PlaybackStatus;
	currentParagraphIndex: number;
	totalParagraphs: number;
	progressPercentage: number;
	voiceStyleId: string;
	speed: number;
	error?: string;
	updatedAt: number;
}

export interface PlaybackProgressUpdateMessage {
	action: 'PLAYBACK_PROGRESS_UPDATE';
	sessionId: string;
	progress: PlaybackProgress;
}

export interface PlaybackStateResponse {
	session: PlaybackSessionSnapshot | null;
	currentTabId?: number;
}
```

Add `STORAGE_KEYS.PLAYBACK_SESSION = 'readit_playback_session'`.

Export pure helpers with these signatures:

```ts
export function createPlaybackSession(input: {
	sessionId: string;
	tabId: number;
	title: string;
	url: string;
	lang: string;
	voiceStyleId: string;
	speed: number;
	now: number;
}): PlaybackSessionSnapshot;

export function applyPlaybackProgress(
	session: PlaybackSessionSnapshot,
	sessionId: string,
	progress: PlaybackProgress,
	now: number,
): PlaybackSessionSnapshot | null;

export function ownsTab(session: PlaybackSessionSnapshot | null, tabId: number): boolean;
```

- [ ] **Step 1: Write failing unit tests** for default `loading` state, progress merge, session-ID rejection, owner-tab matching, and immutable input snapshots.
- [ ] **Step 2: Run `node --experimental-strip-types --test tests/unit/playback_state.test.ts`** and confirm the new tests fail because the helpers do not exist.
- [ ] **Step 3: Implement the types, storage key, and pure helpers** with no Chrome API calls. A mismatched session ID must return `null`; a valid progress update must preserve title, URL, tab ID, voice, and speed while replacing status/progress/error and `updatedAt`.
- [ ] **Step 4: Run `pnpm test:unit`** and confirm all unit tests pass.
- [ ] **Step 5: Commit the shared contract and helper tests** with `feat: define playback session state contracts`.

### Task 2: Make the Background Worker the Session Coordinator

**Files:**
- Modify: `src/background/background.ts:1-159`
- Test: `tests/unit/playback_state.test.ts` for pure lifecycle behavior; background integration is covered by Task 5.

**Interfaces:**

The background must accept these popup commands:

```text
GET_PLAYBACK_STATE
START_CURRENT_PAGE
PAUSE_READING
RESUME_READING
STOP_READING
CHANGE_SPEED { payload: { speed: number } }
```

It sends these offscreen commands:

```text
PLAY { payload: { sessionId, article, voiceStyleId, speed } }
PAUSE
PLAY { payload: { sessionId } }       // resume
STOP
CHANGE_SPEED { payload: { speed: number } }
```

- [ ] **Step 1: Add an explicit state queue** so hydration, start, stop, progress, and tab events cannot interleave. Use a queue with the following behavior: each operation runs after the previous one, and a rejected operation does not permanently block later operations.

```ts
let stateQueue = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
	const next = stateQueue.then(operation);
	stateQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}
```

- [ ] **Step 2: Hydrate the snapshot** from `chrome.storage.session` before serving `GET_PLAYBACK_STATE`; malformed values become `null`. Keep `activeSession` in memory and persist only the snapshot.
- [ ] **Step 3: Add `publishSession(session)` and `clearSession()`**. Persist the snapshot under `STORAGE_KEYS.PLAYBACK_SESSION` and broadcast `{ action: 'PLAYBACK_STATE_UPDATE', session }` to popup contexts. Clear storage after publishing the final stopped state so a reopened popup cannot see stale playback.
- [ ] **Step 4: Replace `EXTRACT_AND_PLAY` with `START_CURRENT_PAGE` orchestration**. Query the active tab, stop the existing session first, reject restricted URLs, extract the article, create a UUID session, publish `loading`, create the offscreen document, and send the article plus session ID to offscreen. Extraction or setup errors must publish a localized-safe error and leave no active session.
- [ ] **Step 5: Route control commands through the coordinator**. `PAUSE_READING`, `RESUME_READING`, and `CHANGE_SPEED` must require a current session, forward to offscreen, and let the returned progress update become the UI state. `STOP_READING` must invalidate/clear the session before sending `STOP`, then close the offscreen document.
- [ ] **Step 6: Validate progress messages** by reading the top-level `sessionId` and `progress` fields. Ignore unknown/old session IDs. Replace the current `chrome.storage.local.set({ playback_progress: payload })` behavior with session snapshot updates and popup broadcasts.
- [ ] **Step 7: Register tab lifecycle listeners**:

```ts
chrome.tabs.onRemoved.addListener((tabId) => {
	void enqueue(() => stopIfOwner(tabId, 'tab-removed'));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status === 'loading' || changeInfo.url !== undefined) {
		void enqueue(() => stopIfOwner(tabId, 'tab-navigation'));
	}
});
```

`stopIfOwner` must invalidate the session before forwarding `STOP`, tolerate an already-closed offscreen document, publish the final state, and clear the snapshot.
- [ ] **Step 8: Run `pnpm build`** and confirm strict TypeScript catches no unhandled message or Chrome listener types.
- [ ] **Step 9: Commit** with `feat: coordinate playback state from background`.

### Task 3: Propagate Session IDs Through Offscreen Playback

**Files:**
- Modify: `src/offscreen/offscreen.ts:6-57,209-438`

**Interfaces:**

Add a separate external session identifier beside the existing numeric
`playbackSession` inference guard:

```ts
let currentExtensionSessionId: string | null = null;
```

Every `PLAYBACK_PROGRESS_UPDATE` must have this shape:

```ts
chrome.runtime.sendMessage({
	action: 'PLAYBACK_PROGRESS_UPDATE',
	sessionId: currentExtensionSessionId,
	progress,
});
```

- [ ] **Step 1: Update `reportProgress`** to include the current extension session ID and preserve it for the final `stopped` event.
- [ ] **Step 2: Update `PLAY` payload parsing** to require `sessionId` and set it only after invalidating the prior numeric playback session. The article content remains local to `textChunks`.
- [ ] **Step 3: Keep numeric generation checks** around `playNextChunk`, `preFetchNextChunk`, `playAudioBuffer`, and synthesis callbacks. A stop or replacement must prevent every late callback from calling `reportProgress` for the new session.
- [ ] **Step 4: Ensure pause, resume, speed, completion, model errors, and synthesis errors report against the current external session ID.** Resume must not create a new external session ID.
- [ ] **Step 5: Run `pnpm build`** and verify the offscreen message contract matches the background types.
- [ ] **Step 6: Commit** with `fix: guard offscreen progress by reading session`.

### Task 4: Rehydrate Popup State and Expose Active-Page Context

**Files:**
- Modify: `src/popup/App.tsx:1-253`
- Modify: `src/popup/popup.css:105-223`

**Interfaces:**

Replace separate authoritative status/progress state with:

```ts
const [session, setSession] = useState<PlaybackSessionSnapshot | null>(null);
const [currentTabId, setCurrentTabId] = useState<number | undefined>();
```

- [ ] **Step 1: Update mount hydration** to send `GET_PLAYBACK_STATE`, apply `PlaybackStateResponse`, and still load voice/speed preferences from `chrome.storage.local`.
- [ ] **Step 2: Listen for `PLAYBACK_STATE_UPDATE`** and replace the session snapshot atomically. Do not set `status: 'stopped'` optimistically after a command; wait for the coordinator's update.
- [ ] **Step 3: Route controls**: start uses `START_CURRENT_PAGE`, pause uses `PAUSE_READING`, resume uses `RESUME_READING`, stop uses `STOP_READING`, and speed changes continue to persist the preference while sending `CHANGE_SPEED`.
- [ ] **Step 4: Render session metadata** when a session exists: title, host, current paragraph, progress, status, and whether `session.tabId !== currentTabId`. Add a “Read this page instead” action when the active session belongs to another tab; it sends `START_CURRENT_PAGE` explicitly.
- [ ] **Step 5: Reset error/session UI** when the coordinator publishes `null`; keep model loading messages ephemeral and separate from playback session state.
- [ ] **Step 6: Add styles** for a truncated title and tab-context line using the existing spacing tokens and no new layout dependency.
- [ ] **Step 7: Run `pnpm build`** and confirm the popup compiles without stale status variables.
- [ ] **Step 8: Commit** with `feat: reconnect popup to active reading session`.

### Task 5: Add Regression Coverage for Reopen and Tab Lifecycle

**Files:**
- Create: `tests/e2e/reading-state.spec.ts`
- Modify: `tests/e2e/tts-controls.spec.ts:5-33,85-171`
- Modify: `tests/e2e/fixtures.ts:5-76` only if a reusable runtime mock helper is extracted.

**Interfaces:**

Extend the existing popup runtime mock so `GET_PLAYBACK_STATE` invokes its
callback with a configurable `PlaybackStateResponse`, and so state updates are
delivered through the existing `mockReceiveMessage` helper. Keep model/audio
mocking local; these tests must not download Supertonic assets.

- [ ] **Step 1: Update the existing TTS mock** to answer `GET_PLAYBACK_STATE` with `{ session: null }` and to record the new command names.
- [ ] **Step 2: Add a popup hydration test** that seeds a session snapshot in the mock, opens the popup, verifies title/status/progress, reloads the popup page to simulate close/reopen, and verifies the same snapshot is rendered again.
- [ ] **Step 3: Add a control-routing test** that verifies pause, resume, stop, and “Read this page instead” send the coordinator commands rather than direct offscreen commands.
- [ ] **Step 4: Add unit assertions** for tab ownership and stale progress in `tests/unit/playback_state.test.ts`, including progress arriving after the session has been cleared.
- [ ] **Step 5: Run `pnpm test:unit`** and confirm the state helpers and existing unit suite pass.
- [ ] **Step 6: Build before E2E** with `pnpm build` so Playwright loads the current `dist/` artifact.
- [ ] **Step 7: Run `pnpm test:e2e`** and confirm existing extraction/support/Free-boundary tests remain green alongside the new reading-state suite.
- [ ] **Step 8: Commit** with `test: cover reading session reconnection`.

### Task 6: Final Verification and Documentation Consistency

**Files:**
- Verify: `_docs/specs/2026-07-12-reading-state-lifecycle.md`
- Verify: `_docs/specs/2026-07-12-free-mvp-design.md`
- Verify: `public/manifest.json`

- [ ] **Step 1: Run the complete verification set**:

```bash
pnpm build
pnpm test:unit
pnpm test:e2e
```

- [ ] **Step 2: Inspect the built artifact** and confirm no new permission, API URL, article storage key, or backend dependency was introduced.
- [ ] **Step 3: Check the documentation boundary**: the lifecycle spec must continue to state that article/audio are memory-only and browser restart recovery is out of scope; the Free MVP spec must not gain Pro/backend runtime assumptions.
- [ ] **Step 4: Update the lifecycle spec status** from `Draft for review` to `Implemented` only after all tests pass and the acceptance cases are verified.
- [ ] **Step 5: Record the final verification commands and result** in the implementation handoff, including any environment limitation that prevents real Supertonic audio playback in CI.
- [ ] **Step 6: Commit** with `docs: finalize reading state lifecycle implementation`.

## Self-Review Checklist

- **Spec coverage:** Tasks 1–2 cover snapshot ownership and tab lifecycle; Task 3 covers offscreen session guards; Task 4 covers popup reconnect and cross-tab context; Task 5 covers all seven acceptance scenarios; Task 6 covers Free boundary and documentation.
- **Privacy:** No task writes `Article.content`, `textChunks`, `AudioBuffer`, or generated audio to storage.
- **Permissions:** The plan uses existing `activeTab`, `scripting`, `storage`, and `offscreen` permissions only.
- **Type consistency:** `PlaybackSessionSnapshot`, `PlaybackProgressUpdateMessage`, and `PlaybackStateResponse` are defined in Task 1 and consumed by Tasks 2–5.
- **Race safety:** The background queue and external session ID are both required; either one alone would leave a stale-progress path.
- **No model dependency in tests:** Popup/state tests mock runtime messages and do not require model downloads or real audio output.
