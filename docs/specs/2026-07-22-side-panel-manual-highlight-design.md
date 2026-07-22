# Side Panel Manual Highlight and Preemptible Playback Design

**Date:** 2026-07-22

**Status:** Implemented and verified against real Supertonic playback

**Scope:** Highlight pasted text in the Side Panel and preserve a manual playback checkpoint while a web playback temporarily preempts it.

## Summary

Manual text in the Side Panel will always visually highlight the word currently
being spoken. This is independent of the existing word-highlight setting, which
continues to control highlights in webpage content scripts only.

Manual highlight timing uses Supertonic's local duration predictor for the
actual normalized spans that are spoken, scaled to the decoded audio's real
spoken duration. The previous vowel-cluster/span-length heuristic remains a
playback-safe fallback when prediction is unavailable or invalid.

The existing textarea remains the edit surface while manual playback is stopped.
Once manual playback starts, that same location becomes a locked, read-only
reader. It preserves the pasted text's line breaks, highlights the current word,
and scrolls that word into view. Stop returns the original draft to the editable
textarea.

A web playback request does not destroy an active manual playback. It
checkpoints the manual audio in offscreen-document memory, then becomes the one
active audible playback. The user can explicitly resume the editor: this stops
web playback and continues manual audio at the same buffer offset and spoken
word. Closing or reloading the Side Panel stops all audio and discards its
manual checkpoint.

## Product decisions

- Use one Side Panel region with two modes rather than a `contenteditable`
  editor or a textarea/overlay pair.
  - **Stopped:** the existing native textarea is editable.
  - **Manual loading, playing, or paused:** a read-only reader replaces it in
    the same layout position.
- The reader is locked through Loading, Playing, and ordinary Pause. The user
  must Stop manual playback before editing the draft.
- Manual word highlight is always enabled. `readit_word_highlight_enabled`
  remains a webpage-only preference and does not affect the Side Panel reader.
- The reader auto-scrolls only enough to keep the active word visible.
- A new Article or selected-text playback preempts manual playback. It does
  not discard the manual checkpoint.
- Web playback completion or a normal web Stop never auto-resumes manual
  playback. Resuming is an explicit Side Panel action.
- While web playback has preempted manual playback, the Side Panel shows two
  manual-specific controls:
  - **Resume editor reading** stops web playback and resumes manual playback
    from its checkpoint.
  - **Stop editor reading** discards the manual checkpoint and unlocks the
    draft without stopping the active web playback.
- Closing or reloading the Side Panel stops any active audio, discards the
  checkpoint, clears manual highlighting, and leaves the next Side Panel
  document with an empty draft. Switching browser tabs does not count as
  closing the globally available Side Panel and does not stop audio.
- Every new user-visible label, hint, status, button name, and error message
  must be added to both English and Vietnamese `THEME_TRANSLATIONS` maps in
  `src/shared/constants.ts` and rendered through the existing localization
  helper. No new literal UI strings are permitted in the Side Panel component.

## Goals and non-goals

### Goals

- Give manual readers a precise visual indication of the spoken text.
- Keep the active mark stable under duplicate runtime delivery and emit one
  public highlight event for each increasing manual word index.
- Preserve native textarea editing behavior while stopped, including plain-text
  paste, IME behavior, selection, and accessibility.
- Resume manual audio at the interrupted position after an explicit web-reading
  preemption.
- Keep all pasted text and audio checkpoint content in extension memory only.
- Make ownership and cleanup unambiguous when a Side Panel closes or reloads.
- Retain the existing single audible playback rule: manual and web audio never
  play at the same time.

### Non-goals

- Adding a rich-text editor, HTML paste, manual-text history, saved drafts, or
  cross-window checkpoint sharing.
- Persisting a checkpoint across Side Panel close, Side Panel reload, browser
  restart, extension restart, or offscreen-document loss.
- Enabling the existing webpage-highlight preference for manual text or adding
  a second user preference for it.
