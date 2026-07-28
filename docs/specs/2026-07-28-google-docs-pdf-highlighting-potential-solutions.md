# Google Docs and PDF Highlighting Potential Solutions

**Date:** 2026-07-28

**Status:** Research note; extension-owned text surface selected for the first implementation

**Purpose:** Preserve currently known options for adding Google Docs or PDF Readable Surface Adapters after the Readable Surface architecture refactor. This note intentionally separates platform exploration from approved implementation scope.

## Relationship to Existing Specs

The current Google Docs and PDF reading specs remain authoritative for shipped behavior:

- Google Docs reads from the plain-text export and does not scrape editor canvas or iframes.
- PDF reads through background-owned PDF.js extraction and does not replace Chrome's viewer.
- Neither source has a Readable Surface Adapter today.

This note reopens technical feasibility only. It does not silently expand those approved scopes or turn a potential solution into planned work.

The approved first implementation is now defined by [Full Document Reader Design](./2026-07-28-document-reader-design.md): one extension-owned Clean Reader for Google Docs and PDF. The source-view projection options below remain research-only and out of that implementation scope.

## Architectural Constraint

Google Docs and PDF are already Content Sources. A future solution should add a Readable Surface Adapter rather than place visual projection inside the extractor.

The shared path remains:

```text
Content Source
    -> Article / PlaybackContent
    -> normalizer + speech units + word map + timing
    -> optional Readable Surface Adapter
```

A source can support more than one surface:

- Google Docs export could be shown in an extension-owned text reader or projected into the source canvas.
- A PDF could be shown in a text reader, a custom PDF.js viewer, or—if proven reliable—partially targeted in Chrome's viewer.

No future solution should require normalizer or playback branches per Content Source.

## Common Requirements

Any candidate must demonstrate:

- deterministic mapping from source-equivalent word indexes to a visible range;
- monotonic repeated-word handling;
- correct Unicode normalization without corrupting source offsets;
- owner-scoped initialization, updates, clear, and stale-session rejection;
- fail-open audio when projection is unavailable;
- memory-only document text and mapping data;
- no document mutation;
- an explicit permission and privacy review before adding capabilities;
- real runtime verification rather than only mocked event tests.

## Google Docs

Google Docs uses canvas-based rendering rather than stable article DOM. Google documents that extensions depending on the previous HTML rendering may break, while accessibility support remains available. Chromium's Reading Mode contains special Google Docs handling based on annotated canvas/accessibility information, proving that a text-to-visual mapping can exist, but not that it is a stable public Interface for arbitrary extensions.

References:

