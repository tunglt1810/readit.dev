# Edge TTS Provider Design

## Context

Playback today has exactly one engine: Supertonic 3, running on-device through
onnxruntime-web in the offscreen document. It speaks 31 languages, needs a ~100 MB model
download from HuggingFace before the first word, and spends real CPU on every sentence.

Microsoft's Edge read-aloud endpoint offers 322 neural voices across 74 language codes,
including `vi-VN-HoaiMyNeural` and `vi-VN-NamMinhNeural`, and returns per-word timing
metadata that this extension currently has to estimate. A spike on 2026-09-05 proved the
endpoint is reachable straight from the extension, with no backend proxy.

This document specifies adding it as a second speech provider and making it the default.

## Spike findings that constrain the design

Established by measurement, not assumption:

1. **The WebSocket must be opened from a document context.** Opened from the service
   worker, declarativeNetRequest silently skips the handshake — [crbug 1285664][crbug].
   `testMatchOutcome` still reports a match, so the rule looks fine while doing nothing.
   Verified against a local server: a `modifyHeaders` rule rewrote `user-agent` and an
   arbitrary header on a document-initiated upgrade and changed nothing on a
   worker-initiated one. The offscreen document is a document, so this is satisfied.
2. **Microsoft rejects the handshake with 403 unless `User-Agent` contains `Edg/`.**
   Chrome's own UA fails. A DNR rule with `resourceTypes: ["websocket"]` fixes it. `Origin`
   is not checked.
3. **`Sec-MS-GEC`** is the uppercase hex SHA-256 of (Windows filetime floored to 5 minutes ‖
   TrustedClientToken `6A5AA1D4EAFF4E9FB37E23D68491D6F4`). `Sec-MS-GEC-Version` must be
   **at least `1-133`**; `1-130.0.2849.68` now returns 403, so Microsoft raises this floor
   over time and it will need periodic bumping.
4. **Output must be mp3 or webm/opus.** Both `raw-24khz-16bit-mono-pcm` and
   `raw-16khz-16bit-mono-pcm` close the socket with 1007, so audio arrives encoded and needs
   `decodeAudioData` rather than being fed to `createSpeechAudioBuffer` as Float32Array.
5. Measured: handshake ~270-330 ms, first audio frame ~450 ms, complete WordBoundary
   metadata for both English and Vietnamese.

[crbug]: https://bugs.chromium.org/p/chromium/issues/detail?id=1285664

## Product decisions

| Decision | Choice |
| --- | --- |
| Default provider | edge-tts; Supertonic is the fallback |
| Supertonic model download | Keep warming the cache as today, so fallback is always ready |
| Voice picker | Filtered to the content language; each language remembers its own voice |
| Fallback trigger | Automatic and silent-but-announced, since the model is always present |
| Vietnamese normalizer | Not applied on the edge path; it is a step of the Supertonic flow |
| Vietnamese fallback mid-article | Re-plan the remaining text through the normalizer |

Making a cloud engine the default reverses the extension's current "everything stays on your
device" positioning. That is a deliberate product choice, and Section "Privacy and store
disclosure" lists everything it obliges us to change.

## Architecture

### The provider boundary

New file `src/offscreen/speech_provider.ts`:

```ts
export interface SynthesizedUnit {
  samples: Float32Array;
  sampleRate: number;
  /** null when the provider cannot report timings; the caller then estimates them. */
  wordTimings: WordTimingWindow[] | null;
}

export interface SpeechProvider {
  readonly id: 'supertonic' | 'edge';
  synthesize(input: {
    unit: SpeechUnit;
    lang: string;
    voiceId: string;
    speed: number;
  }): Promise<SynthesizedUnit>;
}
```

`SupertonicProvider` wraps today's `engine.call` plus `synthesizeSpeechUnitSamples` and
returns `wordTimings: null`. No existing synthesis logic is rewritten; it changes address.

`synthesizeUnit` in `offscreen.ts` loses its `style: Style` parameter — a Supertonic-only
concept — and takes `voiceId: string`, resolving it through the active provider. Everything
generic stays where it is: `createSpeechAudioBuffer`, `playbackMetrics`,
`engineBoundaryDiagnostics`, `VoicedAudioError` handling.

### Coordinator output type

