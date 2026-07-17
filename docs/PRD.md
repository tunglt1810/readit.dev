# readit.dev Product Requirements

## Free MVP

The current product is a free Chrome extension that reads the readable article
from the active tab aloud with Supertonic 3 running locally in the browser.

The canonical product and technical requirements are maintained in:

- [Free MVP Design Specification](./superpowers/specs/2026-07-12-free-mvp-design.md)
- [Privacy Policy](./privacy-policy.md)
- [Release Guide](./RELEASING.md)
- [Third-Party Notices](../public/THIRD_PARTY_NOTICES.txt)

### User value

readit.dev removes the need to keep reading a long article on screen while
preserving a privacy-first local processing model. The extension extracts the
current article with Mozilla Readability and synthesizes audio with the local
Supertonic 3 runtime.

### Free MVP requirements

- Read the current page through Mozilla Readability.
- Run TTS locally with WebGPU first and WASM fallback.
- Support automatic EN/VI/ZH article-language handling with documented
  fallback behavior.
- Provide ten voice styles (`M1`–`M5`, `F1`–`F5`).
- Provide play, pause, resume, stop, progress, and `0.70x`–`1.80x` speed.
- Provide an English/Vietnamese localized popup with browser-locale default and
  a persisted manual selector.
- Show a clear localized error when the page is not readable.
- Send no article content, audio, analytics, or crash reports to a remote
  service.

### Explicitly future

The following are not part of the Free MVP: accounts, licensing, Pro UI,
`api.readit.dev`, backend deployment, translation, cloud TTS, summaries,
highlighting, learning tools, synchronization, and Firefox support.

The `backend/` directory may remain in the repository as future-Pro source, but
it is not part of the Free runtime or extension release package.
