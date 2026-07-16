# Design: Winamp Classic and Windows Media Player Reference Theme Refinement

## 1. Goal

Refine the two existing popup themes against the approved visual references:

- **Winamp Classic** should feel like a modular player skin: a heavy metal frame, green LCD, meter/equalizer, mechanical deck, and configuration panels.
- **Windows Media Player** should be a dark "Now Playing" screen: centered music artwork, a progress rail near the bottom, and a graphite transport pod with a cobalt/chrome primary Play button.

Themes are presentation layers for the same reader. Theme selection remains in `STORAGE_KEYS.THEME`; playback state, runtime messages, voice, and speed continue to have one source of truth in `src/popup/App.tsx`.

This document supersedes conflicting Winamp/WMP visual details in `_docs/specs/2026-07-15-classic-media-player-themes.md`, especially the bright WMP Aero glass and silver dock.

## 2. Scope

### Included

- Minimal popup DOM changes that establish theme-specific presentation zones.
- `src/popup/popup.css` refinements for the `winamp` and `wmp12` themes.
- Existing selector, storage persistence, localization, and behavior remain intact.
- Playwright and unit coverage for changed behavior and distinctive visual contracts.

### Excluded

- No Previous, Next, Shuffle, Repeat, volume, playlist, fullscreen, or other new playback command.
- No changes to the background, offscreen document, content script, backend, or message protocol.
- No raster artwork, external skin assets, or a full clone of either media-player UI. The music artwork is an internal decorative CSS element.
- No change to the default theme.

## 3. Presentation Architecture

`App` continues to own `session`, `status`, `activeVoice`, `speed`, `activeTheme`, `handleStartCurrentPage`, `handleReadPage`, `handlePlayPause`, `handleVoiceChange`, and `handleSpeedChange`.

Each theme only changes the presentation around existing controls:

1. **Display zone:** status, current article, host/context, and progress.
2. **Transport zone:** real read, pause, resume, and stop controls arranged like the reference player.
3. **Configuration zone:** the existing voice select and speed range in theme-appropriate panels.
4. **Supporting zone:** model errors, the read-current-tab action, and the privacy disclosure remain available under their existing conditions.

No theme-specific playback store or playback handler is introduced. Decorative markup such as titlebars, artwork, meters, dividers, and chrome cannot receive focus and is marked as decorative. The current theme selector remains in the header and retains its keyboard order and behavior.

## 4. Shared Control Contract

The primary control follows the same state machine in both custom themes:

| Playback status | Primary control | Stop control |
| --- | --- | --- |
| `stopped` or `error` | Start the current page | Hidden |
| `playing` | Pause | Visible; stops the active session |
| `paused` | Resume | Visible; stops the active session |
| `loading` | Disabled while preparation is in progress | Visible; cancels preparation with the existing stop command |

This adds no runtime command. The primary control uses the existing start, pause, and resume actions; Stop sends `STOP_READING`. The visual grouping may vary by theme, but no single button has ambiguous behavior in one state.

## 5. Winamp Classic Theme

### Layout

1. **Frame and titlebar:** a dark 3D frame with a metal texture, a blue-purple/black titlebar labeled `READIT · WINAMP`, and decorative window chrome.
2. **LCD display:** near-black background, phosphor-green monospace text, playback status, progress, and the article title. Only `playing` renders the multi-column meter; other states remain static.
3. **Seek rail:** the existing progress indicator becomes an inset rail with segmented green/yellow completion.
4. **Mechanical deck:** real controls are rectangular keys with a light top bevel and dark bottom bevel; pressing moves a key down `1px` and reverses the bevel.
5. **Configuration module:** the voice select and speed range remain native controls inside a `VOICE CONFIGURATION` panel with mechanical styling.
6. **Supporting zone:** alerts, read-current-tab action, and disclosure sit below the modules in the skin's compact typography without being obscured by texture.

### Color and Motion

- Frame: charcoal `#25272b`–`#3b3e43`, light bevel `#acacac`, and dark shadow `#060606`.
- LCD: `#020303`, green text/meter `#71ea64`/`#23b83a`, with optional yellow peak `#f5ae38`.
- The meter animates only while playing. `prefers-reduced-motion: reduce` shows static bar heights and removes the loop.