`IndexedSynthesisCoordinator<SynthesisInput, AudioBuffer>` currently caches an `AudioBuffer`.
Word timings must travel with the buffer through that cache, otherwise a prefetched unit
loses its timings by the time it plays. The output type becomes:

```ts
{ buffer: AudioBuffer; wordTimings: WordTimingWindow[] | null }
```

This propagates to `SynthesisArbiter`, `playNextUnit`, and `audio_export_engine.ts`, which
reads `.buffer` and ignores the rest.

### Edge provider internals

Three files under `src/offscreen/edge/`:

- `gec_token.ts` — the `Sec-MS-GEC` hash. Pure, ~15 lines, unit-tested against a fixed clock.
- `edge_socket.ts` — connection lifecycle, SSML submission, frame assembly.
- `edge_voices.ts` — the voice catalogue and the `lang → locale → voice[]` mapping.

**The voice catalogue is generated at build time**, not fetched at runtime. A script writes
the `voices/list` response to `public/assets/edge_voices.json`. Fetching it at runtime would
add a network request and a failure state to every Settings render for a list that barely
changes.

**Connection lifecycle:** one socket per reading session, reopened when Microsoft closes it
for idleness. Each unit is a separate `X-RequestId` on that socket. Audio frames accumulate
until `turn.end`, then decode in one `decodeAudioData` call — mp3 cannot be decoded
piecemeal, but units are a few seconds long and `IndexedSynthesisCoordinator` already
prefetches two units ahead, so this latency sits off the critical path.

**Parameter translation:**

| Supertonic concept | SSML equivalent |
| --- | --- |
| `speed` (e.g. `1.5`) | `<prosody rate="+50%">` |
| `internalSilence` 0.3 s when `pauseAfterMs === null` | `<break time="300ms"/>` |
| `lang` (`vi`, `en`, `na`) | full locale (`vi-VN`, `en-US`) via `edge_voices.ts` |

`assertWithinSynthesisCapacity` and the whole segmentation path stay as they are, even
though edge-tts tolerates longer input. Splitting finer than necessary is harmless, and one
segmentation path is one path to test.

### Manifest and build

- `host_permissions` += `https://speech.platform.bing.com/*`, `wss://speech.platform.bing.com/*`
- `permissions` += `declarativeNetRequestWithHostAccess`
- `declarative_net_request.rule_resources` → `public/rules.json`, a single `modifyHeaders`
  rule setting `user-agent` to an `Edg/`-bearing string for `resourceTypes: ["websocket"]`
  on `speech.platform.bing.com`
- `scripts/validate-free-manifest.mjs` must accept the new permission and hosts, or the
  build fails its own validation

## Word timings

WordBoundary offsets cannot be used directly, because highlighting addresses words by
`wordIndex` into `unit.wordMap`, and the two tokenizations disagree — `wordMap` splits on
`/\S+/` while Microsoft splits its own way, so `20/05` is one entry on our side and several
boundaries on theirs.

New pure function in `src/offscreen/edge/word_boundary_alignment.ts`:

```ts
alignWordBoundaries(
  wordMap: readonly SpeechUnitWordMapEntry[],
  boundaries: readonly EdgeWordBoundary[],  // { offsetMs, durationMs, text }, from edge_socket.ts
): WordTimingWindow[] | null
```

It walks both sequences in order, accumulating consecutive boundaries until their
concatenated text — whitespace and punctuation removed — matches the next `wordMap` entry.
`startSec` comes from the group's first boundary, `endSec` from its last. If alignment
cannot be resolved, it returns `null` and that unit falls back to `computeWordTimings`.

`word_timing.ts` needs no changes. It remains the estimation path; `offscreen.ts` only gains
a branch preferring real timings when the provider supplies them.

## Text pipeline

The normalizer is a step of the Supertonic flow. On the edge path it is skipped entirely by
passing `normalizer: null` to `preparePlaybackUnits` — the branch at
`playback_preparation.ts:71` already plans from the original paragraphs, attaches
`attachPlainWordMap`, and still applies the pronunciation dictionary. No new code.

The consequence worth stating plainly: for Vietnamese the two providers produce **different
unit sets**, not merely different text. The normalized path plans from `result.text` and
attaches `attachNormalizedWordMap`; the plain path plans from the source paragraphs.