- Automatically resuming manual text after web playback ends.
- Supporting two simultaneous audio streams or two independent audio controls.
- Changing Article or selected-text highlighting behavior on webpages.
- Forced alignment, speech recognition, phoneme-level highlighting, a new model
  download, or any change to the synthesized waveform.

## User experience

### Editor and reader states

| State | Text region | Manual controls | Playback behavior |
| --- | --- | --- | --- |
| No manual session | Editable textarea | Read, Clear, language selection | No manual audio |
| Manual loading / playing / paused | Read-only reader with matching word highlighted | Draft controls locked; existing player controls remain available | Manual owns the audible session |
| Web active with manual checkpoint | Read-only reader labelled as paused for web | Resume editor reading; Stop editor reading | Web owns the audible session; manual stays checkpointed |
| Manual error or unavailable checkpoint | Editable textarea with preserved draft and localized error | Normal draft controls | Existing web audio, if any, is not changed by the error |

The reader renders the exact normalized input accepted by manual playback,
including paragraph breaks. It must not update in response to draft edits,
because the draft is locked whenever a manual reader is present.

The active highlight has no live-region announcement on every 50 ms timing tick.
The existing playback status supplies the accessible playback state. The reader
has an accessible localized label that identifies it as read-only manual text.

### Manual preemption flow

1. The user starts manual playback. The Side Panel creates a document-local,
   random panel instance ID and keeps the accepted text snapshot in its React
   state.
2. Manual audio plays, with the reader locked and manually highlighted.
3. A new Article or selected-text request reaches the background coordinator.
   If manual is active, it requests an offscreen checkpoint instead of calling
   the ordinary destructive replacement path.
4. Offscreen stops the manual source at its current sample offset and retains
   the current buffer, prepared units, current unit, word position, and
   required synthesis state in memory. Background then starts the requested web
   playback as the active session.
5. The Side Panel shows that editor playback is paused for web. Its Resume
   action verifies the panel instance ID, stops web playback, restores the
   manual session, and asks offscreen to resume from the checkpoint.
6. Offscreen recreates the manual audio source from the saved buffer and sample
   offset, restores word timing, and resumes the highlight at the same spoken
   position.
7. Stop editor reading discards the checkpoint, clears the reader highlight,
   and restores the editable textarea while leaving web audio alone.

If another web request arrives while a manual checkpoint exists, it replaces
the active web session but preserves that checkpoint. A new manual request
replaces any prior manual checkpoint and the active web session through the
same explicit replacement behavior.

### Side Panel lifecycle

The Side Panel registers a `pagehide` handler. For a normal reload or close it
sends a fire-and-forget owner-scoped cleanup request to background. The
background acts only when the owner matches either the active manual session or
the suspended manual checkpoint. It then stops active audio, discards the
manual checkpoint, clears manual highlighting, publishes an empty playback
state, and closes the offscreen document when it is no longer needed.

The extension's minimum Chrome version is 127. The newer
`chrome.sidePanel.onClosed` event is unavailable there, so it is not a
dependency. `pagehide` handles normal user close and reload operations; browser
or process termination can prevent lifecycle callbacks, in which case the
checkpoint is best-effort memory and must never be restored after its owner is
gone.

## Architecture

### Side Panel

`src/sidepanel/App.tsx` continues to own document-local draft state. It gains:

- a stable `panelInstanceId`, generated once per Side Panel document;
- the accepted manual reader snapshot and a manual-reader mode;
- manual word-highlight subscription state scoped to the manual session ID;
- a reader element ref used to apply the visual range and minimal auto-scroll;
- explicit Resume editor reading and Stop editor reading actions; and
- owner-scoped `pagehide` cleanup.

The stopped mode retains the native textarea. The locked reader is a plain text
element with preserved whitespace, not an editable DOM surface. The active
reader range is rendered as a Side Panel-only semantic `<mark>` element and is
independent from the webpage content-script highlight.

