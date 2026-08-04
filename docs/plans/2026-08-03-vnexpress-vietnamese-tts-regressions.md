# VnExpress Vietnamese TTS Regressions Implementation Plan

> **Reconciled release-gate status:** The deterministic controller-speed, semicolon, Vietnamese normalizer, and short-segment remediation is complete with focused regression coverage. Browser and real-model acceptance is **not complete**. Tiny probe pages currently fail Readability, 1.5× captures do not observe the engine boundary or pre-padding samples, export reports `snapshot-unavailable`, and a prior build wrapper returned nonzero without useful diagnostics. A blocked probe, missing diagnostic, stale unpacked bundle, or partial observation is never acceptance evidence.

**Goal:** Preserve the controller-owned Vietnamese speed, contextual month normalization, and semicolon cadence while preventing short independently synthesized units from silently dropping in foreground playback or MP3 export.

**Authoritative reconciliation:** `.kiro/specs/short-segment-audio-dropout/bugfix.md`, `design.md`, and `tasks.md` define the finalized short-segment bug condition, deterministic remediation, and remaining acceptance gates. This document retains the VnExpress article cases as the real-model regression matrix.

**Tech stack:** TypeScript, Node test runner, ONNX Runtime Web, Playwright/CDP, pnpm, Chrome Manifest V3.

## Release Constraints

- `DEFAULT_SPEED = 1.05` remains the default. The controller-selected literal speed is the sole duration divisor; it has no Vietnamese, short-segment, scheduler, playback-rate, or export-only multiplier.
- A planned unit below `MIN_RELIABLE_SYNTHESIS_CHARACTERS = 20` non-whitespace Unicode code points must be consolidated with only a capacity-safe immediate neighbor before word-map attachment, or retained in source order when no such merge is possible.
- Canonical `SpeechUnit.text` is never synthetic. A punctuationless absorbed boundary may use `synthesisText` for rendering cadence only; maps, source order, export metadata, and estimates use canonical text.
- The effective rendering limit includes the space join and any synthesis-only cadence marker: 120 characters for resolved Korean/Japanese and 300 for every other language.
- A merged unit owns only the right-side final `pauseAfterMs`. Natural terminal punctuation is the sole interior cadence; otherwise use only a synthesis-only marker—never a duplicate explicit trailing pause.
- Empty, non-finite, or materially silent samples must fail **before** explicit pause zeros are padded in both foreground and export paths.
- Sentence interior splits retain their 60-character minimum. Eligible semicolon splits retain their 20-character minimum and 140 ms pause; colon pauses remain 90 ms. Protected URLs, emails, dates, times, versions, numeric values, and similar structured forms remain intact.
- Preserve contextual `NMON` normalization and standalone month/year expansion. Do not special-case authors or alter extraction, scheduling, prefetch, checkpoints, storage, public APIs, or UI behavior.
- Keep probes, profiles, capture files, raw samples, decoded MP3s, matrix JSON, and logs only under `.tmp/short-segment-audio-dropout/`. Do not commit temporary artifacts.

## Completed Deterministic Work

The following checkmarks record the focused deterministic evidence described in the finalized task plan. They do **not** certify a browser, export, or real-model acceptance result.

- [x] **1. Preserve controller-owned speed exactly once**
  - `TextToSpeech` divides raw model duration only by the literal controller speed. The former Vietnamese-only duration scale is removed; `AudioBufferSourceNode.playbackRate`, scheduler divisors, and export-only speed factors are not used.
  - Deterministic duration, controller, foreground-work, and export-estimate coverage includes literal `1.05`, literal `1.5`, and other accepted values. For both Vietnamese and English, raw `[21, 21]` becomes `[20, 20]` at `1.05` and `[14, 14]` at `1.5`; explicit pauses remain unchanged.
  - This preserves the documented VnExpress controller-speed repair, but it is not a real-engine speed trace.
  - _Requirements: 1.5, 2.7, 2.8, 3.5, 3.6_

- [x] **2. Preserve semicolon-specific planning and cadence**
  - Deterministic generic-segmentation and Latin-planner tests cover sentence minimum `60`, semicolon minimum `20`, semicolon `pauseAfterMs: 140`, colon `90 ms`, paragraph precedence, and protected URL punctuation.
  - Unabsorbed eligible semicolons remain one planned boundary with one 140 ms explicit pause. A short clause subsequently absorbed by short-segment consolidation retains natural punctuation as its one interior cadence rather than adding another tail pause.
  - _Requirements: 1.3, 2.4, 2.5, 3.2, 3.4_

- [x] **3. Preserve Vietnamese contextual NMON and standalone month/year behavior**
  - Existing deterministic normalizer coverage remains green: contextual `tháng 9/2025` avoids a duplicated generated `tháng` prefix, while standalone `7/2026` retains `tháng … năm …` expansion.
  - Consolidation occurs after normalization/planning and does not alter labels, overlays, CRF decisions, or original-to-spoken mappings.
  - _Requirements: 3.3, 3.6_