## Fallback

On an edge failure — abnormal socket close, timeout, or a 403 after Microsoft changes
something — the provider retries **once** on a fresh connection, since flaky networks are the
common case. If that fails, the session downgrades to Supertonic for the rest of the
article. It does not retry per unit; each retry is a silent gap mid-sentence. The next
reading session tries edge again from scratch.

Units already resolved in the coordinator stay usable — they are decoded `AudioBuffer`s and
carry no provider identity. New units synthesize through Supertonic, whose model is warm by
the earlier decision, so there is no download wait.

**Vietnamese re-planning.** Because the remaining units were planned without the normalizer,
handing them to Supertonic would mean reading numbers, dates, and abbreviations wrong. On
downgrade, the remaining text — the units after the one currently playing, joined as
paragraphs — is re-planned through `preparePlaybackUnits` with the normalizer, and replaces
the tail of `speechUnits`. The unit currently playing finishes from its existing buffer.
Because the unit count changes mid-session, `progressPercentage`, `totalParagraphs`, and the
highlight index must be recomputed from the new array. For non-Vietnamese content there is
no normalizer, so the tail is kept as-is.

The UI reports the downgrade in one line rather than silently changing voice.

## Settings and storage

Two new `STORAGE_KEYS`:

- `TTS_PROVIDER` — `'edge' | 'supertonic'`, defaults to `'edge'`
- `EDGE_VOICES` — `Record<lang, voiceId>`

`ACTIVE_VOICE` keeps its meaning as the Supertonic style. The two providers have disjoint
voice spaces and are not merged into one list.

`SettingsCard.tsx` gains a provider dropdown, and the existing voice dropdown switches its
contents by provider: the ten M1–M5/F1–F5 styles for Supertonic, or the voices of the
**current content language** for edge (`pageInfo.lang`, already available in the popup and
side panel; falling back to the UI language when unknown). A Vietnamese article therefore
offers exactly HoaiMy and NamMinh, and the choice is stored per language.

## Firefox

Unresolved. The spike covered Chrome only. Firefox supports blocking `webRequest`, which can
rewrite handshake headers, but its declarativeNetRequest behaviour for WebSocket upgrades is
unverified, and `rsbuild.config.ts` already filters `permissions` and `host_permissions`
per browser.

**The implementation plan must open with a Firefox probe.** Its result decides whether the
Firefox build shares the edge path or keeps Supertonic as its default. This spec does not
guess.

## Privacy and store disclosure

Making a cloud engine the default obliges changes beyond code:

- `docs/privacy-policy.md` — state that article text is sent to Microsoft on the edge path,
  and how to switch back to on-device synthesis
- Chrome Web Store data collection disclosure
- `browser_specific_settings.data_collection_permissions` in `rsbuild.config.ts`
- `description_vi.md`, `description_en.md`, and the `package.json` description, all of which
  currently advertise local Supertonic synthesis

A new ADR, `docs/adr/0003-edge-tts-provider.md`, records why the WebSocket must live in the
offscreen document, why the User-Agent is forged, and that `Sec-MS-GEC-Version` needs
periodic bumping — without it, whoever debugs this next re-derives a full day of findings.

## Testing

Unit tests cover the pure pieces: `gec_token` against a fixed clock, `alignWordBoundaries`
across matching, mismatching, and empty inputs, the SSML builder (speed → `rate`,
`internalSilence` → `break`), the `lang → locale → voice` mapping, and provider selection
plus downgrade against a fake provider with no network.

End-to-end coverage that touches the live endpoint depends on Microsoft and would flake in
CI. It goes in a spec excluded from the default run by `grepInvert`, the way
`playwright.config.ts` already treats `AUDIO_LIFECYCLE_TEST`, and is run by hand to confirm
the endpoint still answers. The main suite continues to exercise the Supertonic path.

## Risks

- **Unofficial endpoint.** Microsoft can change or block it. The version floor has already
  moved once. Fallback to Supertonic is the mitigation, and it is always warm.
- **Store review.** Forging a User-Agent through declarativeNetRequest is legible to
  reviewers. There is no way to avoid it and still reach the endpoint directly.
- **Positioning.** The extension has sold itself on on-device synthesis. Default-cloud is a
  real change in what the product is, not just how it synthesizes.
