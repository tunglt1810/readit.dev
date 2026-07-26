# PDF Layout Boundary Implementation Plan

**Goal:** Preserve heading-to-body pauses in text-layer PDFs while joining body line-wraps.

1. Add a PDF extractor unit test whose PDF.js text items model `Executive Summary` (16pt) followed by four 11pt body lines. Assert one blank-line boundary after the heading and spaces across body lines.
2. Run the focused test and confirm it fails because the extractor currently only uses `hasEOL`.
3. Extend the PDF text-item seam with layout fields. Group same-baseline items, join lines, and emit a blank-line boundary only for the specified heading/font/gap signal; preserve the existing fallback for items without layout fields.
4. Run the PDF extractor tests, build, manifest validation, and `git diff --check`.