- [x] **4. Complete deterministic short-segment remediation**
  - Focused consolidation and preservation tests cover short first, middle, final, consecutive, punctuation-adjacent, protected-token-adjacent, isolated, and capacity-blocked cases. They verify Unicode non-whitespace counting, immediate-neighbor selection, exact canonical reconstruction/source order, and no independently synthesized mergeable short unit.
  - Consolidation occurs before Latin, Vietnamese-normalized, Vietnamese-fallback, and compatibility map attachment. Deterministic mapping tests verify canonical substrings and final unit-relative offsets.
  - Tests cover canonical/synthesis text separation, punctuationless synthesis-only cadence, natural punctuation retention, right-side terminal-pause ownership, protected-token preservation, and shared 120/300 rendering capacity including joins and synthesis-only markers.
  - Shared raw-waveform validation is covered before `createSpeechAudioBuffer` padding for foreground and export: valid voiced samples, empty samples, non-finite samples, all-zero samples, and voiced samples followed by pause zeros. A retained singleton or capacity-blocked unit either has voiced pre-padding samples or reaches the typed existing failure path; it cannot produce a successful silent buffer or MP3.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 3.1, 3.4, 3.7_

- [x] **5. Record deterministic regression evidence without overstating acceptance**
  - Focused green evidence covers short-segment consolidation/preservation, playback preparation, word maps, voiced audio, controller speed, segmentation/Latin semicolons, `supertonic_duration`, offscreen audio, export estimate/engine, and Vietnamese normalization.
  - The prior 1.05 three-semicolon browser observation is only partial: it recorded literal session speed, ordered starts, and two finite voiced foreground captures, but it also had an observed transition gap and does not close the VnExpress matrix.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_

## Remaining Browser and Real-Model Acceptance Work

- [ ] **6. Build Readability-valid fixture carriers for every VnExpress probe**
  - Keep these canonical targets unchanged: `Vũ Tuân`, `Mỹ tiến lùi đều khó`, `Những lựa chọn khó khăn`, `Vũ Hoàng (Theo Politico, AFP, Reuters)`, and the reported paragraph containing three semicolons.
  - Place each target in a deterministic, non-link-heavy semantic `article`/`main` carrier at its intended first, middle, final, or consecutive position. Each carrier must have at least 120 normalized characters and at least one qualifying extractable text block.
  - Assert the target span exists in both planned and prepared units; do not assume a tiny target is the complete extracted article. Save carrier source, extraction result, planned/prepared units, and target-span assertions with the probe artifacts.
  - **Current blocker:** tiny routed fixtures fail Readability normalized-length and qualifying-block checks. Do not treat the failure as an audio result; do not change production extraction to accommodate the harness.
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.4, 2.8, 3.4, 3.6, 3.7_

- [ ] **7. Add engine-boundary, pre-padding diagnostics for foreground and export**
  - Replace the `Float32Array.set`/`AudioBuffer` monkey patch. Add a test-only offscreen recorder immediately after `engine.call` returns and before `verifyRawVoicedSamples` and `createSpeechAudioBuffer`.
  - For every engine call, store immutable probe/unit index, owner, canonical/synthesis text hash (or safely retained fixture text), language, literal requested speed, raw sample count, finite flag, peak, maximum 128-sample RMS, and voiced verdict. Retain raw fixture samples only under `.tmp/short-segment-audio-dropout/` when independently decoding them.
  - Expose a CDP-readable view that returns and clears records per probe. Assert the record’s speed comes from the engine call itself and its waveform metrics precede all explicit zero padding.
  - **Current blocker:** existing 1.5 probes contain `raw: []`; AudioBuffer-copy instrumentation cannot prove requested engine speed or pre-verifier raw waveform content.
  - _Requirements: 1.4, 1.5, 2.6, 2.7, 2.8, 3.5, 3.6, 3.7_

- [ ] **8. Synchronize and observe immutable export preparation**
  - Before waiting for foreground completion, create the picker/handle, issue `PREPARE_AUDIO_EXPORT`, and wait for both a successful command response and state `prepared`, `waiting`, or `exporting`.
  - Add a test-only offscreen export debug view limited to job ID, playback session ID, prepared unit count, language, voice-style ID, literal speed, and estimate. At 1.5, assert all metadata matches the initiating session before starting export.
  - Retain command response, state transitions, snapshot metadata, background engine records, cleanup diagnostics, and a join between each record and its snapshot. On preparation failure, mark the probe blocked and retain diagnostics; never begin an acceptance assertion from `snapshot-unavailable`.
  - **Current blocker:** attempted exports return `snapshot-unavailable`, so no immutable export snapshot or qualifying export evidence exists.
  - _Requirements: 1.5, 2.6, 2.7, 2.8, 3.5, 3.6_

- [ ] **9. Rebuild the unpacked extension and establish artifact freshness**
  - After changing fixture, harness, or diagnostic surfaces, run the production extension build and use only the fresh `dist/chrome/` bundle for the browser profile. Record build output, manifest/build identity, and harness revision with the matrix artifacts.
  - If a wrapper or build exits nonzero, retain stdout/stderr and keep acceptance blocked. Do not reuse a stale bundle or infer a pass from older captures.
  - **Current blocker:** a prior build wrapper exited nonzero without useful diagnostics, so existing browser artifacts cannot establish bundle freshness.
  - _Requirements: 2.8, 3.5, 3.6_

