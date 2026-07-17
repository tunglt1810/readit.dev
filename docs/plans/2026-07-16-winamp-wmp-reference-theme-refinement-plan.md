# Winamp and WMP Reference Theme Refinement Implementation Plan

**Goal:** Match the existing Winamp and WMP popup themes to their approved player references while preserving local-only playback, storage, keyboard behavior, and accessibility.

**Architecture:** `App` remains the sole owner of popup state and runtime messages. A small reusable speed control and theme-specific presentation zones/classes provide the visual changes; the default theme retains its existing controls and behavior. CSS replaces the earlier broad Winamp/WMP overrides with a mechanical Winamp display/deck and a dark WMP Now Playing canvas/transport pod.

**Tech stack:** React 19, TypeScript 6, vanilla CSS, Chrome MV3 storage/runtime messaging, Node test runner, and Playwright.

## Global Constraints

- Preserve `default | winamp | wmp12` and `STORAGE_KEYS.THEME === 'readit_active_theme'`.
- Keep article content and speech processing on-device. Do not change the background, offscreen document, content script, backend, or message protocol.
- Do not add dependencies, raster assets, playlists, volume, Previous, Next, Shuffle, Repeat, or fullscreen behavior.
- Preserve the default theme's markup, labels, and start/stop/pause behavior.
- Only real controls receive focus. Fake titlebar controls, WMP artwork, meters, dividers, and chrome are decorative and `aria-hidden="true"`.
- Preserve theme-selector keyboard behavior and localized accessible names.
- Keep the popup usable at 360px without horizontal overflow. Store temporary test artifacts under `/.tmp`.
- Preserve the unrelated untracked `context_improvement.md` file.

## Task 1: Define the Themed Transport Contract

**Files:** `src/popup/App.tsx`, `src/shared/constants.ts`, `tests/unit/theme_i18n.test.ts`, `tests/e2e/themes.spec.ts`

1. Add `nowPlaying` translations: `Đang phát` in Vietnamese and `Now Playing` in English. Add a unit assertion for both keys before implementation.
2. Add `ReadingSpeedControl` with native range semantics. WMP uses the compact renderer in its transport; Default and Winamp retain the settings range.
3. Keep the default `.playback-controls` branch, handlers, labels, and behavior unchanged. Add a themed transport branch with these mappings:

   | Status | Primary action | Stop action |
   | --- | --- | --- |
   | `stopped` / `error` | `START_CURRENT_PAGE` | hidden |
   | `playing` | `PAUSE_READING` | `STOP_READING` |
   | `paused` | `RESUME_READING` | `STOP_READING` |
   | `loading` | disabled | `STOP_READING` |

4. Render decorative Winamp and WMP titlebars, WMP artwork, and the WMP Now Playing label as `aria-hidden` presentation chrome. Do not add fake media controls.
5. Add E2E coverage for the real themed pause/stop controls and the absence of fake controls. Verify the default transport still passes unchanged tests.

**Commit target:** `feat: add themed playback transport`

## Task 2: Replace the WMP Aero Shell

**Files:** `src/popup/popup.css`, `tests/e2e/themes.spec.ts`

1. Add a red visual E2E test for the WMP artwork, graphite transport gradient, circular cobalt/chrome primary button, compact speed control, and no 360px overflow.
2. Replace the entire prior WMP Aero section with the approved dark values:
   - Canvas `#05080a` with radial gradient through `#0a1c2b` and `#183f5a`.
   - Graphite transport gradient `#646b6f` → `#3b3f41` → `#51575a`.
   - Circular primary radial gradient from `#f1fdff` through `#187fca` to `#03294e`.
   - Blue progress `#0f74bf`–`#56c6fb`, dark stop button, and spherical speed thumb.
3. Remove bright Aero glass, WMP backdrop blur, and flat cyan button overrides. Add hover, active, and high-contrast `:focus-visible` states only to real controls.
4. Keep title, status, and session text above the progress rail with a black text shadow.
5. Preserve useful Winamp visual coverage while replacing obsolete WMP visual assertions.

**Commit target:** `feat: match wmp now playing reference`

## Task 3: Refine the Winamp Skin and Motion

**Files:** `src/popup/popup.css`, `tests/e2e/themes.spec.ts`

1. Add a red E2E test for the decorative titlebar, visible playing meter, mechanical deck, dark LCD, and static meter under reduced motion.
2. Apply the approved mechanical style:
   - Striped charcoal chassis with `#acacac`/`#060606` bevels.
   - `#020303` LCD and `#71ea64` phosphor text.
   - Segmented progress using `#8fdf53` and `#1b4422`.
   - Rectangular `#1e1e20` deck with 3D keys and a `1px` active press.
3. Preserve the existing `status === 'playing'` meter guard and its green/yellow/red keyframes. Add the reduced-motion rule that sets meter animation to `none`.
4. Keep fake window chrome non-interactive and decorative.

**Commit target:** `feat: refine winamp classic skin`

## Task 4: Complete State, Composition, and Build Verification

**Files:** `src/popup/App.tsx`, `src/popup/popup.css`, `tests/e2e/themes.spec.ts`

1. Add table-driven Playwright coverage for both `winamp` and `wmp12`:
   - Stopped and error: enabled Read control sends `START_CURRENT_PAGE`.
   - Loading: Read is disabled and Stop is enabled.
   - Paused: Resume sends `RESUME_READING`.
   - Speed range set to `1.3` sends `CHANGE_SPEED` with `payload.speed === 1.3`.
   - Existing playing coverage retains pause and stop assertions.
2. Keep the WMP order as canvas/status/context → `.wmp-voice-control` → progress rail → `.wmp-transport`; the WMP voice select is not duplicated in the later configuration section. Default and Winamp retain their existing configuration section.
3. Remove custom-theme inherited status-dot loops. Keep the Winamp visualizer decorative and the only custom-theme meter animation; reduced motion disables it. Do not hide the real `role="status"` live region.
4. Verify WMP has no horizontal overflow at 360px and that the WMP visual order is reflected in DOM and vertical layout.
5. Run the complete verification sequence:

   ```sh
   CI=true pnpm test:unit
   CI=true pnpm build
   CI=true pnpm validate:manifest
   CI=true pnpm test:e2e
   CI=true pnpm exec biome check src/popup/App.tsx src/popup/popup.css src/shared/constants.ts tests/unit/theme_i18n.test.ts tests/e2e/themes.spec.ts
   git diff --check
   ```

**Commit targets:** `test: cover classic theme playback states` and, if needed solely for formatter output, `style: format classic theme css`.

## Final Acceptance

- Both custom themes match their approved visual language without creating unavailable controls.
- The default theme remains behaviorally and structurally unchanged.
- Storage, localization, local-only processing, selector keyboard behavior, and accessible labels remain intact.
- Unit, build, manifest, E2E, formatter, and diff checks pass.
