# PDF Layout Boundary Design

**Status:** Approved for a focused main-branch experiment

## Goal

Recover the semantic boundary between a large PDF heading and its following body paragraph without treating ordinary body line-wraps as pauses.

## Scope

For text-layer PDF.js `TextItem`s, retain text position and height while extracting a page. Group neighbouring items on the same baseline into a physical line. Join ordinary adjacent body lines with one space. Insert a paragraph boundary only when the preceding line is at least 25% taller than the next line and its baseline gap is at least 125% of the next line height.

The supplied page-two example must become `Executive Summary\n\nThis system card ... reasoning.`. The existing speech planner then gives the heading its 260 ms paragraph pause and retains normal sentence pauses in the body.

## Non-goals

- Do not infer arbitrary PDF reading order, columns, tables, lists, or OCR text.
- Do not turn every visual line change into a paragraph boundary.
- Do not modify TTS, UI, permissions, or persistence.
