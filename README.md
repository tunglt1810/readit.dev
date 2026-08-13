# readit.dev

`readit.dev` is a free Chrome extension that reads the current web page aloud with on-device Text-to-Speech (TTS). The current extension release uses the local Supertonic WASM/WebGPU engine; the backend folder is reserved for future Pro features and is not used by the Free release.

## Features

**What it reads**

| Source | Where it is started from |
| --- | --- |
| The current web page | Popup or Side Panel — a keyboard shortcut opens either with the read button already focused |
| Selected text | Floating button on selection, or the context menu |
| Pasted text | Side Panel's Manual Reader |
| Google Docs | Popup or Side Panel, via the document's plain-text export |
| PDF | A PDF open in a tab, or a file picked from disk |
| EPUB | A file picked from disk, in the Document Reader |

**While reading**

- **Word-level highlighting** synchronized with speech, projected into whichever surface owns the text — the page itself, the Side Panel, or the Document Reader — with the active word kept centered and auto-scroll paused while the reader scrolls by hand.
- **Chapter navigation** for EPUB books: chapters chain automatically as each finishes, previous/next steps through them, and the position is restored on the next visit. Chapters are numbered from the book's own table of contents, not from raw spine files.
- **Playback controls**: play/pause/stop, reading speed, and a choice of voice styles.
- **Playlist queue** to line up several pages and play them in order.
- **System media controls** through the MediaSession API, so hardware and OS keys work.

**Beyond playback**

- **MP3 export** of a reading session.
- **Custom pronunciation dictionary** for words the engine gets wrong.
- **Classic themes** alongside the default one: Winamp and Windows Media Player 12.
- **English and Vietnamese** interface, with Vietnamese text normalization and segmentation tuned for TTS.

Speech synthesis and text processing run entirely on the user's device. Nothing read aloud is sent to a server.

## Technology

- **Frontend (Chrome Extension)**: React 19, TypeScript 6, Rsbuild, and Supertonic TTS running through ONNX Runtime Web.
- **Future Pro backend**: Hono, Cloudflare Workers, and Cloudflare D1 (SQLite at the edge).

## How it works

```mermaid
flowchart TD
	A["Popup<br/>Quick controls"] -->|Open| C["Side Panel<br/>Current page or pasted text"]
	A -->|Current page and controls| B["Background service worker<br/>Coordinate one playback session"]
	C -->|Current page, manual text, and controls| B
	D["Selection button or context menu<br/>Selected text"] --> B
	B -->|Request website, selection, or Google Docs content| E["Content script<br/>Extract Article and project website highlights"]
	E -->|Article + website-dom or none| B
	B -->|Extract tab PDF| P["Background PDF.js extractor<br/>Article + none"]
	P --> B
	R["Document Reader page<br/>Local EPUB/PDF picker, full-text view"] -->|Chapter or document content| B
	B -->|Content + Readable Surface kind| F["Offscreen document<br/>Normalize and segment local text"]
	F --> G["Supertonic TTS<br/>Local synthesis and audio playback"]
	G --> H["Audio output"]
	F -. Playback progress and canonical Readable Surface events .-> B
	B -. website-dom projection .-> E
	B -. manual-reader projection .-> C
	B -. document-reader projection .-> R
	B -. Session state .-> A
	B -. Session state .-> C
	B -. Badge state .-> I["Toolbar badge"]
```

Successful extraction returns both an Article and an explicit Readable Surface capability. Every Playback Session stores one of four
surface kinds:

- `website-dom` projects spoken-word updates into the source page through the content script.
- `manual-reader` projects updates into the Side Panel's locked pasted-text reader.
- `document-reader` projects updates into the Document Reader page, which renders the text it was given — a Google Docs export, a PDF, or one EPUB chapter — and pulls its own snapshot rather than receiving the words up front.
- `none` keeps playback text-only when no open surface can show the source.

The offscreen document emits one canonical initialize/update/clear protocol. The background Readable Surface coordinator validates events
against the active session, coalesces website updates, and routes them to the matching surface without coupling speech synthesis to a
specific UI.

The Free extension keeps Article and pasted-text processing and speech synthesis on the user's device. Pasted text passes only between
extension contexts for playback and is never written to extension storage.

### Extension contexts

| Directory | Runs as | Responsibility |
| --- | --- | --- |
| `src/background/` | MV3 service worker | Owns the single Playback Session, serializes commands through one lane, and routes Readable Surface events. |
| `src/offscreen/` | Offscreen document | Normalizes and segments text, runs Supertonic synthesis, plays audio, and reports progress. |
| `src/content/` | Content script | Extracts an Article from the page and projects word highlights back into it. |
| `src/popup/` | Toolbar popup | Quick controls and session state. |
| `src/sidepanel/` | Side Panel | Current-page controls plus the Manual Reader for pasted text. |
| `src/reader/` | Extension page | Document Reader: opens local EPUB/PDF files and renders the text being read. |
| `src/settings/` | Extension page | Voice, theme, and pronunciation dictionary settings. |
| `src/shared/` | Imported everywhere | Types, constants, i18n, theming, and the protocols the contexts agree on. |

Only the background worker mutates session state; every other context asks it to. Synthesis lives only in the offscreen document, because
an MV3 service worker cannot keep audio alive.

## Domain language

| Term | Meaning |
| --- | --- |
| **Article** | Titled text extracted from a tab for current-page or selected-text playback. |
| **Content Source** | Origin from which readable text is obtained: website, Google Docs export, PDF, EPUB, selection, or manual input. |
| **Readable Surface** | User-visible text that can project the current spoken position, or explicitly has no projection. |
| **Playback Session** | Single active reading lifecycle that owns content, progress, voice settings, and its Readable Surface. |
| **Manual Reader** | Side Panel text area that owns pasted-text playback independently of tab lifecycle. |

A website Article or selection uses the page DOM as its Readable Surface. The Manual Reader is both a Content Source and a Readable
Surface. Google Docs, PDF, and EPUB have no source view of their own, so they are rendered in the Document Reader, which becomes their
Readable Surface. Use **Content Source** for extraction origin; use Playback Session ownership for runtime lifecycle.

## Quick start

This monorepo uses `pnpm v11`.

```bash
pnpm install
```

## Local development

### Extension

```bash
pnpm dev
```

After the build completes:

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's `dist/chrome/` directory.

### Backend

```bash
pnpm --filter readit-backend dev
```

This starts the local Cloudflare Worker with the local D1 database configuration.

## Build and deployment commands

- **Build the extension**: `pnpm build`
- **Run unit tests**: `pnpm test:unit`
- **Run end-to-end tests**: `pnpm test:e2e`
- **Deploy the backend**: `pnpm --filter readit-backend deploy`

## Documentation

- [Product Requirements Document](./docs/PRD.md)
- [Free MVP Design Specification](./docs/specs/2026-07-12-free-mvp-design.md)
- [Readable Surface Architecture](./docs/specs/2026-07-28-readable-surface-architecture-design.md)
- [Document Reader Design](./docs/specs/2026-07-28-document-reader-design.md)
- [EPUB Reading & Local Book Loading](./docs/specs/2026-08-12-epub-reading-design.md)
- [Deployment Guide](./docs/DEPLOYMENT.md)
- [Release Guide](./docs/RELEASING.md)
- [Architecture Decision Record](./docs/adr)
- [Privacy Policy](https://tunglt1810.github.io/readit.dev/privacy-policy/)
- [Third-Party Notices](./public/THIRD_PARTY_NOTICES.txt)

## License

This project is licensed under the GNU Affero General Public License v3.0 or later. See [LICENSE](./LICENSE) for the complete terms.
