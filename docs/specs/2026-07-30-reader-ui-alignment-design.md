# Reader UI Alignment & Aesthetics Design Spec

**Date**: 2026-07-30  
**Status**: Approved / In Progress  
**Branch**: `fix/reader-ui-alignment`

## 1. Overview
The Reader View (`src/reader/App.tsx` and `src/reader/reader.css`) requires full UI alignment and style unification with the extension's Popup and Side Panel components:
1. **Control Box & Content Card Width Alignment**: The article card `.document-reader-content` must have the exact same width as the toolbar `.document-reader-toolbar`, creating a unified vertical edge-to-edge alignment.
2. **Unified Control Styling**: All buttons, selects, sliders, and progress indicators in Reader View must share the exact style tokens and component CSS classes used in Popup and Side Panel (`.btn`, `.btn-primary`, `.btn-secondary`, `.form-select`, `.form-slider`, uppercase `.form-label`).
3. **Clean Header Layout**: Logo `readit.dev`, article title, and `Back to source` button flex-aligned without vertical displacement.

---

## 2. Mockup Reference
Below is the updated design mockup reflecting edge-to-edge alignment and Popup/Side Panel control styling:

![Reader UI Mockup V2](/Users/bez/.gemini/antigravity/brain/f1bb620a-983a-4c53-bd5c-ad39b981bb9a/reader_ui_mockup_v2_1785345922433.jpg)

---

## 3. Detailed Technical Specifications

### 3.1 Equal Width Layout Alignment
- Container: `.document-reader` set to `width: min(920px, calc(100% - 48px)); margin: 0 auto;`.
- Toolbar (`.document-reader-toolbar`) and Article Card (`.document-reader-content`) set to `width: 100%; max-width: none;`.
- Both elements align perfectly on left and right outer borders.

### 3.2 Unified Control Styling (Sharing Popup/Side-Panel Design Tokens)
- **Primary Play/Pause Button**: Matches `.btn-primary` / `.btn-playpause` gradient styling (`var(--gradient-brand)`), smooth hover glow and transition.
- **Secondary Stop / Action Buttons**: Matches `.btn-secondary` (`background: rgba(255, 255, 255, 0.06); border: 1px solid var(--border-glass)`).
- **Voice Select Dropdown**: Uses `.form-select` (`background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 10px; font-size: 13px;`).
- **Control Labels**: Uses `.form-label` style (`font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; color: var(--color-text-secondary);`).
- **Speed Slider & Output**: Uses `.form-slider` styling with teal accent (`#099fb5`) and thumb glow. Inline header contains uppercase label `SPEED` and `.slider-value` `{speed}×`.
- **Progress Bar & Status**: Uses `.progress-bar-container` and `.progress-bar` consistent with popup playback progress.

### 3.3 Article Content & Typography
- Clean consecutive duplicate newlines (`replace(/\n{3,}/g, '\n\n')`).
- Padding: `padding: clamp(28px, 4.5vw, 56px);`.
- Font: `font-size: clamp(17px, 1.8vw, 20px); line-height: 1.75; color: #e4e4e7;`.
- Border and glass styling matching `.app-main` from Popup/Sidepanel (`background: rgba(18, 18, 24, 0.72); border: 1px solid var(--border-glass); border-radius: 16px;`).

---

## 4. Implementation Steps
1. Update `docs/specs/2026-07-30-reader-ui-alignment-design.md` (this file).
2. Create implementation plan in `docs/plans/2026-07-30-reader-ui-alignment-plan.md`.
3. Update `src/reader/App.tsx` and `src/reader/reader.css`.
4. Run `pnpm test:unit` and `pnpm build` to verify build and test clean status.
