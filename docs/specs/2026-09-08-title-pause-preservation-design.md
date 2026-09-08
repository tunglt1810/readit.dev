# Title Pause Preservation

## Problem

VnExpress articles run the headline straight into the body. The reader speaks
`Mua giày ở Nha Trang gửi sang Nga mới phát hiện hàng giả Khánh Hòa Một phụ nữ mua hai đôi giày…`
as one breath, with no pause where the title ends.

Extraction and planning are both correct. The pause is destroyed by consolidation.

Reproduced with the article's real text:

```
#0 pause=260 | text  ="…mới phát hiện hàng giả Khánh Hòa Một phụ nữ mua hai đôi giày…"
              synth ="…mới phát hiện hàng giả. Khánh Hòa Một phụ nữ mua hai đôi giày…"
```

The causal chain:

1. `articleFromRoot` joins `[title, ...contentBlocks]` with `\n\n`, so the title is its own
   paragraph.
2. `planLatinSpeechUnits` gives that paragraph `pauseAfterMs = LATIN_PAUSE_MS.paragraphEnd`
   (260 ms).
3. `consolidateShortSpeechUnits` counts the title as short — `Mua giày ở Nha Trang gửi sang Nga
   mới phát hiện hàng giả` is 43 non-whitespace code points, under
   `MIN_RELIABLE_SYNTHESIS_CHARACTERS = 50` — and the R9 objective merges it into the body to
   reduce the number of short output units.
4. `mergeSpeechUnits` keeps `pauseAfterMs: right.pauseAfterMs`. The title's 260 ms is gone. The
   only compensation is the `.` that `renderingTextForMerge` writes into `synthesisText`, which
   delegates cadence to model prosody instead of real silence.

Vietnamese headlines are almost never 50 non-whitespace characters long, so VnExpress hits this
on essentially every article. It is not site-specific: any leading headline under the threshold
loses its pause.

## Approved Design

### The Rule

The leading speech unit is pinned — it may never be merged rightward — when both hold:

- it ends a hard paragraph (`pauseAfterMs >= LATIN_PAUSE_MS.paragraphEnd`), and
- it does not end in sentence punctuation (`[.!?…]`).

That pair is exactly "the first paragraph of the document is a headline". A pinned unit keeps
its own 260 ms of real silence, and the body starts as a separate unit.

### Why The Rule Is Narrow

A broader rule — pin *every* paragraph-final unit without terminal punctuation — was measured and
rejected. On a six-item bullet list where no item ends in punctuation, consolidation currently
produces three units; the broad rule produces six short ones, reintroducing the unreliable-short-
unit regression that consolidation exists to prevent (`docs/specs/2026-08-03-vnexpress-vietnamese-
tts-regressions.md`).

The narrow rule leaves that list untouched: its leading unit is 82 characters and already stands
alone.

Mid-article headings keep their current behaviour. They are not in scope.

### The Invariant This Relaxes

`tests/unit/short_segment_consolidation.test.ts` asserts that no short unit may survive
consolidation while a neighbour could still absorb it, and models Supertonic by returning a silent
waveform for every unit under the threshold. That invariant exists because the ONNX vocoder renders
short spans unreliably (`docs/specs/2026-08-04-language-speed-defaults-and-consolidation.md`).

The pinned headline is now an explicit exception to it, on every engine rather than only on edge.
Consolidation runs before synthesis and has no engine parameter, so the swallowed pause is audible
on edge-tts too — making this a defect of the planning stage, not of one provider.

The residual risk is on Supertonic: a pinned headline is by construction a short unit, and if the
vocoder still renders those poorly the title could come out weak. `docs/specs/2026-08-03` reports
that the short unit `Vũ Tuân` produced voiced signal in five of five renders once the hidden speed
scale was removed, so the original cause of that failure is gone; this has not been re-measured
against Supertonic directly.

### What Does Not Change

- `renderingTextForMerge` keeps writing the compensating `.`; it still applies to merges that are
  not the leading title.
- `synthesisText` stays on `SpeechUnit`. The pronunciation dictionary also produces it.
- Compatibility-path units (`pauseAfterMs === null`, e.g. Chinese) never satisfy the paragraph-end
  condition, so that path is unaffected.
- The author line at the end of an article carries `sentenceEnd` (165 ms), not `paragraphEnd`, and
  is not the leading unit. It keeps merging, per the 2026-08-03 decision not to special-case
  author names.
- Article extraction, scheduling, storage keys, and the R9 optimisation objective itself are
  untouched. Pinning is expressed as a feasibility constraint on the leading row of the range
  table, so the dynamic program still optimises the same lexicographic objective over the
  remaining partition.

## Data Flow

1. `articleFromRoot` emits `title\n\nbody…`.
2. `normalizeSourceText` turns that into hard paragraph membership.
3. `planLatinSpeechUnits` assigns the title `paragraphEnd` (260 ms).
4. `buildFeasibleRanges` sees the leading unit is a pinned title and emits only the singleton range
   for row 0, so no feasible partition can absorb it.
5. Playback appends 260 ms of real silence after the title (`createSpeechAudioBuffer`), and the
   edge path renders it as a trailing `<break>`.

## Success Criteria

- For the VnExpress article, `preparePlaybackUnits` returns the title as unit 0 with
  `pauseAfterMs === 260`, and the sapo as unit 1.
- The six-item bullet-list fixture still consolidates to at most three units.
- A leading paragraph that *does* end in a full stop keeps its current merging behaviour.
- Compatibility-path (`zh`) output is byte-identical to before.
- `bun test tests/unit` passes, including `short_segment_consolidation.property.test.ts` and
  `short_segment_preservation.test.ts`.

## Known Gap (Out Of Scope)

`createEdgeProvider` synthesises `unit.text`, never `unit.synthesisText`, by design — Microsoft's
frontend already expands numbers, so running the normalizer's output through it would expand twice.
A side effect is that the compensating `.` in `synthesisText` reaches Supertonic but never
edge-tts. On the default provider, every non-leading merged boundary is therefore spoken with no
cadence marker at all.

This change removes the leading title from that set, which is the reported symptom. The remaining
cases — mid-article headings and bullet items merged into a neighbour — still lose their cadence
marker on the edge path. Fixing that means deciding how cadence punctuation reaches an engine that
must not see `synthesisText`, which is a separate design question.