- [Google Workspace canvas-based rendering update](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html)
- [Google Docs screen reader support](https://support.google.com/docs/answer/6282736?hl=en)
- [Chromium Read Anything Google Docs model](https://chromium.googlesource.com/chromium/src/+/75888a16150a7a6d6a6fa0e9abc7ce39ad0c5fd8/chrome/renderer/accessibility/read_anything/read_anything_app_model.h)
- [Chromium Reading Mode Google Docs helper](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/resources/accessibility/reading_mode_gdocs_helper/content.ts)

### Option G1: Extension-Owned Text Surface

**Feasibility:** High

Use the existing plain-text export as the Content Source and display that text in a Readit-owned reader surface, likely in the Side Panel. Add a new Adapter that maps the shared word timeline to string offsets, reusing the Manual Reader's proven projection semantics.

**Advantages**

- Uses existing permissions and extraction.
- Stable, testable text representation.
- Exact word projection and scrolling are under Readit's control.
- Does not depend on Google Docs canvas internals.

**Costs**

- Does not highlight inside the source document.
- Requires product decisions for document layout, switching between current-page controls and reader text, and whether the reader is ephemeral.

**Required spike**

- Prove that exported paragraphs can retain stable source-equivalent offsets through normalization.
- Prototype long-document rendering and auto-scroll performance.

### Option G2: Annotated Canvas Adapter

**Feasibility:** Medium technically; uncertain availability

Investigate Google Docs canvas annotation data from an all-frame or main-world helper, then project the active word into the source page.

Chromium has internal helpers for Google Docs and evidence of an extension-ID annotation hook. Public developer reports indicate that this path may depend on allowlisting and may not behave consistently for arbitrary extension IDs.

References:

- [Chromium Google Docs helper manifest](https://chromium.googlesource.com/chromium/src/out/+/f24e065103cc61facd35c2006c69e93ca5a6a232/mac-Debug/resources/accessibility/reading_mode_gdocs_helper_manifest.json)
- [Chromium annotation hook change](https://chromium.googlesource.com/chromium/src.git/+/e10543e7eb88e08605bc727186e2afb5db6717c0%5E%21/)
- [Chromium Extensions discussion](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/OP03CIUfews)

**Advantages**

- Preserves source-document context.
- Could support source scrolling and accurate visual following.

**Risks**

- The required Interface may be internal or allowlisted.
- Google can change canvas annotations without extension compatibility guarantees.
- All-frame/main-world injection increases maintenance and security review.

**Go/no-go spike**

1. Use the production extension ID or a documented equivalent.
2. Confirm annotation access on view-only and editable documents.
3. Map at least repeated words, multiple paragraphs, and off-screen text.
4. Verify that no menus, comments, suggestions, or toolbars enter the text order.
5. Stop if the solution requires undocumented allowlisting that Readit cannot obtain.

### Option G3: Accessibility Tree Through Debugger

**Feasibility:** Technically possible; not recommended

`chrome.debugger` can access Chrome DevTools Protocol Accessibility and Overlay domains. `Accessibility.getFullAXTree` remains experimental and enabling accessibility domains may affect performance.

References:

- [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome permission warnings](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- [Chrome DevTools Protocol Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)

**Reasons not to pursue by default**

- Strong debugger and broad data-access warnings.
- Poor fit with the Free extension's local/privacy posture and install UX.
- Higher lifecycle and performance risk than an extension-owned surface.

Revisit only if Chrome exposes a narrower public accessibility Interface.

## PDF

Chrome's built-in PDF viewer uses protected extension/plugin frames that ordinary content scripts cannot inspect as a normal page DOM. The current PDF Content Source therefore correctly fetches bytes and extracts text in background with bundled PDF.js.

References:

- [Chromium content-script PDF frame tests](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/content_script_apitest.cc)
- [PDF.js getting started](https://mozilla.github.io/pdf.js/getting_started/)

### Option P1: Extension-Owned Text Surface

**Feasibility:** High

Display extracted PDF text in a Readit-owned Side Panel reader and use string-offset projection.

**Advantages**

- Smallest extension of the Manual Reader Adapter.
- No Chrome PDF Viewer integration.
- Stable source-equivalent text and straightforward automated tests.

**Costs**

- Loses page geometry, columns, figures, and source layout.
- Needs clear page-break rendering and navigation for long PDFs.

**Required spike**

- Measure large-document memory and render cost.
- Prove page-break and paragraph mapping remains stable through playback preparation.

### Option P2: Custom PDF.js Viewer

**Feasibility:** High; larger product scope

Render PDF pages in an extension-owned viewer using PDF.js display and text layers. The Adapter maps playback words to text-layer spans or PDF text-item geometry.

The current extractor already receives `transform`, `width`, and `height` for text items. A future Content Source result could retain stable page/text-item anchors without exposing PDF.js details to normalizer or playback.

**Advantages**

- Preserves page layout and source context.
- Readit controls text layer, scrolling, selection, and rendering.
- Can provide precise word projection when the PDF text layer is well formed.

**Costs**

- Replaces or supplements Chrome's viewer.
- Significantly larger UI, accessibility, performance, security, and test scope.
- Requires decisions for password errors, downloads, printing, links, zoom, and page virtualization.

**Go/no-go spike**

1. Render a representative single-column and multi-column PDF.
2. Map repeated words to correct page/text-item ranges.
3. Verify zoom, page virtualization, and auto-scroll.
4. Measure memory for long documents.
5. Prove that extraction and rendering share stable anchors without retaining duplicate full-document structures unnecessarily.

### Option P3: Chrome PDF Text Fragments

**Feasibility:** Low to medium; spike only

Chromium's PDF viewer parses text-fragment directives and contains an internal highlight path. A URL such as `#:~:text=...` may target static text, but the live experiment performed during this research did not visibly confirm highlighting in the tested browser.

References:

- [Chromium PDF open-parameter parser](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/resources/pdf/open_pdf_params_parser.ts)
- [Chromium PDF viewer](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/resources/pdf/pdf_viewer.ts)

**Potential use**

- Reveal a sentence or paragraph when playback starts.

**Why it is unlikely to support word-follow playback**

- Updating the fragment per word may change navigation history, focus, or scroll.
- Text-fragment matching may be ambiguous for repeated words.
- Readit cannot directly manage the viewer's internal highlighted range.
- Browser-version behavior is not yet proven.

Do not adopt unless a focused spike demonstrates stable targeting, replacement, scrolling, and cleanup without navigation side effects.

### Option P4: Overlay or Debugger Projection

**Feasibility:** Low; not recommended

Attempt to derive PDF coordinates through accessibility/debugging and render an overlay above Chrome's viewer.

This combines strong permissions, protected viewer internals, zoom/scroll synchronization, and uncertain coordinate transforms. It offers less control than a custom PDF.js viewer while retaining similar complexity.

## Recommended Order

1. Complete the Readable Surface architecture refactor with Website DOM, Manual Reader, and None Adapters only.
2. If source fidelity is not required, evaluate one shared extension-owned document reader for both Google Docs and PDF.
3. If PDF source layout is a product requirement, spike a custom PDF.js viewer.
4. Independently spike Google Docs annotated canvas only to determine whether a stable public Interface is available.
5. Do not request debugger permissions or ship text-fragment playback without a separate product, privacy, and permission decision.

## Decision Record for Future Work

A future implementation proposal must answer:

- Is highlighting required in the source viewer, or is a Readit-owned surface acceptable?
- Which exact Content Sources use the new Adapter?
- What stable anchor crosses extraction, normalization, and projection?
- What happens when the source changes after playback starts?
- What permission or host access changes are required?
- How is content kept memory-only?
- Which real documents prove repeated-word, Unicode, long-document, scrolling, and lifecycle behavior?

Until those questions are resolved, Google Docs and PDF remain `readableSurface: 'none'`.