The Side Panel must only accept manual highlight events for its current manual
session and panel instance. It advances a monotonic source cursor through the
locked reader so repeated text highlights the next valid occurrence rather than
an earlier duplicate. A stale or duplicate event is ignored and retains the
current highlight. A missing or ambiguous match for a newer event clears the
manual highlight instead of highlighting the wrong text.

### Shared contracts

Manual-session metadata gains a non-content owner field:

```ts
source: { kind: 'manual'; panelInstanceId: string }
```

The strict snapshot validator must allow this field and continue to reject raw
manual text, text-derived titles, URLs, and arbitrary fields from a manual
session snapshot.

The planned runtime contracts are:

```ts
START_MANUAL_TEXT {
  payload: { text: string; language: ManualTextLanguage; panelInstanceId: string }
}

RESUME_MANUAL_CHECKPOINT { panelInstanceId: string }
DISCARD_MANUAL_CHECKPOINT { panelInstanceId: string }
STOP_SIDE_PANEL_AUDIO { panelInstanceId: string }
```

The background validates `panelInstanceId` as untrusted input. It must neither
accept a stale ID nor let one Side Panel document control another document's
manual checkpoint.

Manual word notifications carry the current manual session ID and enough stable
source-position information for the reader to avoid repeated-word ambiguity.
Webpage word events remain on the existing tab-relay path. Popup and unrelated
extension pages ignore manual word notifications.

Manual word delivery has two distinct contracts:

```ts
OFFSCREEN_MANUAL_WORD_TIMING { sessionId, word, wordIndex }
MANUAL_WORD_HIGHLIGHT_UPDATE { sessionId, word, wordIndex }
```

The first action is internal to offscreen/background coordination. Background
validates it against the active manual session and is the sole producer of the
second, public Side Panel action. This prevents the Side Panel from receiving
the same public event directly from offscreen and again through background.

### Background coordinator

Background remains the only coordinator for audible playback. It owns one
active session and may have one suspended manual checkpoint in offscreen memory.
It does not store pasted text or audio checkpoint payloads in local or session
storage.

Background is also the sole public manual-highlight relay. It ignores malformed
internal timing messages and messages whose session ID does not match the active
manual session. One accepted internal timing message produces exactly one public
manual-highlight update.

Before starting a tab-owned Article or selected-text session, background checks
whether the active session is manual:

1. Ask offscreen to checkpoint the manual session.
2. If checkpointing fails, reject the new web start and leave manual audio
   playing. This preserves the exact-resume guarantee rather than silently
   losing position.
3. After a successful checkpoint, publish and start the requested web session.

When Resume editor reading is requested, background first verifies that a live
checkpoint belongs to the caller's panel instance. It stops the active web
session without discarding that manual checkpoint, restores the manual snapshot
as active, and asks offscreen to resume it. The manual session retains its
identity for highlight filtering.

When a normal web Stop occurs, background leaves a valid manual checkpoint
paused. When Stop editor reading or owner-scoped Side Panel cleanup occurs,
background explicitly discards the checkpoint. If the service worker has been
restarted while web audio is playing, it obtains checkpoint metadata from the
still-live offscreen document; checkpoint payloads are never reconstructed from
storage.

### Offscreen playback

Offscreen gains a memory-only `ManualCheckpoint` that contains the information
needed to restart the current manual source precisely: manual session metadata,
the prepared speech units, current unit index, decoded current `AudioBuffer`,
its source offset, current word timing position, and required in-flight
synthesis state. It is destroyed on explicit discard, successful replacement by
new manual content, Side Panel cleanup, offscreen close, or an unrecoverable
playback failure.

On checkpoint, offscreen stops the current manual `AudioBufferSourceNode` but
does not discard the saved buffer or prepared units. On resume, it creates a
new source from that buffer at the saved sample offset, restores timing updates,
and continues normal prefetch/synthesis for following units. It must never
start web and manual sources concurrently.

Manual word tracking produces Side Panel events only while manual is audible.
The event source location and checkpoint state must remain monotonic across a
resume. Clear events remove the reader highlight on manual Stop, manual error,
web preemption, and owner-scoped cleanup.

