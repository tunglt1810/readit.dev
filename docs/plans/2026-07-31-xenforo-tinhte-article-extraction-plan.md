# Implementation Plan: XenForo Extraction & Vietnamese TTS Normalization

**Date:** 2026-07-31  
**Status:** Completed & Verified  
**Target Files:**
- `src/content/article_extractor.ts`
- `src/offscreen/vietnamese/normalizer.ts`
- `src/offscreen/vietnamese/expanders.ts`
- `tests/unit/article_extractor.test.ts`
- `tests/unit/vietnamese_normalizer.test.ts`

---

## Proposed Changes & Tasks

### 1. Extractor Refactoring (`src/content/article_extractor.ts`)

#### Task 1.1: Implement `skipSubtree` for TreeWalker
- **Goal:** Prevent TreeWalker from diving into children when an extracted element has no immediate next sibling (`nextSibling === null`).
- **Implementation:** Create `skipSubtree(walker: TreeWalker)` helper to bubble up parent nodes until a valid `nextSibling` is found.

#### Task 1.2: Add `<br>` Segment Splitting (`extractBrBlocks`)
- **Goal:** Treat `<br>` separators within inline elements (e.g. `span.xf-body-paragraph`) as paragraph boundaries so list items are read with natural pauses.
- **Implementation:** Iterate child nodes of elements with `<br>`, group text by `<br>` markers, and push each segment as a distinct block.

#### Task 1.3: Merge Direct Text Runs in Container Elements
- **Goal:** Collect direct text node children and short inline tags (e.g., `<b>18 năm 5 tháng</b>`, `<b>4.800 xe/ngày</b>`) in container elements into unified paragraph blocks.
- **Implementation:** Maintain a text buffer `run` during child iteration; flush `run` at `<br>` or structural element boundaries.

#### Task 1.4: Refine Noise Pattern Filters
- **Goal:** Eliminate false positives on `id="menuid0"` headings while filtering out promotional banners (`in-article-promo-title`).
- **Implementation:** Update `NOISE_IDENTITY_PATTERN` with negative lookahead `menu(?!id)` and `promo` keyword.

---

### 2. Vietnamese TTS Text Normalization (`src/offscreen/vietnamese/normalizer.ts`, `expanders.ts`)

#### Task 2.1: Preprocess Rate Unit Slashes
- **Goal:** Convert expressions like `xe/ngày` and `xe/năm` to readable Vietnamese (`"xe trên ngày"`, `"xe trên năm"`).
- **Implementation:** Add `preprocessRateUnits` pass before tokenization using regex replacement `/\/(ngày|năm|giờ|tháng|tuần|quý)/gu` $\rightarrow$ `" trên $1"`.

#### Task 2.2: Expand Range Normalization
- **Goal:** Normalize numeric ranges using en-dash (e.g., `2,35–2,375`) to `"2,35 đến 2,375"`.
- **Implementation:** Add en-dash regex substitution `(\d[\d.,]*)–(\d[\d.,]*)` $\rightarrow$ `"$1 đến $2"` and add `"vượt"`, `"đạt"` to `B-NRNG` context rules.

---

### 3. Automated Unit Testing & Verification

#### Task 3.1: Unit Test Suite for Extractor (`tests/unit/article_extractor.test.ts`)
- Add tests covering XenForo `<br>` list splitting, duplicate prevention via `skipSubtree`, short formatting tag merging, and heading preservation.

#### Task 3.2: Unit Tests for Normalizer (`tests/unit/vietnamese_normalizer.test.ts`)
- Add test case verifying normalization of `xe/ngày`, `xe/năm`, and `2,35–2,375`.

---

## Verification Plan

### Automated Tests
- Run full unit test suite: `node --experimental-strip-types --test tests/unit/*.test.ts` (396 tests passing).
- Run Biome lint & format check: `pnpm lint` (0 errors).

### Manual Verification
- Execute live DOM extraction evaluation against `tinhte.vn` article via Chrome DevTools MCP.
- Confirm all 10 bullet points, prose paragraphs, headings, and numerical range pronunciations are correctly extracted without duplicate blocks.
