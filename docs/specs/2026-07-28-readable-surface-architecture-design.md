# Readable Surface Architecture Refactor

**Date:** 2026-07-28

**Status:** Approved design; implementation pending

**Scope:** Deepen the Readable Surface Module around the two visual projection Implementations that already exist: Website DOM highlighting and Side Panel manual-text highlighting. Google Docs and PDF highlighters remain unimplemented.

## Summary

Content extraction and spoken-position projection are independent concerns:

- a **Content Source** obtains readable text;
- a **Readable Surface** projects the current spoken position into user-visible text.

The current code does not represent that distinction. `contentScope: 'article'` implicitly means "send Website DOM highlight messages to the owning tab." Consequently, Google Docs export and PDF playback enter the Website DOM highlight path even though neither has a compatible Readable Surface. Those attempts fail open, so audio works, but surface availability is accidental rather than explicit.

This refactor introduces an explicit Readable Surface value on extraction results and Playback Sessions, plus a deep background Module that owns projection lifecycle and routing. Its two current Adapters preserve the existing Website DOM and Manual Reader Implementations. A `none` value makes Google Docs, PDF, error sessions, and any future text-only source explicitly non-visual.

Normalizer, word map, speech-unit preparation, timing, playback, extraction order, and the existing visual Implementations remain unchanged.

## Goals

- Represent Content Source and Readable Surface independently.
- Make surface availability explicit before playback starts.
- Concentrate initialization, session validation, update routing, clear lifecycle, and fail-open behavior in one Module.
- Preserve Website DOM highlight behavior, including exact selected ranges, visibility handling, scrolling, and the webpage highlight setting.
- Preserve Manual Reader highlighting, including monotonic matching, owner scoping, and independence from the webpage highlight setting.
- Stop producing or routing visual projection work for Google Docs and PDF playback.
- Keep the Interface small enough to support the two current Adapters without introducing a registry or dynamic plugin system.

## Out of Scope

- Google Docs or PDF highlighting.
- An extension-owned Google Docs or PDF reader surface.
- A custom PDF.js viewer, Google Docs canvas integration, text fragments, overlays, accessibility-tree projection, OAuth, or new permissions.
- Refactoring Content Source selection order or extraction failure precedence.
- Changing `Article`, normalizer, word-map construction, speech units, word timing, audio playback, or UI styling.
- Dynamic Adapter discovery, registration, versioning, configuration, or plugin manifests.

Potential Google Docs and PDF approaches are recorded separately in [Google Docs and PDF Highlighting Potential Solutions](./2026-07-28-google-docs-pdf-highlighting-potential-solutions.md).

## Existing Architecture and Friction

### Content Sources

- Website DOM: `src/content/article_extractor.ts` returns an `Article`.
- Google Docs: `src/content/google_docs_extractor.ts` fetches a plain-text export and returns an `Article`.
- PDF: `src/background/pdf_extractor.ts` uses PDF.js and returns an `Article`.
- Selection: `src/background/selected_text.ts` creates an `Article`.
- Manual input: `src/background/manual_text.ts` creates `PlaybackContent`.

All successful paths converge at `startPlayback()` and the shared offscreen playback preparation Module. That Module is already deep: callers provide text and language; its Implementation owns normalization, segmentation, and word maps without knowing the Content Source.

### Readable Surfaces

- Website DOM: `src/content/word_highlight.ts` precomputes DOM `Range` values and renders through the CSS Custom Highlight Interface.
- Manual Reader: `src/sidepanel/manual_word_highlight.ts` maps spoken words to string offsets, and `src/sidepanel/App.tsx` renders the range.

Projection routing is spread across offscreen, background, content script, and Side Panel:

- offscreen distinguishes manual playback from generic article/selection playback;
- background owns two unrelated relay paths and generic initialization state;
- Website and Manual Reader consume different event shapes;
- `contentScope` and `source.kind` are used as proxies for surface capability.

The result is low Locality. Changing lifecycle semantics requires coordinated edits across runtime realms, and tests must know which relay happens to carry which event.

### Deletion Test

If the proposed Module were deleted, Adapter selection, initialization readiness, session ownership, stale-event rejection, update delivery, clear ordering, coalescing policy, and fail-open behavior would reappear across background message handlers and offscreen conditionals. The Module therefore earns Depth: a small lifecycle Interface hides behavior that would otherwise be duplicated across multiple callers.

## Domain Model

### Readable Surface Kind

Add a shared discriminant:

```ts
export type ReadableSurfaceKind = 'website-dom' | 'manual-reader' | 'none';
```

The value describes projection capability, not extraction origin:

| Content Source | Readable Surface today |
| --- | --- |
| Website article | `website-dom` |
| Website selection | `website-dom` |
| Google Docs export | `none` |
| PDF | `none` |
| Manual input | `manual-reader` |
| Extraction error session | `none` |

This is intentionally a closed union, not a registry. A future Google Docs or PDF implementation must add a proven Adapter and extend the union deliberately.

### Extraction Envelope

