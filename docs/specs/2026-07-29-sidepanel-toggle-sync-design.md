# Side-Panel State Synchronization & Toggle Button Fix

## Problem Statement

When the Chrome Side-Panel is closed abnormaly (e.g. closed directly via Chrome's native Side-Panel UI 'X' button, or closed while the Service Worker is suspended/restarted), the Popup UI button state for opening the Side-Panel remains stuck in the "open" (`active`) state. 

Clicking the button in this state sends a `CLOSE_SIDEPANEL` message to the background Service Worker, which fails to close or open the panel because the Port connection is already dead. As a result, the user cannot open the Side-Panel via the Popup button.

Additionally, the Popup button needs to act as a reliable, self-healing Toggle Button (Open when closed, Close when open, and self-heal state if out of sync).

## Root Causes

1. **Incorrect Window ID Mapping on Registration**:
   When connecting `sidepanel-port` from `src/sidepanel/App.tsx`, `port.sender.tab` is `undefined` because the Side-Panel is an extension view, not a browser tab. The background script fell back to `chrome.windows.getCurrent()`, which in MV3 Service Worker context can return the wrong `windowId` (e.g., the popup's window or focused window).

2. **Service Worker Lifecycle & Memory Loss**:
   Chrome MV3 Service Workers suspend after ~30 seconds of inactivity, wiping the in-memory `openSidePanelPorts` Map. However, `readit_open_sidepanel_windows` in `chrome.storage.local` persisted stale `windowId`s. When the Popup opens, it reads stale storage and assumes the Side-Panel is open.

3. **Lack of Auto-Reconnect**:
   When the Service Worker restarts while a Side-Panel remains open, the Side-Panel did not attempt to reconnect its port, leaving `openSidePanelPorts` empty.

## Technical Design & Architecture

### 1. Side-Panel Handshake & Auto-Reconnect (`src/sidepanel/App.tsx`)

- Upon mounting, `sidepanel/App.tsx` queries `chrome.windows.getCurrent()` to obtain its exact `windowId`.
- Establishes a runtime port named `sidepanel-port`.
- Immediately posts a registration message over the port:
  `port.postMessage({ action: 'REGISTER_SIDEPANEL', payload: { windowId } });`
- Listens for `port.onDisconnect`. If disconnected while the Side-Panel frame is still mounted (e.g., Service Worker restarted), automatically attempts port reconnection with exponential backoff / retry.

### 2. Service Worker Port & Storage Lifecycle (`src/background/background.ts`)

- Maintains an in-memory `openSidePanelPorts = new Map<number, chrome.runtime.Port>()`.
- Upon receiving `REGISTER_SIDEPANEL` message from a `sidepanel-port`, maps `windowId -> Port` and listens to `port.onDisconnect` to remove `windowId` from `openSidePanelPorts` and update `chrome.storage.local`.
- **Hydration / SW Startup**:
  When Service Worker wakes up, resets `readit_open_sidepanel_windows` in `chrome.storage.local` to match currently connected active ports (`Array.from(openSidePanelPorts.keys())`). Active Side-Panels will reconnect immediately, re-populating storage accurately.
- **`CLOSE_SIDEPANEL` Message Handling**:
  Returns `{ success: boolean, reason?: string }` response. If no active port exists for the requested `windowId`, updates `chrome.storage.local` to remove `windowId` and returns `{ success: false, reason: 'NOT_FOUND' }`.

### 3. Popup Toggle Button & Self-Healing (`src/popup/App.tsx`)

- Uses existing CSS classes (`.btn-icon-sidepanel`, `.btn-icon-sidepanel.active`, `aria-pressed`).
- Reads `readit_open_sidepanel_windows` from `chrome.storage.local` and listens to `chrome.storage.onChanged`.
- On Click (`handleToggleSidePanel`):
  - If `isSidePanelOpen` is `false`: Call `openSidePanelForCurrentWindow({ windowId })`.
  - If `isSidePanelOpen` is `true`: Send `CLOSE_SIDEPANEL` message with `windowId`.
    - **Self-Healing Fallback**: If background responds with `{ success: false }` or error (indicating the sidepanel was not actually active), Popup automatically falls back to calling `openSidePanelForCurrentWindow({ windowId })` to open the Side-Panel immediately in a single click.

## Verification Plan

### Manual Verification
1. Open Side-Panel via Popup toggle button -> Verify button becomes `active` (`aria-pressed="true"`).
2. Close Side-Panel via Chrome's native Side-Panel close button ('X') -> Open Popup -> Verify button returns to normal (`inactive`).
3. Open Side-Panel -> Manually inspect Service Worker in `chrome://extensions` and click "Terminate" (simulating SW suspend/restart) -> Open Popup -> Verify state remains accurately in sync and clicking toggle operates properly.
4. Click toggle button when in out-of-sync state -> Verify Self-Healing opens the Side-Panel directly.
