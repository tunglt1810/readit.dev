# MP3 Audio Export Design

**Status:** Approved
**Date:** 2026-07-29

## 1. Summary

readit.dev will let a user export the complete content of the active reading
session as a local MP3 file. Export is available from the playback controls in
both Popup and Side Panel.

The export is independent of the current playback position. It captures an
immutable snapshot of the active content, resolved language, Voice Style, and
speed, then synthesizes that snapshot from the beginning. Foreground playback
continues and always has priority over export work.

The extension writes the MP3 directly to a user-selected file with the File
System Access API and Mediabunny streaming. It does not assemble the complete
MP3 in memory, upload content, use a backend, or download executable code at
runtime.

## 2. Goals

- Export the complete active reading session as a 96 kbps mono MP3.
- Support webpage articles, selected text, pasted text, Google Docs, and PDFs.
- Keep foreground playback responsive and gap-free while export runs.
- Stream directly to a user-selected file without a duration or in-memory file
  size limit.
- Keep Popup and Side Panel export state synchronized.
- Keep all text, PCM, and encoded audio local to the extension and selected
  file.
- Preserve Chrome 127 as the minimum supported version.
- Ship complete, auditable license notices for Mediabunny and the bundled LAME
  encoder.

## 3. Non-goals

- Multiple simultaneous export jobs or an export queue.
- Resuming export after browser shutdown, extension reload, update, or offscreen
  loss.
- Configurable bitrate, stereo output, or alternative output formats.
- Batch export, automatic export, ID3 metadata editing, or export history.
- Persisting reading content, synthesized PCM, or encoded audio in extension
  storage.
- Remote libraries, remote WASM, cloud encoding, backend processing, or
  telemetry.
- Reading Queue, Personal Dictionary, or Background Music. Those features
  require separate designs.

## 4. User experience

### 4.1 Export control

Popup and Side Panel show the same icon-only Download button in their playback
control row.

- The button has an accessible name and tooltip `Export MP3`.
- Enter and Space activate it.
- The button is disabled when there is no exportable active session.
- Both surfaces subscribe to the same background-owned export state.

The visual state is:

| State | Control behavior |
| --- | --- |
| No exportable session | Disabled Download icon |
| Ready | Download icon and `Export MP3` tooltip |
| Preparing or choosing a file | Spinner; duplicate activation is ignored |
| Exporting | Progress ring and `Exporting MP3 — N%` tooltip |
| Waiting for playback | Progress ring and `Waiting for playback` tooltip |
| Cancelling | Spinner and `Cancelling export` tooltip |
| Completed | Temporary checkmark and success toast, then Ready |
| Failed or interrupted | Warning state and a retryable localized message |

A visible live region announces progress state changes, completion, failure,
and cancellation. No system notification permission is added.

### 4.2 Save As

The extension calls `showSaveFilePicker()` from the user gesture that confirms
the export. Picker options use:

- MIME type `audio/mpeg`;
- extension `.mp3`;
- picker ID `readit-mp3-export`;
- start directory `music`.

Suggested filenames are:

- `<page-or-document-title>.mp3`;
- `<page-title>-selection.mp3`;
- `readit-pasted-text-<local-date-time>.mp3`.

Unsafe filename characters and trailing dots/spaces are removed. The user may
edit the suggested name in Save As.

If the user cancels Save As, the prepared snapshot is discarded and no export
job or error state is created.

### 4.3 Long-content warning

The offscreen document reports an export estimate after it prepares the active
session's `SpeechUnit` plan. Background persists only this numeric estimate
with the playback snapshot.

For an estimated duration below 60 minutes, activating Download proceeds
directly to preparation and Save As. At 60 minutes or more, the UI first shows
a localized warning with:

- estimated audio duration;
- estimated MP3 size at 96 kbps;
- notice that local synthesis may take a long time and temporarily wait for
  playback.

The warning has `Cancel` and `Continue`. `Continue` is a new user gesture that
opens Save As. There is no hard duration limit.

The initial estimate is intentionally approximate:

- languages with whitespace use 160 spoken words per minute;
- Chinese uses 240 Han characters per minute;
- the selected speed scales the result;
- planned punctuation pauses are added;
- estimated MP3 bytes are `durationSeconds * 96_000 / 8` plus a small container
  overhead allowance.

The same per-unit duration estimate supplies monotonic progress weights. Runtime
ETA replaces the initial estimate with a moving average after encoding begins.

### 4.4 One-job behavior

Only one preparing or active export job may exist.

