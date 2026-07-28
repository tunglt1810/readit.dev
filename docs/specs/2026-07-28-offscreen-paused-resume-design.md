# Exact Resume After a Long Pause

## Problem

The offscreen document is created with the `AUDIO_PLAYBACK` reason. When the
user pauses, the primary `AudioContext` is suspended, so Chrome can close the
offscreen document after a period with no audio. The resume command only carries
a `sessionId`; the audio state, buffer, and source node are then gone. Background
reports a playback error while the UI can still show controls for the old
session.

The first keepalive implementation used a continuous 20 Hz oscillator at gain
`0.00001`. Chromium classifies that level as silence, so the offscreen document
still closes after 30 seconds. Keeping a corrected signal running continuously
would also retain a second live audio pipeline for the whole pause.

## Goals

- Retain the paused playback source node so resume continues at the exact
  position.
- Keep Chrome's offscreen audio lifetime alive with short pulses instead of a
  continuous auxiliary stream.
- Close the auxiliary `AudioContext` and release its nodes between pulses.
- Do not store article, selection, manual text, or audio in storage.
- If the offscreen document still disappears, transition the session to `error`
  so the UI presents Read Again instead of Stop for an unrecoverable session.

## Fixed pulse parameters

- Frequency: 20 Hz.
- Gain: `0.001`, approximately -63 dBFS RMS for a sine wave and above
  Chromium's -72.247 dBFS silence threshold.
- Pulse duration: 250 ms, exactly five cycles at 20 Hz.
- Normal delay between pulses: 20 seconds.
- Retry delay after a failed pulse: 2 seconds.

Because the next 20-second delay begins after a 250 ms pulse finishes, the
auxiliary audio duty cycle is `250 / 20,250`, approximately 1.23%. The earlier
1.25% figure is the simplified `250 / 20,000` estimate. This percentage only
describes how long the keepalive stream is active; it is not a claim about total
extension RAM or CPU usage.

## Design

After a successful pause, suspend the primary `AudioContext` as today and arm a
one-shot timer. Do not create the auxiliary context immediately. This means a
pause shorter than 20 seconds creates no keepalive audio resources.

When the timer fires, create a separate `AudioContext`, oscillator, and gain
node. Play one 250 ms pulse, stop the oscillator at the sample-accurate fifth
cycle boundary, disconnect both nodes, close the context, clear every reference,
and only then schedule the next pulse. Use chained `setTimeout` calls rather
than `setInterval` so a slow cleanup cannot overlap the next pulse.

An audible transition cancels Chrome's pending offscreen inactivity timeout.
When the pulse ends, Chrome starts a new 30-second inactivity window; the next
normal pulse begins after 20 seconds, leaving about 10 seconds of margin.

`start()` is idempotent and resolves after the first timer is armed, so Pause
does not wait for a pulse. `stop()` is also idempotent: it invalidates the
current generation, cancels a pending timer, stops and disconnects an active
pulse if present, closes its context, and waits for any in-flight cleanup. A
later `start()` must wait for that cleanup before arming a replacement cycle.

If creating, resuming, or playing a pulse fails, close any partially-created
resources and schedule another attempt after 2 seconds while the helper remains
started. The paused playback session itself remains valid; if all retries fail
and Chrome closes the document, the existing coordinator failure path
invalidates the session and asks the user to read again.

On resume, stop the keepalive cycle before resuming the primary `AudioContext`.
Since the primary `AudioBufferSourceNode` has not been replaced, Web Audio
continues from the sample at which it was suspended.

Keepalive must be stopped on every terminal playback path: Stop, natural
completion, a new playback request, manual checkpoint, and synthesis error. A
keepalive pulse must never survive one of these transitions.

## Memory boundary

Between pulses, the helper retains only timer and generation bookkeeping. It
must not retain an auxiliary `AudioContext`, `OscillatorNode`, or `GainNode`.

Exact resume still requires the primary suspended `AudioContext`, current
`AudioBufferSourceNode`, decoded current buffer, playback metadata, and loaded
TTS engine to remain in memory. Releasing those resources would require
re-synthesis or persisted audio and is outside this fix.

## Verification

- Unit tests use a deterministic fake scheduler and fake audio contexts.
- Before 20 seconds, no auxiliary context has been created.
- Each timer activation creates one context, plays one 250 ms pulse, then closes
  the context before scheduling the next activation.
- Repeated `start()` calls share one cycle.
- `stop()` during the wait or during a pulse leaves no timer, context, or node.
- Stop followed immediately by Start cannot overlap generations.
- A failed pulse cleans up and schedules a 2-second retry.
- The headed Chromium E2E remains paused beyond the 30-second
  `AUDIO_PLAYBACK` cutoff, retains the same primary source and offset, proves
  the auxiliary context has been released, and resumes the same session.
- Headless Chromium has no audible output in this fixture, so it verifies the
  Pause/Resume and lost-offscreen coordinator paths without treating the
  30-second lifetime as an audibility oracle.
- Forced loss of the offscreen document still transitions the UI to `error` and
  Read Again.

## Out of scope

- Recreating the offscreen document to recover lost audio.
- Persisting audio or text, or changing the public UI.
- Unloading the primary audio buffer, TTS models, or engine while paused.
- Using an unrelated offscreen reason to bypass `AUDIO_PLAYBACK` lifetime
  enforcement.

## References

- [Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Chromium offscreen audio lifetime enforcer](https://chromium.googlesource.com/chromium/src/+/HEAD/extensions/browser/api/offscreen/audio_lifetime_enforcer.cc)
- [Chromium audio stream monitor](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/media/audio_stream_monitor.h)
- [Chromium audio audibility threshold](https://chromium.googlesource.com/chromium/src/+/HEAD/services/audio/output_stream.cc)