`Article` remains pure readable content. Successful current-page extraction returns an envelope containing:

```ts
type ExtractedArticle = {
    article: Article;
    readableSurface: Extract<ReadableSurfaceKind, 'website-dom' | 'none'>;
};
```

- Website extraction returns `website-dom`.
- Google Docs export returns `none`.
- PDF extraction returns `none`.
- Failure responses do not invent a surface.

The envelope prevents projection concerns from leaking into `Article` and avoids requiring a Content Source registry in this refactor.

### Playback Session

Every `PlaybackSessionSnapshot` gains `readableSurface: ReadableSurfaceKind`.

The session constructor enforces the valid combinations used today:

- tab-owned article or selection: `website-dom` or `none`;
- manual playback: `manual-reader`;
- error session: `none`.

The value is stored in `chrome.storage.session`, so background worker hydration restores routing knowledge without URL inference. Snapshots without a valid value are rejected using the existing malformed-session behavior.

## Readable Surface Module

Add `src/background/readable_surface.ts`. This Module owns the surface lifecycle for the active Playback Session.

### Interface

The background coordinator uses four operations:

```ts
activate(session: PlaybackSessionSnapshot): void;
initialize(message: ReadableSurfaceInitMessage): Promise<{ success: boolean }>;
advance(message: ReadableSurfaceUpdateMessage): void;
clear(sessionId: string): Promise<void>;
```

The full Interface also includes these invariants:

- only the active session may initialize, advance, or clear;
- updates are ignored until the active Adapter is ready;
- initialization or delivery failure never stops audio;
- activation of a replacement session discards prior readiness and queued updates;
- clear is owner-scoped and idempotent;
- `none` performs no projection work and does not send runtime messages.

The Module selects an internal Adapter from `session.readableSurface`. Callers do not branch on surface kind.

### Canonical Offscreen Events

Replace the separate generic and manual offscreen event families with a canonical projection protocol:

```ts
type ReadableSurfaceInitMessage = {
    action: 'READABLE_SURFACE_INIT';
    sessionId: string;
    contentScope: PlaybackContentScope;
    words: readonly WordHighlightWord[];
};

type ReadableSurfaceUpdateMessage = {
    action: 'READABLE_SURFACE_UPDATE';
    sessionId: string;
    wordIndex: number;
    word: string;
};

type ReadableSurfaceClearMessage = {
    action: 'READABLE_SURFACE_CLEAR';
    sessionId: string;
};
```

Offscreen builds the global word list only when the PLAY command carries a surface other than `none`. Word timing sends both stable global index and source-equivalent word text; each Adapter uses only what its Implementation requires.

The background Module translates canonical events into the existing realm-specific messages. Website and Side Panel visual Implementations therefore do not need to share DOM/string projection logic.

## Adapters

### Website DOM Adapter

The Website DOM Adapter:

- requires a tab-owned session with `website-dom`;
- forwards initialization to the owning tab using the existing word-list and content-scope contract;
- becomes ready only after the content script acknowledges initialization;
- sends index updates through the existing update coalescer;
- clears the owning tab on stop, replacement, navigation, failure, or canonical clear;
- preserves the webpage `WORD_HIGHLIGHT_ENABLED` setting.

`src/content/word_highlight.ts` remains the visual Implementation. Exact selection `Range` ownership, precomputation, word matching, visibility handling, and scrolling stay local to it.

### Manual Reader Adapter

The Manual Reader Adapter:

- requires a manual session owned by a valid `panelInstanceId`;
- is ready after activation because the Side Panel already owns the reader text and cursor;
- broadcasts every distinct canonical word update without Website coalescing;
- translates the update to the existing Side Panel event shape;
- emits an owner-scoped clear event when the session stops or is replaced;
- remains independent of the webpage highlight setting.

`src/sidepanel/manual_word_highlight.ts` remains the visual Implementation. Unicode variants, monotonic cursor behavior, and string-offset rendering stay local to it.

### None Adapter

`none` is an explicit no-op Adapter:

- initialization returns unsuccessful or is skipped;
- updates and clear produce no messages;
- audio preparation and playback continue normally.

This Adapter removes exception-driven capability detection for Google Docs and PDF without adding their future highlighters.

## Data Flow

### Website Article

1. Website extraction returns `{ article, readableSurface: 'website-dom' }`.
2. Background creates and persists the Playback Session.
3. The Readable Surface Module activates the Website DOM Adapter.
4. Offscreen prepares speech units and sends canonical initialization.
5. The Adapter initializes DOM ranges and acknowledges readiness.
6. Canonical word updates are coalesced and projected into the page.
7. Stop, replacement, navigation, or completion clears the same owner.

### Google Docs or PDF

1. Extraction returns `{ article, readableSurface: 'none' }`.
2. Background creates and persists the normal tab-owned Playback Session.
3. The Readable Surface Module activates the None Adapter.
4. Offscreen prepares and plays speech without building projection events.
5. Playback state, badge, controls, progress, and errors remain unchanged.

### Manual Reader