- Starting from Popup disables starting from Side Panel, and vice versa.
- Both surfaces hydrate the same progress after opening.
- Activating the progress control opens a confirmation to cancel the job.
- Closing Popup or Side Panel does not cancel export.
- Starting a different playback session does not cancel export. The job keeps
  the old immutable snapshot and yields to the new foreground session.

## 5. Architecture

### 5.1 Ownership

The feature has four bounded components:

1. **Shared Export UI**
   - renders the Download/progress control in Popup and Side Panel;
   - invokes Save As;
   - stores the selected file handle in the handoff store;
   - sends JSON commands and renders background-owned state.

2. **Background Audio Export Coordinator**
   - is the single control plane;
   - validates the active playback session;
   - enforces one-job behavior;
   - asks offscreen to retain or discard an immutable snapshot;
   - persists non-content job metadata in `chrome.storage.session`;
   - broadcasts progress to Popup and Side Panel;
   - keeps the offscreen document alive while playback or export is active.

3. **IndexedDB Export Handle Store**
   - stores one temporary `FileSystemFileHandle`, keyed by `jobId`;
   - exists because Chrome runtime messaging is JSON-based on the supported
     Chrome 127 baseline;
   - never stores text, configuration, PCM, MP3 bytes, or history;
   - deletes the record on picker cancellation, completion, cancellation,
     failure, interruption, and stale preparation cleanup.

4. **Offscreen Audio Export Engine**
   - owns the in-memory export snapshot;
   - lazy-loads the locally packaged encoder;
   - arbitrates foreground and background synthesis;
   - reads the handle from IndexedDB;
   - streams MP3 bytes to disk;
   - reports progress and terminal results.

Side Panel does not coordinate playback or export directly with offscreen.
Background remains the control plane; IndexedDB is only a same-origin
capability handoff.

### 5.2 Start flow

The UI already has the active playback session ID and numeric export estimate
from its hydrated playback snapshot.

For a confirmed export:

1. UI generates a `jobId`.
2. In the same click handler and before awaiting either result, UI:
   - sends `PREPARE_AUDIO_EXPORT(jobId, playbackSessionId)` to background;
   - invokes `showSaveFilePicker()`.
3. Background validates that no other job exists and asks offscreen to clone
   the current `SpeechUnit` plan and configuration into an immutable in-memory
   snapshot keyed by `jobId`.
4. After both preparation and Save As succeed, UI stores the file handle in
   IndexedDB and sends `START_AUDIO_EXPORT(jobId)`.
5. Background asks offscreen to start the prepared job.
6. Offscreen reads and immediately deletes the handle record, opens the writable
   stream, and starts encoding.

If session preparation fails while the picker is open, the selected handle is
not opened or written. If UI disappears before sending Start, background drops
the prepared snapshot after ten minutes and removes any matching handle record.

### 5.3 Immutable export snapshot

The offscreen snapshot contains:

- job ID and source playback session ID;
- sanitized title/source metadata needed for UI;
- the complete planned `SpeechUnit[]`;
- resolved language;
- loaded Voice Style reference and Voice Style ID;
- speed;
- estimated duration and size.

It does not retain the playback position or mutable playback settings. Changing
voice, language, or speed after preparation affects foreground playback and
future exports, not the active export.

## 6. Synthesis scheduling

### 6.1 One TTS engine

Export reuses the existing offscreen TTS engine. It does not create a second
model or engine because that would duplicate model memory and still contend for
CPU/GPU resources.

The existing indexed foreground coordinator continues to own playback
deduplication, current-unit synthesis, and next-unit prefetch. Its synthesis
delegate and the export engine submit actual inference calls through a small
two-lane `SynthesisArbiter`:

- `foreground`: playback current unit and prefetch;
- `background`: export units.

The arbiter serializes calls to the shared TTS engine and always selects a
queued foreground call before a background call. An inference already running
cannot be preempted, so the scheduler uses a conservative runway gate before
starting each export unit.

### 6.2 Runway gate

Export may start one unit only when one of these conditions is true:

- no playback session is active; or
- playback is actively producing audio, the next foreground buffer is already
  resolved, and remaining current-plus-next buffered audio exceeds the maximum
  of the latest five observed synthesis durations plus a 250 ms safety margin.

Export waits while playback is loading, paused, changing session/settings, or
lacks safe runway. This keeps Resume responsive and avoids starting
non-preemptible background inference without audio coverage.

After every export unit, the scheduler yields, rechecks foreground demand,
rechecks cancellation, and recalculates runway. A new playback session
immediately blocks new background work until its foreground buffer is safe.

