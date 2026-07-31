# Specification: XenForo Article Extraction & Vietnamese Numeric TTS Normalization

**Date:** 2026-07-31  
**Status:** Approved / Implemented  
**Target Modules:** `src/content/article_extractor.ts`, `src/offscreen/vietnamese/normalizer.ts`, `src/offscreen/vietnamese/expanders.ts`

---

## 1. Problem Statement

Articles hosted on XenForo-based community sites (e.g. `tinhte.vn`) and custom CMS platforms present non-standard DOM structures that cause two major extraction and TTS playback defects:

1. **Fragmented Inline Spans & Direct Container Text:**
   - XenForo wraps post content in container `div` elements (e.g., `div.xfBody`) where prose is split into `span.xf-body-paragraph` elements or directly placed as raw text nodes.
   - List items (e.g., bulleted milestone list) are separated by `<br>` tags inside a single `span.xf-body-paragraph` rather than wrapped in standard `<ul>`/`<li>` elements.
   - Strict block-only selectors missed direct text nodes or merged entire lists into monolithic blocks, destroying list pauses during TTS playback.

2. **TreeWalker Traversal Subtree Leaks:**
   - When a long inline or container element was the last child of its parent (`nextSibling` returned `null`), naive `walker.nextSibling() || walker.nextNode()` calls plunged the `TreeWalker` into the element's first child instead of skipping its subtree.
   - This caused duplicate extraction of descendant elements (e.g., repeating `"2,35–2,375 triệu xe/năm"` as a standalone block right after the parent paragraph).

3. **Noise Identity False Positives:**
   - Heading tags containing `id="menuid0"` matched the noise regex due to an unanchored `menu` keyword, causing main section headers to be discarded during content tree cleaning.
   - `<p class="in-article-promo-title">` advertisement banners were not matched by noise patterns and leaked `"Quảng cáo"` into the article text.

4. **Vietnamese Numeric Range & Rate Unit Pronunciation:**
   - Slanted slash expressions like `xe/ngày` and `xe/năm` were split by the tokenizer into isolated words and punctuation, causing awkward TTS output like `"xe ngày"` instead of `"xe trên ngày"`.
   - Range expressions like `2,35–2,375` (en-dash separator) were not recognized as ranges unless preceded by specific keywords, resulting in choppy digit-by-digit reading.

---

## 2. Technical Requirements & Design

### 2.1 DOM Article Extraction (`article_extractor.ts`)

- **Single-Pass TreeWalker with Guaranteed Subtree Skipping (`skipSubtree`):**
  - Implement a `skipSubtree(walker: TreeWalker)` helper that bubbles up to parent next-siblings when `nextSibling()` is `null`, ensuring an element's descendants are never re-visited after block extraction.
- **`<br>` Line-Break Segment Splitting (`extractBrBlocks`):**
  - Detect elements containing `<br>` tags and split their inner text nodes and inline formatting elements by `<br>` boundaries. Each segment is emitted as a separate text block so TTS pauses between items.
- **Adjacent Text Node & Short Formatting Inline Merging:**
  - For container elements (`div`, `section`, etc.), collect runs of direct text nodes and short inline formatting tags (`<b>`, `<a>`, `<i>`, `<strong>`, `<em>`) into unified paragraph blocks. Flush runs at `<br>` or structural element boundaries.
- **Refined Noise Identity Pattern:**
  - Update `NOISE_IDENTITY_PATTERN` to use negative lookaheads `menu(?!id)` so `id="menuid0"` headings are preserved while menu bars are filtered out.
  - Include `promo` to remove promotional titles (`in-article-promo-title`).

### 2.2 Vietnamese Preprocessing & Normalization (`normalizer.ts`, `expanders.ts`)

- **Rate Unit Preprocessing:**
  - Rewrite slash rate units `/(ngày|năm|giờ|tháng|tuần|quý)` $\rightarrow$ `" trên $1"` prior to tokenization.
- **Numeric Range Normalization:**
  - Rewrite en-dash decimal ranges `(\d[\d.,]*)–(\d[\d.,]*)` $\rightarrow$ `"$1 đến $2"`.
  - Expand `B-NRNG` context keywords to include `"vượt"`, `"đạt"`, `"khoảng"`, `"từ"`.

---

## 3. Verification & Compliance

- **Unit Tests:** `tests/unit/article_extractor.test.ts` covers XenForo `<br>` list splitting, `skipSubtree` duplicate prevention, short formatting tag merging, and heading identity preservation (`396/396` unit tests passing).
- **Code Quality:** Fully compliant with checked-in Biome configuration (`biome check .` passing with 0 errors).
