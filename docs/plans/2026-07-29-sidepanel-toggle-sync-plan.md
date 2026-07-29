# Side-Panel State Synchronization & Toggle Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Side-Panel state synchronization between Background Service Worker and Popup UI, ensuring the Side-Panel open/close button acts as a reliable, self-healing toggle button.

**Architecture:** Implement explicit windowId handshake from Side-Panel to Background, add Service Worker startup/hydration cleanup of stale storage, implement auto-reconnect from Side-Panel on port disconnect, and add a self-healing fallback mechanism in Popup UI when closing fails.

**Tech Stack:** TypeScript, React 19, Chrome Extension MV3 (`chrome.sidePanel`, `chrome.runtime`, `chrome.storage`), Node test runner (`node:test`).

## Global Constraints

- Use strict TypeScript and React functional components.
- Do NOT touch existing CSS rules in `src/shared/theme.css` (`.btn-icon-sidepanel`, `.btn-icon-sidepanel.active`, `aria-pressed="true"` are already styled).
- Unit tests must use `node:test` and `node:assert/strict`.

---

### Task 1: Side-Panel Handshake & Auto-Reconnect

**Files:**
- Modify: `src/sidepanel/App.tsx:230-260`
- Test: `tests/unit/side_panel.test.ts`

**Interfaces:**
- Consumes: `chrome.windows.getCurrent`, `chrome.runtime.connect`
- Produces: Message `{ action: 'REGISTER_SIDEPANEL', payload: { windowId } }` sent over `sidepanel-port`

- [ ] **Step 1: Write the failing unit test**

Add test to `tests/unit/side_panel.test.ts` verifying that sidepanel handshake payload format is generated correctly:

```typescript
test('buildSidePanelRegisterMessage constructs correct registration payload for a given windowId', () => {
	const msg = buildSidePanelRegisterMessage(42);
	assert.deepEqual(msg, { action: 'REGISTER_SIDEPANEL', payload: { windowId: 42 } });
});
```

- [ ] **Step 2: Run unit test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL with `buildSidePanelRegisterMessage is not defined`.

- [ ] **Step 3: Implement helper function and update `src/sidepanel/App.tsx`**

In `src/popup/side_panel.ts` (or `src/sidepanel/App.tsx`), export helper:

```typescript
export function buildSidePanelRegisterMessage(windowId: number) {
	return { action: 'REGISTER_SIDEPANEL', payload: { windowId } };
}
```

In `src/sidepanel/App.tsx`, inside `useEffect`:

```typescript
useEffect(() => {
	let port: chrome.runtime.Port | null = null;
	let reconnectTimer: NodeJS.Timeout | null = null;

	const connectPort = () => {
		try {
			if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
				port = chrome.runtime.connect({ name: 'sidepanel-port' });

				// Fetch exact window ID for handshake
				if (chrome.windows?.getCurrent) {
					chrome.windows.getCurrent((win) => {
						if (win?.id) {
							port?.postMessage(buildSidePanelRegisterMessage(win.id));
						}
					});
				}

				port.onMessage?.addListener((msg) => {
					if (msg?.action === 'CLOSE_SIDEPANEL') {
						window.close();
					}
				});

				port.onDisconnect?.addListener(() => {
					port = null;
					// Reconnect after brief delay if sidepanel remains open
					reconnectTimer = setTimeout(connectPort, 1000);
				});
			}
		} catch (_e) {
			// ignore in non-extension environments
		}
	};

	connectPort();

	return () => {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		port?.disconnect();
	};
}, []);
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
 git add src/sidepanel/App.tsx src/popup/side_panel.ts tests/unit/side_panel.test.ts
 git commit -m "fix(sidepanel): add windowId handshake and auto-reconnect"
```

---

### Task 2: Background Service Worker Port & Hydration Management

**Files:**
- Modify: `src/background/background.ts:968-985,1220-1240`
- Test: `tests/unit/side_panel.test.ts`

**Interfaces:**
- Consumes: `{ action: 'REGISTER_SIDEPANEL', payload: { windowId } }` message, `{ action: 'CLOSE_SIDEPANEL', payload: { windowId } }`
- Produces: Updated `chrome.storage.local` key `readit_open_sidepanel_windows`, response `{ success: boolean, reason?: string }` for `CLOSE_SIDEPANEL`

- [ ] **Step 1: Write the failing unit test**

Add unit test to `tests/unit/side_panel.test.ts` for updating sidepanel window IDs storage helper:

```typescript
test('computeOpenSidePanelWindowIds filters out invalid or duplicate window IDs', () => {
	const activeWindowIds = computeOpenSidePanelWindowIds([10, 20, 10, 0, -1]);
	assert.deepEqual(activeWindowIds, [10, 20]);
});
```

- [ ] **Step 2: Run unit test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL with `computeOpenSidePanelWindowIds is not defined`.

- [ ] **Step 3: Implement helper and update `src/background/background.ts`**

Export helper `computeOpenSidePanelWindowIds` in `src/popup/side_panel.ts`:

```typescript
export function computeOpenSidePanelWindowIds(rawIds: Iterable<number>): number[] {
	const valid = new Set<number>();
	for (const id of rawIds) {
		if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
			valid.add(id);
		}
	}
	return Array.from(valid);
}
```

In `src/background/background.ts`:
Update `updateOpenSidePanelWindowsStorage`:

```typescript
async function updateOpenSidePanelWindowsStorage() {
	const openWindowIds = computeOpenSidePanelWindowIds(openSidePanelPorts.keys());
	if (typeof chrome !== 'undefined' && chrome.storage?.local) {
		await chrome.storage.local.set({ readit_open_sidepanel_windows: openWindowIds });
	}
}
```