- [ ] **10. Run the exact 1.05 VnExpress real-model matrix**
  - With the repaired harness and literal controller speed `1.05`, run the five unchanged targets from Task 6.
  - For every carrier, capture extraction, planning, preparation, target-span presence, controller/session speed, engine requested speed, pre-padding raw voiced verdict, ordered foreground starts, synthesis/scheduler diagnostics, and semicolon timing where applicable.
  - Require each prepared foreground index exactly once in source order, no skipped/repeated/dropped start, no synthesis or scheduler error, and a voiced raw result for each successful unit. For the three-semicolon paragraph, require exactly one eligible 140 ms semicolon pause without duplication.
  - **Acceptance rule:** a failed carrier, missing engine record, transition gap, speed mismatch, unvoiced successful result, or scheduler/error record fails or blocks that case. It is not a pass.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.4, 2.5, 2.6, 2.7, 3.2, 3.3, 3.5, 3.6_

- [ ] **11. Run the exact 1.5 short-unit real-model matrix**
  - Set the controller to literal `1.5`. Use Readability-valid carriers for short first, middle, final, consecutive, semicolon-adjacent, punctuationless paragraph, URL/date-protected adjacency, isolated singleton, and capacity-blocked cases. Exercise the active-source/`speedVersion` transition separately.
  - Verify canonical text occurs exactly once in source order; safe merges occur before mapping; retained unmergeable units remain present; canonical versus synthesis text stays distinct; natural/synthetic cadence and final-pause ownership are correct; protected tokens remain intact; and all rendered units honor the resolved 120/300 limit.
  - Every foreground engine-boundary record must have `requestedSpeed === 1.5`, finite voiced pre-padding samples, and one ordered start per prepared index. Require no stale pre-1.5 successor, hidden duration scale, playback-rate compensation, scheduler divisor, altered explicit pause, skipped/repeated/dropped start, synthesis error, or scheduler error.
  - **Acceptance rule:** missing raw capture, missing planned/prepared target, unjoined mergeable short unit, unexpected unvoiced success, or incomplete sequence evidence is failed or blocked—not passing—matrix evidence.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.4, 3.5, 3.7_

- [ ] **12. Produce qualifying decoded MP3 export evidence at 1.5**
  - For every 1.5 export probe, require the synchronized snapshot from Task 8, matching job/session metadata, snapshot and background engine speed `1.5`, and an estimate whose spoken component divides once while planned explicit pauses remain unchanged.
  - Complete export; keep the MP3 and relevant raw capture under `.tmp/short-segment-audio-dropout/`; decode independently; and verify voiced regions occur before only the expected final explicit-pause zeros. Join decoded evidence to the engine-boundary records and ordered unit sequence.
  - Include an intentional unvoiced/raw-failure negative control. It must report the typed export failure, clean up, and leave no silent successful MP3.
  - **Current blocker:** absent synchronized snapshots and pre-padding engine records make all existing export attempts ineligible as acceptance evidence.
  - _Requirements: 1.4, 1.5, 2.5, 2.6, 2.7, 2.8, 3.5, 3.6, 3.7_

- [ ] **13. Final validation checkpoint — keep the release gate open until all evidence qualifies**
  - Re-run the completed deterministic suites without weakening them: consolidation/preservation, mapping, raw-waveform validation, controller speed, segmentation/semicolon cadence, Vietnamese normalizer/NMON, export estimate/engine, and exploration/preservation properties.
  - After Tasks 6–12, run and record the exact results of:

    ```bash
    pnpm test:unit
    pnpm evaluate:vi
    pnpm build
    pnpm test:e2e
    pnpm lint
    git diff --check
    graphify update .
    ```

  - Record command outputs and counts, Vietnamese evaluation result, build identity, changed-file list, 1.05 and 1.5 matrices, literal speed traces, raw waveform records, export snapshots, decoded MP3 evidence, and typed failure diagnostics. Preserve only permitted untracked `.tmp/` artifacts.
  - **Completion rule:** leave this task—and acceptance—unchecked for any failed command, incomplete probe, nonzero wrapper without diagnostics, missing fresh-bundle evidence, missing snapshot or engine-boundary record, critical/important review finding, unexpected changed file, or failed/blocked matrix case.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

## Current Acceptance Conclusion

Do **not** mark the VnExpress regressions accepted yet. Deterministic short-segment consolidation, synthesis-only cadence, raw pre-padding validation, capacity limits, controller speed, semicolon behavior, and NMON preservation are recorded as complete only at deterministic scope. Browser and export acceptance remains blocked until Readability-valid carriers, engine-boundary records, synchronized export snapshots, fresh-bundle evidence, exact 1.05/1.5 matrices, decoded MP3s, and the final validation checkpoint all qualify.
