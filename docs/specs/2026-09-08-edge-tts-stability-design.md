# edge-tts stability: SSML compatibility and starvation-driven fallback

Date: 2026-09-08
Status: approved design, pending implementation plan

## Problem

edge-tts is the default speech provider, and sessions downgrade to on-device Supertonic
often enough that the cloud voice feels unreliable. Investigation found two independent
defects with different mechanisms. Only the second one is a network problem.

## Evidence

All figures below were measured against the live endpoint
(`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`) with the
production `Sec-MS-GEC` handshake and the `Edg/` User-Agent.

### The endpoint rejects every structural SSML tag

| SSML | Result |
| --- | --- |
| `speak > voice > prosody > text` | OK |
| `<break time='300ms'/>` (any position) | close 1007 |
| `<bookmark mark='...'/>` | close 1007 |
| `<mark name='...'/>` | close 1007 |
| `<s>`, `<p>` | close 1007 |
| `<silence .../>` | close 1007 |

The readaloud endpoint accepts plain text inside `prosody` and nothing else. 1007 is
deterministic: the same SSML fails every time.

### Payload behaviour has a cliff between 4000 and 8000 characters

| chars | audio returned | wall clock | speed |
| --- | --- | --- | --- |
| 500 | 29.5s | 0.6s | 51x realtime |
| 2000 | 117.5s | 1.0s | 117x realtime |
| 4000 | 232.7s | 2.9s | 80x realtime |
| 8000 | 464.6s | 376.7s | 1.2x realtime |

Below the cliff the server streams as fast as it can; above it the server paces delivery to
roughly realtime. Word-boundary metadata stays complete at length — one 4000-character
response carried 865 word boundaries.

### Random drops are external and cluster in time

Failures present identically every time: the server accepts the SSML frame, sends nothing
for 2.2-2.5 seconds, then resets the connection (close 1006, zero audio bytes, zero word
boundaries). Reconnecting succeeds within 250ms.

Interleaving a low-rate sample (1 request per 10s idle) with a burst sample (back-to-back)
inside the same time windows:

- LOW failed 1/10, HIGH failed 9/40. The difference is not statistically significant
  (Fisher exact p ≈ 0.42).
- All 9 failures fell between t=10s and t=122s. From t=133s to t=157s, 15 of 15 requests
  succeeded with latency pinned between 212ms and 347ms — including the densest bursts of
  the whole run.

So the driver is wall-clock state on Microsoft's side, not our request rate. This is
consistent with `TRUSTED_CLIENT_TOKEN` being hard-coded in Microsoft Edge itself: every
edge-tts client worldwide shares it, there is no per-user authentication, and therefore no
per-user quota to stay under. Bad windows lasted roughly two minutes and reached about 30%
failure while active.

**Consequence for the design: reducing our own request rate, adding jitter, or spacing out
prefetch cannot help.** Only tolerating the window can.

## Defect 1: every non-Latin-script language fails deterministically

`buildSsml` emits `<break time='300ms'/>` whenever `unit.pauseAfterMs === null`
(`src/offscreen/edge/edge_ssml.ts:26`, driven by
`src/offscreen/edge/edge_provider.ts:43`). That tag is a guaranteed 1007.

Running the real planner, `preparePlaybackUnits`:

| language | units with `pauseAfterMs === null` |
| --- | --- |
| en | 0% |
| vi | 0% |
| zh, ja, ko | 100% |

`pauseAfterMs: null` originates only in the non-Vietnamese branch of
`playback_preparation.ts:66-68`, where text that is not predominantly Latin routes through
`compatibilityUnits(paragraphs, lang, null)`.

These languages are not filtered out earlier: `localeForLanguage` resolves zh to zh-CN (6
voices), ja to ja-JP (2), ko to ko-KR (3), th to th-TH (2), ar to ar-EG (2), he to he-IL
(2). So `EdgeUnsupportedLanguageError` never fires, and instead every unit hits 1007, the
three retries all fail identically, and the session downgrades on the very first unit.

edge-tts is currently unusable for every non-Latin-script language.

## Defect 2: three fast retries cannot outlive a two-minute bad window

`EDGE_SYNTHESIS_ATTEMPTS = 3` with backoffs of 250ms and 750ms spans about one second. A
bad window lasts roughly two minutes at about 30% failure, so all three attempts land
inside the same window. One unit exhausting its attempts moves the whole session to
Supertonic permanently (`downgradeToSupertonic`, `offscreen.ts:464`), with no path back to
edge even after the window passes.

## Design

### Part 1: stop emitting `<break>`

- `edge_ssml.ts` drops the `internalSilenceMs` parameter and the `<break>` tag. `buildSsml`
  produces only `speak > voice > prosody > escaped text`.
- `edge_provider.ts` keeps the 300ms cadence contract by appending 300ms of silent samples
  to the returned `samples` when `unit.pauseAfterMs === null`. Word timings are unaffected
  because boundary offsets are measured from the start of the buffer.

This restores parity with the Supertonic path, which already renders that silence inside
the engine call (`audio.ts:24`), and makes edge-tts work for non-Latin-script languages for
the first time.

Shipping order: Part 1 is independent of Part 2 and lands first.

### Part 2: buffer deeply, retry patiently, downgrade on starvation