The UI reports `waiting-for-playback` while gated. Slow export progress is
acceptable; playback gaps or dropped spoken units are not.

### 6.3 Per-unit memory bound

Export synthesizes one `SpeechUnit` to one mono `AudioBuffer`, including the
same trailing pause used by playback. It submits that buffer to the MP3 media
source and releases the export reference after the encoder accepts it.

The design does not retain all PCM buffers, retain the full encoded MP3, or use
Mediabunny `BufferTarget`. Memory is bounded to the current foreground buffers,
one export buffer, the encoder/worker working set, and small stream buffers.

## 7. MP3 encoding and file streaming

The build pins matching exact versions of:

- `mediabunny`;
- `@mediabunny/mp3-encoder`.

The initial approved version is `1.51.0` for both packages. Any later upgrade
requires repeating runtime, archive, and license verification.

At job start, offscreen uses dynamic `import()` to lazy-load locally built
chunks. The encoder's worker and LAME WASM must be contained in the extension
archive. Fetching JavaScript or WASM from a CDN or other host is prohibited.

The export engine:

1. checks native MP3 encoding support and registers
   `@mediabunny/mp3-encoder` when required;
2. creates a Mediabunny MP3 output at 96,000 bits per second, mono;
3. creates `FileSystemWritableFileStream` with
   `keepExistingData: false`;
4. connects it through Mediabunny `StreamTarget`;
5. feeds timestamped audio buffers in planned order;
6. honors stream backpressure;
7. finalizes the MP3;
8. closes the writable stream only after successful finalization.

The default Xing header remains enabled. No ID3 metadata is added in this
version.

Offscreen creation adds the legitimate `WORKERS` and `BLOBS` reasons alongside
`AUDIO_PLAYBACK`. Background's explicit idle cleanup closes the offscreen
document only when playback, preparation, and export are all inactive.

## 8. State model

Background owns one optional `AudioExportJobSnapshot`:

- `jobId`;
- source playback session ID;
- title and output filename;
- state: `preparing`, `exporting`, `waiting-for-playback`, `cancelling`,
  `completed`, `failed`, or `interrupted`;
- estimated and processed duration weights;
- progress percentage;
- bytes written;
- started/updated timestamps;
- stable localized error code when applicable.

The job snapshot does not contain content, file paths, file handles, audio, or
encoder objects.

Valid state transitions are:

```text
idle -> preparing
preparing -> exporting | failed | idle
exporting <-> waiting-for-playback
exporting | waiting-for-playback -> cancelling | completed | failed
cancelling -> idle | failed
preparing | exporting | waiting-for-playback | cancelling -> interrupted
completed | failed | interrupted -> preparing | idle
```

Progress is monotonic within a job. Terminal state may remain in session
storage long enough for newly opened surfaces to hydrate and present the
result, then is cleared by dismissal or the next preparation.

## 9. Cancellation, failure, and interruption

- **Picker cancelled:** discard preparation; no job and no error.
- **User cancellation:** stop scheduling new units, wait for any
  non-preemptible inference/encoder operation to settle, cancel Mediabunny,
  call `writable.abort()`, and delete handle/snapshot metadata.
- **TTS or encoder failure:** abort the writable, delete transient resources,
  and expose a retryable localized error.
- **Permission denied or revoked:** fail before writing or abort an open
  writable.
- **Disk full or write failure:** abort and report a storage-specific error.
- **Session changes:** do not affect the immutable export snapshot.
- **Popup/Side Panel closes:** do not affect the job.
- **Browser closes, extension reloads/updates, or offscreen disappears:** mark
  any nonterminal stored job `interrupted` on coordinator hydration, remove its
  handle record, and do not resume.

The file is committed only by successful `finalize()` followed by `close()`.
Cancellation and errors must not deliberately close or publish a partial MP3.

## 10. Privacy and permissions

The feature remains local-only:

- article, selection, pasted, Docs, and PDF text remain in offscreen memory;
- generated PCM remains in offscreen/encoder memory for one unit;
- MP3 bytes flow only to the user-selected writable file;
- the file handle is a temporary IndexedDB capability;
- progress metadata contains no reading content;
- no backend, telemetry, cloud TTS, cloud encoding, or remote executable code
  is introduced.

The manifest adds no `downloads`, identity, history, or host permission. The
existing self-hosted script and `wasm-unsafe-eval` CSP remains the executable
code boundary.

`docs/privacy-policy.md` must be updated to disclose explicit user-directed
local audio export and the transient local file handle without implying that
readit.dev collects or retains the exported content.

## 11. License notices and legal review

License compliance is a blocking release gate, not a documentation follow-up.