## 6. Windows Media Player Theme

### Layout

1. **Dark Now Playing canvas:** a dark blue-black radial-gradient surface holding the title, status, context, and a square decorative music-artwork tile.
2. **Configuration before playback controls:** the real voice select appears after the canvas/context content and before the progress rail. The speed value/range remains inside the transport pod; neither control becomes an unlabeled icon.
3. **Progress near the bottom:** a dark rail with blue fill. It remains an indicator, not a new seek control.
4. **Transport pod:** a rounded graphite strip directly below the progress rail. Its centered primary Play/Pause/Resume control is a cobalt circular button; Stop is a smaller square key beside it; the speed range shares the pod.
5. **Supporting zone:** errors, read-current-tab action, and privacy disclosure retain their existing content and conditions with sufficient contrast on the dark background.

### Approved Colors and Button Effects

- Canvas: `#05080a` with a blue-black gradient from `#0a1c2b` to `#183f5a`.
- Pod: graphite gradient `#646b6f` → `#3b3f41` → `#51575a`, with a top inset highlight and lower inset shadow.
- Primary control: radial gradient from `#f1fdff`/`#a4ebff` through `#187fca` and `#075eae` to `#03294e`; a double chrome border, curved upper highlight, deep-blue inset shadow, and black outer shadow.
- Progress and speed: dark grey rail, active blue `#0f74bf`–`#56c6fb`, and a spherical blue thumb with a bright edge.
- Secondary icons are pale silver on dark graphite. Only real controls receive subtle hover, focus, and active feedback. The prior flat cyan treatment and bright Aero glass are not used.

`Previous`, `Next`, `Shuffle`, `Repeat`, and fullscreen are not shown as real controls because they would promise capabilities the extension does not provide.

## 7. Accessibility, Localization, and Error States

- Interactive controls remain real `<button>`, `<select>`, and `<input type="range">` elements. Icon-only buttons always retain localized accessible names.
- The theme selector keeps its `Escape`, focus-return, `aria-expanded`, and keyboard behavior.
- Fake titlebars, artwork, meters, chrome, dividers, and decorative icons use `aria-hidden="true"` and cannot take focus. The live status itself remains accessible.
- New user-visible labels are added to `THEME_TRANSLATIONS` in both Vietnamese and English; decorative names and symbols need no translation.
- Model and command errors retain their current role and visibility. Winamp presents them in a high-contrast dark panel; WMP presents them on the dark canvas or supporting panel without relying on color alone.
- Motion respects `prefers-reduced-motion`. The custom themes do not inherit infinite status-dot animation; the Winamp playing meter is the only custom-theme loop and is suppressed under reduced motion.

## 8. Testing and Acceptance Criteria

### Automated

1. Unit tests validate the storage key and new translation keys for both locales.
2. Playwright validates selector keyboard opening, `Escape` closing, theme persistence, and hydration after reload.
3. Playwright validates accessible names and runtime messages for start, pause, resume, stop, and speed in both custom themes.
4. Playwright validates theme-specific styling:
   - Winamp has a dark LCD, mechanical deck, and meter only while playing.
   - WMP has the dark Now Playing canvas, blue progress rail, graphite pod, cobalt/chrome primary button, and voice → progress → transport order.
5. At 360px, the popup has no horizontal overflow and voice, speed, privacy, and read-current-tab controls remain reachable.
6. Reduced-motion coverage verifies the Winamp meter becomes static and custom-theme status indicators do not animate indefinitely.

### Manual

1. Review visual snapshots for `stopped`, `loading`, `playing`, `paused`, and `error` in both themes.
2. Use keyboard-only navigation to switch themes, operate controls, and adjust speed.
3. Enable reduced motion to verify that the meter does not loop.
4. Confirm the default theme's appearance and behavior are unchanged.

### Complete When

- Winamp is immediately recognizable as a classic player skin with an LCD and modules, not a recolored modern dark UI.
- WMP is immediately recognizable as a dark Now Playing player using the approved artwork, progress rail, transport pod, and Play-button language.
- No visible control promises unavailable functionality.
- Playback, persistence, localization, and privacy disclosure continue to work as before.