Update `sidepanel-port` listener in `background.ts`:

```typescript
if (port.name === 'sidepanel-port') {
	port.onMessage.addListener((msg: unknown) => {
		const message = msg as { action?: string; payload?: { windowId?: number } };
		if (message?.action === 'REGISTER_SIDEPANEL' && typeof message.payload?.windowId === 'number') {
			const wId = message.payload.windowId;
			openSidePanelPorts.set(wId, port);
			void updateOpenSidePanelWindowsStorage();

			port.onDisconnect.addListener(() => {
				if (openSidePanelPorts.get(wId) === port) {
					openSidePanelPorts.delete(wId);
					void updateOpenSidePanelWindowsStorage();
				}
			});
		}
	});
}
```

Update `CLOSE_SIDEPANEL` message handler in `background.ts`:

```typescript
case 'CLOSE_SIDEPANEL': {
	const targetWindowId = (msg.payload as Record<string, unknown> | undefined)?.windowId as number | undefined;
	if (targetWindowId) {
		const port = openSidePanelPorts.get(targetWindowId);
		if (port) {
			try {
				port.postMessage({ action: 'CLOSE_SIDEPANEL' });
			} catch (_e) {
				// ignore
			}
			openSidePanelPorts.delete(targetWindowId);
			void updateOpenSidePanelWindowsStorage();
			sendResponse?.({ success: true });
		} else {
			// Port was missing or already closed - clean up storage and report NOT_FOUND
			void updateOpenSidePanelWindowsStorage();
			sendResponse?.({ success: false, reason: 'NOT_FOUND' });
		}
		if (typeof chrome !== 'undefined' && chrome.sidePanel?.setOptions) {
			void chrome.sidePanel.setOptions({ windowId: targetWindowId, enabled: false } as any).then(() => {
				void chrome.sidePanel.setOptions({ windowId: targetWindowId, enabled: true } as any);
			});
		}
	} else {
		sendResponse?.({ success: false, reason: 'INVALID_WINDOW_ID' });
	}
	return true;
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `pnpm test:unit`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
 git add src/background/background.ts src/popup/side_panel.ts tests/unit/side_panel.test.ts
 git commit -m "fix(background): sync sidepanel ports with explicit windowId handshake"
```

---

### Task 3: Popup Self-Healing Toggle Button Logic

**Files:**
- Modify: `src/popup/App.tsx:218-230`
- Test: `tests/unit/side_panel.test.ts`

**Interfaces:**
- Consumes: `{ action: 'CLOSE_SIDEPANEL', payload: { windowId } }` response `{ success: boolean, reason?: string }`
- Produces: Self-healing fallback to `openSidePanelForCurrentWindow({ windowId })` when close response fails or is `NOT_FOUND`

- [ ] **Step 1: Write unit test for self-healing toggle decision helper**

Add test to `tests/unit/side_panel.test.ts`:

```typescript
test('shouldFallbackToOpen returns true when CLOSE_SIDEPANEL returns success: false', () => {
	assert.equal(shouldFallbackToOpen({ success: false, reason: 'NOT_FOUND' }), true);
	assert.equal(shouldFallbackToOpen({ success: true }), false);
	assert.equal(shouldFallbackToOpen(undefined), false);
});
```

- [ ] **Step 2: Run unit test to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL with `shouldFallbackToOpen is not defined`.

- [ ] **Step 3: Implement helper and update `handleToggleSidePanel` in `src/popup/App.tsx`**

Export helper in `src/popup/side_panel.ts`:

```typescript
export function shouldFallbackToOpen(response: unknown): boolean {
	if (response && typeof response === 'object' && 'success' in response) {
		return (response as { success: boolean }).success === false;
	}
	return false;
}
```

In `src/popup/App.tsx`, update `handleToggleSidePanel`:

```typescript
const handleToggleSidePanel = () => {
	setCommandError('');
	if (isSidePanelOpen) {
		if (sidePanelWindowId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
			chrome.runtime.sendMessage(
				{ action: 'CLOSE_SIDEPANEL', payload: { windowId: sidePanelWindowId } },
				(response) => {
					if (shouldFallbackToOpen(response)) {
						// Sidepanel was not actually open; self-heal by opening it directly
						void openSidePanelForCurrentWindow({
							windowId: sidePanelWindowId,
							open: (options) => chrome.sidePanel.open(options),
						}).catch(() => setCommandError(t('openSidePanelFailed')));
					}
				},
			);
		}
	} else {
		void openSidePanelForCurrentWindow({
			windowId: sidePanelWindowId,
			open: (options) => chrome.sidePanel.open(options),
		}).catch(() => setCommandError(t('openSidePanelFailed')));
	}
};
```

- [ ] **Step 4: Run unit tests and typecheck to verify build**

Run: `pnpm test:unit && pnpm build`
Expected: PASS and successful build.

- [ ] **Step 5: Commit changes**

```bash
 git add src/popup/App.tsx src/popup/side_panel.ts tests/unit/side_panel.test.ts
 git commit -m "fix(popup): add self-healing toggle button fallback for side-panel"
```

---

## Plan Self-Review

1. **Spec Coverage Check**:
   - Sidepanel handshake & auto-reconnect -> Task 1
   - Background port management & storage cleanup -> Task 2
   - Popup self-healing toggle button -> Task 3
2. **Placeholder Scan**: No TODO/TBD or vague descriptions. All code steps contain full TypeScript implementations.
3. **Type Consistency**: `windowId` (number), `buildSidePanelRegisterMessage`, `computeOpenSidePanelWindowIds`, `shouldFallbackToOpen` consistent across all 3 tasks.