Vietnamese normalization may classify several adjacent source tokens as one
candidate expansion span. That span becomes one highlight target only when the
normalizer actually changes it into a different spoken form. If expansion is
rejected and the spoken piece remains identical to the source, the word map
must retain one entry for each non-punctuation source token, with its own
spoken offsets. A false-positive abbreviation span such as
`Channel Activity Analysis (` therefore produces `Channel`, `Activity`, and
`Analysis` timing targets rather than one unmatchable reader target.

Before synthesizing each speech unit, offscreen builds one cumulative spoken
prefix for every mapped word boundary with `unit.text.slice(0, entry.end)`.
This keeps the same preceding words, punctuation, Markdown markers, normalized
expansions, language, voice style, and speed that the complete utterance uses.
All prefixes are submitted in one batch to the already loaded Supertonic
duration predictor; the single voice-style tensor is repeated across that
batch.

The predictor returns a total utterance duration for each prefix. Consecutive
totals are converted to per-word weights by subtracting the previous prefix
duration. The totals must be finite, positive, have the expected count, and be
strictly increasing; otherwise the entire speech unit uses the existing
deterministic heuristic. This avoids the unsupported assumption that durations
predicted for isolated words are additive inside a longer contextual utterance.

After synthesis, offscreen associates valid weights with the decoded
`AudioBuffer` in a `WeakMap`; playback scales the weights so their windows
exactly cover the buffer's spoken duration, excluding the explicit post-unit
pause. `AudioContext.currentTime` and the saved resume offset remain the
playback clock. Prediction errors also fall back without stopping or changing
audio.

## Privacy and localization

Pasted text stays local. The textarea draft and reader snapshot exist only in
the live Side Panel document; prepared text and audio checkpoint exist only in
the live offscreen document. Background/session storage may contain only the
existing active-session metadata and never raw manual text, normalized text,
speech units, audio, or text-derived labels.

Transient runtime messages may carry the current spoken word and source
position between extension contexts, but never send them to a website, backend,
analytics, telemetry, crash reporting, or a remote service. Webpage content
scripts never receive manual word-highlight events.

The following message intents require English and Vietnamese localization
entries and must use `t()` in the Side Panel:

- read-only manual reader label;
- manual playback paused because web is reading;
- Resume editor reading;
- Stop editor reading;
- manual checkpoint unavailable;
- web reading cannot start because manual playback could not be paused; and
- any reader-state hint or recovery instruction introduced by implementation.

Existing localized strings should be reused where they accurately describe the
state. The implementation must extend the i18n type surface and localization
tests for every new key.

## Error and race behavior

| Case | Required behavior |
| --- | --- |
| Empty or invalid manual input | Preserve the current active session; do not lock the editor. |
| Manual setup error | Clear manual reader mode, preserve the draft, show a localized error, and allow retry. |
| Web start while manual checkpoint creation fails | Reject web start and keep manual audio playing. |
| Web start while manual is playing or loading | Checkpoint manual, then start web only after checkpoint success. |
| Web stop or completion | Keep the manual checkpoint paused; never auto-resume it. |
| Resume with a missing/offscreen-lost checkpoint | Keep web audio unchanged, report a localized recovery error, discard the unavailable checkpoint, and unlock the draft. |
| Resume editor reading | Stop web audio, restore the manual checkpoint, and continue at the saved offset. |
| Stop editor reading during web playback | Discard checkpoint and unlock draft; web continues. |
| Manual highlight event from a stale session, owner, or source position | Ignore it. |
| Duplicate manual word index | Retain the active range and perform no React state update. |
| Manual word cannot be located unambiguously | Clear the reader highlight; do not fall back to an earlier duplicate. |
| Duration prediction unavailable or invalid | Continue playback with heuristic timing weights. |
| Side Panel pagehide with a stale owner | Ignore it. |
| Side Panel close or reload with a matching owner | Stop active audio, discard checkpoint, clear highlight, and reset session state. |
| Browser tab switch | Do not stop active audio or discard a checkpoint. |
| New manual start while web/checkpoint exists | Stop active web, discard the old checkpoint, and create the new manual session. |