Implementation must:

1. pin and lock the exact Mediabunny packages;
2. inspect the license files shipped by those exact package versions;
3. update `public/THIRD_PARTY_NOTICES.txt` with:
   - package names and exact versions;
   - project URLs and source locations;
   - copyright notices;
   - Mediabunny MPL-2.0 notice;
   - LAME version used by the encoder, its exact upstream LGPL designation,
     acknowledgement, project link, and source link;
4. include verbatim copies of the exact upstream Mediabunny and LAME license
   texts in the release archive;
5. retain upstream license/copyright headers and notices;
6. document that readit.dev does not modify either upstream work;
7. extend release archive validation to require the notices, exact license
   texts, stable project/source links, and local encoder code/WASM;
8. verify the built archive contains no runtime CDN or other remote executable
   loading; and
9. require legal review before public distribution of this feature.

The implementation must copy the exact LAME license designation and text from
the audited source rather than inferring an SPDX variant. These engineering
notices and source links are not legal advice or a guarantee of LGPL
compliance; the required legal review remains a public-release prerequisite.

## 12. Testing

### 12.1 Unit tests

- Export state transitions and one-job enforcement.
- Foreground-first arbiter ordering.
- Runway gating, foreground arrival, waiting state, and no background
  starvation when playback becomes idle.
- Cancellation before synthesis, during synthesis, during backpressure, and
  during finalization.
- Immutable snapshots across playback/session/settings changes.
- Progress weighting, moving ETA, 60-minute warning, and 96 kbps size
  estimation.
- Filename sanitization and source-specific suggested names.
- IndexedDB handle insertion, one-time consumption, stale cleanup, and terminal
  cleanup.
- Startup conversion of nonterminal jobs to `interrupted`.

### 12.2 MP3 integration tests

- Lazy-load the locally built encoder under the extension CSP.
- Encode deterministic PCM through Mediabunny and `StreamTarget`.
- Write through a fake/temporary `FileSystemWritableFileStream` with
  backpressure and random-access writes.
- Parse the result and verify MP3 format, mono channel count, approximate
  duration, and configured 96 kbps bitrate.
- Verify finalize/close commits and cancel/error calls abort without commit.
- Verify the encoder worker runs in the real offscreen document.

All temporary files and browser artifacts live under repository `/.tmp/`.

### 12.3 Extension E2E tests

- Popup and Side Panel render the same accessible Download control.
- Disabled, ready, exporting, waiting, cancelling, completed, failed, and
  interrupted states hydrate correctly.
- Starting on one surface updates the other.
- Cancel from the other surface aborts the shared job.
- A second export cannot start while preparation/export is active.
- The 60-minute warning allows continuation and imposes no hard cap.
- Webpage, selection, pasted text, Google Docs, and PDF sessions are
  exportable.
- Popup/Side Panel closure does not cancel export.
- Playback session replacement preserves the old export snapshot.
- Export background work introduces no dropped spoken unit and no playback gap
  above the repository's existing regression threshold.

Native Save As interaction receives a focused manual Chrome check in addition
to automated picker/handle adapters.

### 12.4 Release verification

Run the focused tests, complete unit suite, production build, manifest
validation, license/archive validation, full Playwright suite, and
`git diff --check`. Inspect the built manifest and archive to confirm there is
no new host permission and all encoder code, worker code, WASM, notices, and
license texts are packaged locally.

## 13. Acceptance criteria

The feature is complete when:

- every active content source can be exported from Popup or Side Panel;
- output is a playable 96 kbps mono MP3 containing the complete content from
  the beginning with the snapshotted language, Voice Style, speed, and pauses;
- export streams to the selected file and supports content estimated beyond
  120 minutes without buffering the full file;
- foreground playback remains correct and takes priority;
- one shared job hydrates and can be cancelled from either surface;
- cancellation/failure does not publish a partial MP3;
- browser/extension interruption does not resume;
- no reading content or audio is persisted in extension storage;
- no remote executable dependency or new host/download permission is added;
- privacy, third-party notices, exact license texts, and release validation are
  complete;
- all specified automated and manual checks pass.

## 14. References

- Mediabunny MP3 encoder:
  https://mediabunny.dev/guide/extensions/mp3-encoder
- Mediabunny StreamTarget:
  https://mediabunny.dev/api/StreamTarget
- Chrome File System Access API:
  https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
- Chrome Manifest V3 remote hosted code policy:
  https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- Chrome offscreen API:
  https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome structured-clone messaging:
  https://developer.chrome.com/blog/structured-clone-messaging