1. Manual input starts with `manual-reader`.
2. Background creates and persists the manual Playback Session.
3. The Readable Surface Module activates the Manual Reader Adapter.
4. Offscreen prepares speech and emits canonical word updates.
5. The Adapter relays each update to the owning Side Panel reader.
6. Stop, close, replacement, or checkpoint lifecycle clears the owner-scoped visual range.

## Failure and Concurrency Semantics

- Surface initialization failure is fail-open: audio continues and later updates are ignored.
- A stale session cannot initialize, update, or clear the active Adapter.
- Website updates retain coalescing to avoid flooding tab messaging.
- Manual updates are not coalesced because skipping intermediate words changes the visible reader progression.
- Adapter delivery errors are swallowed after readiness is invalidated where appropriate.
- A `none` surface never retries or probes for a visual target.
- Session replacement activates the replacement before stale events can claim readiness.
- Hydration activates the Adapter described by the persisted session; it never derives capability from the URL.

## File Map

| File | Planned change |
| --- | --- |
| `src/shared/types.ts` | Add `ReadableSurfaceKind` and persist it on Playback Session snapshots. |
| `src/shared/readable_surface.ts` | Define canonical projection messages, validators, and shared word shape. |
| `src/shared/word_highlight.ts` | Retain Website-specific downstream protocol and settings; reuse shared word shape. |
| `src/shared/manual_playback.ts` | Retain manual ownership/control messages; remove the offscreen-specific timing event after migration. |
| `src/content/content_script.ts` | Return the extraction envelope with `website-dom` or `none`. |
| `src/content/google_docs_extractor.ts` | Mark successful export content as `none` through the extraction envelope. |
| `src/background/article_request.ts` | Type the extraction envelope response. |
| `src/background/pdf_extractor.ts` | Return successful PDF content with `none`. |
| `src/background/readable_surface.ts` | Add the deep Module and its Website DOM, Manual Reader, and None Adapters. |
| `src/background/playback_state.ts` | Construct and validate surface-aware Playback Sessions. |
| `src/background/background.ts` | Activate the Module and delegate canonical projection events; remove inline relay state. |
| `src/background/offscreen_transport.ts` | Carry the explicit surface in PLAY payload typing. |
| `src/offscreen/offscreen.ts` | Produce canonical projection lifecycle events and skip projection for `none`. |
| `src/sidepanel/App.tsx` | Accept owner-scoped manual clear while preserving rendering behavior. |
| `tests/unit/readable_surface.test.ts` | Test Adapter selection, readiness, stale ownership, coalescing policy, clear, and fail-open behavior. |
| Existing unit/E2E tests | Update message names/envelopes while preserving behavioral assertions. |

## Testing

### Module Tests

- Website DOM activates only for the active tab session.
- Website initialization must succeed before updates are delivered.
- Website updates retain existing coalescing behavior.
- Manual Reader activates only for the owning panel instance.
- Manual updates preserve every distinct word and include source-equivalent text.
- None emits no initialization, update, or clear messages.
- Stale initialization, update, and clear events cannot affect a replacement session.
- Adapter failure leaves playback unaffected and disables further projection until replacement.

### State and Protocol Tests

- Playback Session construction and validation require a valid surface.
- Invalid source/surface combinations are rejected.
- Extraction responses preserve the expected Website, Google Docs, and PDF surface.
- Canonical messages reject missing session IDs, non-contiguous word lists, invalid indexes, and empty words.

### Behavioral Regressions

- Existing real Website playback highlights a spoken word.
- Selected-text playback remains inside the exact captured DOM `Range`.
- Website setting disables only Website DOM rendering.
- Manual Reader highlighting remains always on.
- Repeated words, NFC/NFD text, source-equivalent multi-token entries, and stale indexes retain existing behavior.
- Google Docs and PDF playback produce normal audio and no projection messages.
- Manual/web preemption, checkpoint, tab navigation, pause/resume, stop, and natural completion retain their current session semantics.

## Verification Sequence

Run sequentially:

1. focused protocol, playback-state, surface Module, Website highlight, and manual highlight unit tests;
2. `CI=true pnpm test:unit`;
3. `CI=true pnpm build`;
4. `CI=true pnpm validate:manifest`;
5. targeted Website highlight, Side Panel, Google Docs reader, PDF reader, and reading-state Playwright tests;
6. `CI=true pnpm test:e2e`;
7. `pnpm exec biome check` for changed source and test files;
8. `git diff --check`;
9. `graphify update .`.

## Acceptance Criteria

- Content Source and Readable Surface are represented independently.
- Every Playback Session has an explicit Readable Surface.
- Website DOM and Manual Reader are the only visual Adapters.
- Google Docs and PDF use `none` and never attempt visual projection.
- Existing Website and Manual Reader highlighting behavior remains unchanged.
- Surface failures never interrupt audio.
- Surface lifecycle knowledge is concentrated in the Readable Surface Module rather than spread across background message handlers and offscreen manual/generic branches.
- No future Google Docs/PDF highlighter, new permission, custom viewer, registry, or dynamic plugin mechanism is introduced.