## Verification

### Unit tests

- Manual session snapshot validation accepts only the owner metadata and still
  rejects raw text or unrecognized fields.
- Owner-scoped cleanup, discard, resume, and stale-owner isolation.
- Checkpoint success gates web start; checkpoint failure leaves manual playback
  untouched.
- Resume restores the checkpoint before reporting manual playback; a missing
  checkpoint leaves web playback intact.
- Manual word-range matching advances through repeated words, follows resume
  source position, retains the range for duplicate indices, and clears only on
  ambiguity from a genuinely newer event or explicit clear.
- Rejected multi-word normalization spans preserve individual source words and
  exclude punctuation from the word map; accepted expansions remain grouped
  back to their original source span.
- Duration prediction repeats the voice style across the cumulative-prefix
  batch, applies speed exactly once, converts strictly increasing totals to
  per-word weights, scales them to decoded spoken duration, and falls back for
  invalid results or predictor errors.
- Localization coverage includes every newly introduced English and Vietnamese
  message key.

### End-to-end tests

- A valid manual start replaces the textarea with a locked reader, highlights
  the incoming word, and auto-scrolls it into view while the webpage preference
  is disabled.
- Pause keeps the reader locked; manual Stop restores the editable original
  draft and removes highlight.
- A web start checkpoints manual, displays the paused-for-web state, and does
  not lose the reader snapshot.
- Resume editor reading stops web and resumes manual from the checkpointed word;
  Stop editor reading instead unlocks manual text while web continues.
- Repeated words never highlight an earlier occurrence; stale manual events do
  not alter the reader.
- Two identical public manual events leave one stable mark, and one accepted
  internal offscreen timing event produces exactly one public Side Panel event.
- For mixed English/Vietnamese text beginning with Markdown emphasis, the first
  highlight is `Channel`, not the later `4.6.6`, and subsequent ranges remain
  monotonic with audio.
- The mixed Markdown regression crosses the production Vietnamese normalizer,
  runtime event shape, and Side Panel renderer. A separate real-runtime harness
  using the cached Supertonic model must confirm that both the first emitted
  event and first rendered mark are `Channel` when audible playback begins.
- A normal Side Panel reload and close stop audio, discard the checkpoint, and
  reopen with no draft or reader text. This replaces the existing regression
  that expects manual playback to continue through Side Panel reload.
- Side Panel close during web playback with an owned manual checkpoint stops
  web audio and discards that checkpoint.
- Pasted-text sentinels are absent from every Chrome storage area and web
  storage while active, checkpointed, stopped, reloaded, and closed.

### Verification sequence

1. Run focused manual checkpoint, playback-state, localization, and word-range
   unit tests.
2. Run `CI=true pnpm test:unit`.
3. Run `CI=true pnpm build`.
4. Run production manifest validation.
5. Run focused Side Panel and word-highlight Playwright tests.
6. Run the complete Playwright suite.
7. Run `git diff --check`.

## Documentation impact and success criteria

The implemented 2026-07-19 Side Panel manual-text design and its related plan
currently state that manual audio continues through Side Panel reload and close.
Implementation must update that behavior and any dependent PRD, privacy,
release, and test documentation without weakening the no-persisted-text rule.

The feature is complete when pasted text has a local, readable, always-on and
stable spoken-word highlight; valid cumulative-prefix model weights control
word boundaries against the decoded audio clock without skipping a contextual
prefix; rejected normalization spans retain word-level source mappings; edit
locking and recovery states are localized; manual audio can be
explicitly resumed at its interrupted position after web playback; and closing
or reloading the Side Panel reliably clears its owned audio state. No pasted
text, checkpoint, timing metadata, or audio content may be persisted or sent
outside the extension.