**Prefetch measured in seconds of audio.** Today `prefetchNextUnit` fetches one unit ahead
and `retainedSynthesisKeys` holds three keys. Instead, keep synthesizing forward until the
buffered audio ahead of the playhead (resolved plus in-flight) reaches 180 seconds, or the
article ends; `retain` keeps exactly that set. Durations for not-yet-synthesized units come
from the existing estimator in `audio_export_estimate.ts`.

180 seconds covers the observed two-minute bad window with margin and costs 33MB — measured
in the offscreen document at a 48kHz context, which stayed alive and kept the buffers
playable. Filling it takes roughly 10 seconds: the arbiter runs requests one at a time, and
a unit-sized request measured about 0.6s round trip, so the cost is per-request latency
rather than throughput.

**Retry delay bounded by headroom.** A unit the playhead needs now must not wait 45
seconds; a unit two minutes ahead can. One rule covers both:

```
delayMs = clamp(min(1000 * 2^(attempt-1), headroomMs / 2), 250, 45_000)
```

where `headroomMs` is the buffered audio ahead of the playhead. With a full buffer the
ladder runs 1s, 2s, 4s, 8s, 16s, 32s, 45s. As the playhead starves, headroom shrinks and
the delays collapse toward the 250ms floor on their own.

**No attempt cap.** `EDGE_SYNTHESIS_ATTEMPTS` is removed. Retrying is free while the user
hears nothing wrong, so the stop condition is starvation, not a counter.

**Retries must not hold the arbiter slot.** `SynthesisArbiter.drain` awaits `run(input)`
one at a time, so sleeping inside `synthesizeWithFallback` would stall every other unit —
a single retrying unit would block the very buffer refill that makes retrying safe. The
backoff wait has to happen outside the arbiter slot, with the retry re-entering the queue
afterwards.

**Queued prefetch must be bounded.** Re-entering the queue means re-entering it at the
back, so the two decisions above interact: filling the window in one go enqueued about
thirty requests, and a single drop on the unit playback was waiting for put its retry
behind all of them. Reproduced on a fake clock over the real wiring, first audio went from
1.2s to 19.4s on one drop — worse in practice, where a dropped request sits silent for 2.4
seconds before closing. At most three prefetch requests may be queued at a time, refilled
from the coordinator's `onResolved`. The arbiter serves one request at a time regardless,
so the bound changes ordering rather than throughput and the window still fills in the
same time.

This is the one place where the parts are each correct but their composition is not, so it
is covered by `tests/unit/synthesis_pipeline.test.ts` rather than by any single unit's
tests.

**Downgrade on starvation, not on attempt count.** Downgrade to Supertonic when either:

- the error is deterministic (see taxonomy below), or
- the buffer has been dry for more than 30 seconds while the player waits.

Total tolerance is therefore about 180s of buffer plus 30s of visible loading, against a
two-minute bad window. The downgrade itself keeps today's behaviour: whole session, remaining
units re-planned through the normalizer, `ttsProviderFallbackNotice` reported. Per-unit
fallback was considered and rejected — switching voice for isolated sentences is a worse
experience than switching once.

**Error taxonomy.** `isEdgeFailure` currently treats every `EdgeSocketError` and
`EdgeUnsupportedLanguageError` as retryable. Split it:

| Error | Class | Action |
| --- | --- | --- |
| close 1007 | deterministic | downgrade immediately |
| `EdgeUnsupportedLanguageError` | deterministic | downgrade immediately |
| close 1006, `connection closed` | transient | retry ladder |
| request timeout, handshake timeout | transient | retry ladder |

Retrying a deterministic error burns the entire 3.5-minute tolerance for nothing.

## Testing

- `buildSsml` emits no tag other than `speak`, `voice`, `prosody`.
- `edge_provider` appends 300ms of silence when `pauseAfterMs === null`, and does not when
  a numeric pause is set.
- Retry delay function: full headroom produces the full ladder; near-zero headroom clamps
  to the floor.
- Downgrade triggers on a deterministic error immediately, and on transient errors only
  after the buffer is dry beyond the grace window. Driven by a fake clock.
- Prefetch fills to the second-based target rather than a unit count, and `retain` keeps
  the matching set.
- Live e2e (`edge-tts-live.spec.ts`, excluded from the default run) gains a case asserting
  the endpoint still rejects `<break>`, so a change of heart at Microsoft surfaces as a
  test result rather than a guess.

## Trade-offs accepted

- Changing playback speed invalidates the buffer, because `speedVersion` is part of the
  synthesis key. Refilling costs about 11 seconds, during which the buffer is thin.
- A reader who listens for ten seconds and closes the page still triggers up to 180 seconds
  of synthesis. Deliberate cost for smoothness.
- If the endpoint is genuinely down, the reader waits the full grace window before hearing
  the on-device voice, rather than switching immediately.

## Out of scope

- Batching several units into one request. The endpoint offers no marker tag, so unit
  boundaries would have to be inferred from word-boundary letter matching, and a failed
  reconciliation would cost highlighting across minutes of content instead of one sentence.
  Revisit only if per-unit request volume proves to be a problem.
- Returning to edge after a downgrade.
- Rate limiting, jitter, or connection pooling. The evidence shows our request rate is not
  the driver.
