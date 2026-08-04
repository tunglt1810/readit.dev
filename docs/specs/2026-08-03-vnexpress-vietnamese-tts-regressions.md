# VnExpress Vietnamese TTS Regressions

## Problem

Two VnExpress articles expose related Vietnamese playback regressions:

- `de-xuat-sua-quy-dinh-ve-oto-phuc-vu-lanh-dao-dang-nha-nuoc-5103660` contains duplicated month prefixes, weak semicolon cadence, swallowed words, and a final author name that can become inaudible.
- `tinh-the-danh-khong-duoc-dam-khong-xong-cua-ong-trump-voi-iran-5104447` sounds too fast and frequently drops words, especially around short standalone units such as section headings and the final author line.

The playback controller already loads `DEFAULT_SPEED = 1.05`, persists the selected speed, and sends that exact value to the offscreen runtime. The offscreen runtime then applies a second Vietnamese-only duration scale of `2`, so the duration predictor divides by `1.05 * 2` at the default setting. This hidden transform is why the synthesized waveform is not synchronized with the controller.

Exact real-model differential renders confirmed the effect:

- `Mỹ tiến lùi đều khó`: 2.27 seconds with controller-only scaling versus 1.15 seconds with the hidden scale.
- `Những lựa chọn khó khăn`: 3.11 seconds versus 1.57 seconds.
- `Vũ Hoàng (Theo Politico, AFP, Reuters)`: 4.00 seconds versus 2.06 seconds.
- `Vũ Tuân`: five of five renders contained voiced signal at scale `1`, while five of five renders were effectively silent at scale `2`.

Semicolons are currently boundary candidates but not interior split points. Most semicolon pauses therefore remain inside a model waveform and are compressed along with its duration instead of being appended as explicit silence.

## Approved Design

### Controller-Owned Speed

- The duration predictor must divide its raw prediction only by the speed supplied by the playback controller.
- Remove the Vietnamese-only duration scale from synthesis and duration estimation. There must be no hidden multiplier or language-specific speed transform.
- `DEFAULT_SPEED = 1.05` remains the default. If the user selects another value such as `1.2` or `1.3`, foreground playback and audio export must receive and use that exact value one-to-one.
- Do not compensate by changing `AudioBufferSourceNode.playbackRate`; that would alter pitch and cannot restore speech that the model failed to generate.

This deliberately reverses the earlier scale-`2` calibration. Controller truth and complete speech take priority. If duplicated spans recur with longer latent allocations, they must be diagnosed separately without introducing another hidden speed multiplier.

### Semicolon Cadence

- Promote semicolons to eligible interior speech-unit boundaries alongside sentence endings.
- Use a semicolon-specific minimum side length of 20 characters so meaningful list clauses can stand alone without producing tiny scraps. Sentence boundaries retain their existing 60-character minimum.
- Append 140 ms of explicit silence after a selected semicolon boundary. Colon timing remains unchanged at 90 ms.
- Preserve existing protected-token handling so punctuation inside URLs, email addresses, versions, dates, times, and numeric values is not split accidentally.

### Text Normalization and Authors

- Keep the approved contextual month normalization: an `NMON` span following a literal `tháng` removes only its generated `tháng ` prefix, while a standalone month/year keeps that prefix.
- Do not special-case, label, duplicate, or join author names. `Vũ Tuân`, `Vũ Hoàng`, and other short final paragraphs must remain ordinary speech units and become audible through controller-owned duration.
- Do not modify article extraction, playback scheduling, prefetch depth, checkpoint ownership, or storage keys.

## Data Flow

1. Popup, Side Panel, or Full Reader reads the stored speed, falling back to `DEFAULT_SPEED`.
2. The background coordinator snapshots that exact speed into the playback session and sends it to offscreen synthesis.
3. Offscreen foreground playback, prefetch, duration estimates, and MP3 export reuse the same snapshot.
4. `TextToSpeech` divides the raw duration prediction once by that controller speed.
5. The speech-unit planner creates explicit semicolon boundaries where both sides satisfy the semicolon-specific minimum; audio preparation appends the 140 ms pause after synthesis.

## Success Criteria

- At the default setting, `1.05` reaches duration prediction unchanged and is the only divisor applied to every language, including Vietnamese.
- Changing the controller to `1.3` causes duration prediction, foreground playback state, and audio-export estimation to use exactly `1.3`.
- Exact short units from the Iran article and the final `Vũ Tuân` unit produce voiced waveforms without scheduler skips or synthesis errors.
- Every eligible semicolon in the reported list paragraphs becomes a speech-unit boundary with `pauseAfterMs: 140`; clauses shorter than 20 characters remain attached to a neighbour.
- `tháng 9/2025` becomes `tháng chín năm hai nghìn không trăm hai mươi lăm`, while standalone `7/2026` becomes `tháng bảy năm hai nghìn không trăm hai mươi sáu`.
- Focused tests fail before implementation and pass afterward; the complete unit suite, Vietnamese normalizer evaluation, Chrome build, exact-article runtime probe, `git diff --check`, and Graphify update all pass.

## Out of Scope

- Adaptive or per-unit hidden duration scaling.
- Audio time stretching or pitch correction.
- Article extraction changes.
- Scheduler, prefetch, checkpoint, storage, API, or UI redesign.
- General pronunciation tuning unrelated to the two reported articles.
