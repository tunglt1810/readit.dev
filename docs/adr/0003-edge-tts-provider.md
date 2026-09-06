# Edge TTS as the Default Speech Provider

> **Status:** Implemented on 2026-09-06. Supersedes nothing; Supertonic 3 remains
> the fallback engine and the only engine on Firefox.

## 1. The WebSocket must be opened from the offscreen document

Microsoft's Edge read-aloud endpoint rejects the handshake with 403 unless the
`User-Agent` header contains an `Edg/` token, and a browser gives extensions no
way to set that header on a WebSocket. A `declarativeNetRequest` `modifyHeaders`
rule can, but **only for a handshake initiated from a document**. Opened from
the service worker, Chrome silently skips the rule — [crbug 1285664][crbug].

This is the single most expensive fact to rediscover, because
`declarativeNetRequest.testMatchOutcome` reports a match either way. Measured
against a local server: the same rule rewrote `user-agent` and an arbitrary
header on a document-initiated upgrade and changed nothing on a worker-initiated
one.

The audio pipeline already lives in the offscreen document, which is a document,
so this cost nothing architecturally. It does mean `EdgeSocket` must never be
constructed from `background.ts`.

[crbug]: https://bugs.chromium.org/p/chromium/issues/detail?id=1285664

## 2. The User-Agent is forged, deliberately

`public/rules.json` rewrites `user-agent` for WebSocket requests to
`speech.platform.bing.com`. Chrome's own User-Agent returns 403; only a string
carrying `Edg/` is accepted. `Origin` is not checked, so nothing else is
disguised.

This is legible to store reviewers and is the honest cost of using an endpoint
Microsoft publishes for its own browser rather than for third parties. The
alternatives were a Cloudflare Worker relay — which would route article text
through our own infrastructure, a worse privacy position than sending it
straight to Microsoft — or dropping the feature.

## 3. `Sec-MS-GEC-Version` has a moving floor

The handshake token is `SHA-256(windowsFileTimeFlooredTo5Minutes ‖
TrustedClientToken)` as uppercase hex, and it must be accompanied by a version
string. **Versions below `1-133` now return 403**; `1-130.0.2849.68` worked
until recently and no longer does.

Microsoft raises this floor over time. When every handshake starts failing with
a socket that closes at 1006 without opening, bump `SEC_MS_GEC_VERSION` in
`src/offscreen/edge/gec_token.ts` to a current Edge version before looking
anywhere else. `tests/e2e/edge-tts-live.spec.ts` exists to confirm this quickly:

```
bunx playwright test --project chromium-live
```

A clock more than five minutes off also produces a 403, for the same reason the
flooring works at all.

## 4. Audio comes back encoded, not as PCM

`raw-24khz-16bit-mono-pcm` and `raw-16khz-16bit-mono-pcm` both close the socket
with 1007. Only mp3 and webm/opus are accepted, so each unit costs one
`decodeAudioData` call before it can reach `createSpeechAudioBuffer`. The
prefetch in `IndexedSynthesisCoordinator` absorbs that latency.

## 5. The normalizer is a step of the Supertonic flow

The Vietnamese normalizer exists so Supertonic pronounces numbers, dates and
abbreviations correctly. Microsoft's frontend does that itself, so the edge path
passes `normalizer: null` to `preparePlaybackUnits` and speaks `unit.text`.

The consequence is that the two engines produce **different unit sets** for
Vietnamese, not merely different text. When a session downgrades mid-article,
`replanRemainingUnits` re-plans the tail through the normalizer; without that,
the rest of the article would be read with its dates spoken as digits.

A second consequence: when Microsoft expands a token, its word boundaries no
longer share letters with the source text, so `alignWordBoundaries` returns
`null` and that unit falls back to estimated highlight timings.

## 6. The provider preference is read in the background, never in the offscreen document

`chrome.storage` is not reliably available inside the Chrome offscreen document.
`background/offscreen_transport.ts` already says so for `pronunciationRules`,
and the provider preference has exactly the same constraint: reading it from
`beginSessionProvider()` left every session stuck in `loading` with no error
anywhere — the offscreen document registered its message listener, then simply
never answered. Nothing was logged, no exception was raised, and the failure
looked like a broken message channel rather than a storage read.

So the background reads `readTtsProvider()` and `readEdgeVoice()` before
dispatch and puts `ttsProvider` and `edgeVoiceId` on the play payload, beside
`pronunciationRules`. Anything else the offscreen document needs from storage
belongs on that payload too.

## 7. The edge path must survive a dropped request, not downgrade on one

The endpoint drops the occasional request: a connection closed while idle, a
frame lost, a handshake that never completes. The first implementation had no
deadline on either the handshake or the synthesis request, so a silent drop left
the promise unsettled and playback stalled for good — worse than falling back.
It also retried once and then moved the whole session on-device.

That combination is what a reader experiences as "it keeps dropping and then
reads choppily": one blip early in an article costs every remaining unit, and
on-device synthesis is far slower. Measured on the same Vietnamese article,
`synthToAudioRatio` is about **0.05 on edge and 0.72 on Supertonic/WASM**, with
time-to-first-audio going from 2.4s to 24s.

So `EdgeSocket` now bounds both waits, tags each request with its `X-RequestId`
and ignores frames belonging to a request that already ended (a reconnect can
otherwise let a stale frame resolve the wrong one), and `retryEdgeSynthesis`
gives each unit three attempts on fresh connections before the session
downgrades. Every failure is recorded through `playbackMetrics.recordSynthError`,
including ones a retry rescues — a silent downgrade is indistinguishable from
the engine merely sounding different.

## 8. Firefox keeps Supertonic

Firefox support for rewriting a WebSocket handshake's headers is unverified —
its blocking `webRequest` plausibly can, but nobody has measured it. Until
somebody does, `rsbuild.config.ts` strips the permission, the hosts, the
`declarative_net_request` key and `rules.json` from the Firefox build, and that
build reads with Supertonic only.
