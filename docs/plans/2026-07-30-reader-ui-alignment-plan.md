# Reader UI Alignment & Control Style Unification Plan

**Goal**: Align Reader View container width with the Toolbar control box (edge-to-edge) and unify control button/input styling with Popup & Side-Panel design system.

**Target Branch**: `fix/reader-ui-alignment`  
**Spec Document**: [2026-07-30-reader-ui-alignment-design.md](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/fix-reader-ui-alignment/docs/specs/2026-07-30-reader-ui-alignment-design.md)

---

## User Review Required
> [!NOTE]
> All changes are restricted to Reader UI components (`src/reader/App.tsx` and `src/reader/reader.css`) without breaking existing state/port communication logic.

---

## Proposed Changes

### Reader Component & Styles Layer

#### [MODIFY] [App.tsx](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/fix-reader-ui-alignment/src/reader/App.tsx)
- Restructure Toolbar control elements with structured uppercase labels (`.form-label`) matching Popup layout.
- Update Speed & Progress header rows so values (`1.05×` and `0%`) render inline with label headers.
- Apply Popup button/control CSS class names (`btn`, `btn-primary`, `btn-secondary`, `form-select`, `form-slider`).
- Sanitize article content string to eliminate excessive consecutive empty lines (`\n{3,}` -> `\n\n`).

#### [MODIFY] [reader.css](file:///Users/bez/Workspace/repos/bez/readit.dev/.worktrees/fix-reader-ui-alignment/src/reader/reader.css)
- Set container `.document-reader` width to `width: min(920px, calc(100% - 48px)); margin: 0 auto;`.
- Set both `.document-reader-toolbar` and `.document-reader-content` to `width: 100%; max-width: none;` to enforce perfect edge-to-edge alignment.
- Import / incorporate Popup design system tokens for buttons, sliders, selects, and progress bars.
- Refine typography: `line-height: 1.75; font-size: clamp(17px, 1.8vw, 20px); padding: clamp(28px, 4.5vw, 56px);`.

---

## Verification Plan

### Automated Tests
- Run `pnpm test:unit` to verify document reader word mapping and session state unit tests pass clean.
- Run `pnpm build` to verify TypeScript strict type checks and production bundle creation.

### Manual Verification
- Visual inspection of Reader View UI to confirm toolbar control box and article content card have matching equal width.
- Confirm Play/Pause, Stop, Voice dropdown, Speed slider, and Progress bar match Popup/SidePanel visual styling.
