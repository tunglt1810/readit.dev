// Phase 0 instrumentation for docs/plans/2026-07-23-pre-build-audio-buffer.md.
//
// Collection is unconditional because it is a handful of number pushes — gating it
// behind a flag would mean the measured configuration is not the shipped one.

export const HIGHLIGHT_INTERVAL_MS = 50;
export const GAP_THRESHOLD_MS = 50;
export const METRICS_STORAGE_KEY = 'readit_playback_metrics';

export interface GapSample {
	unitIndex: number;
	gapMs: number;
}

/** A unit whose playback was refused by a guard in `playAudioBuffer`, which is otherwise silent. */
export interface DroppedStart {
	unitIndex: number;
	reason: string;
}

/**
 * Units the article contained but that never reached `source.start()` — heard as skipped text —
 * and units that started more than once — heard as repeated text.
 */
export function analyzeUnitSequence(
	unitSequence: readonly number[],
	totalUnits: number | null,
): { skippedUnits: number[]; repeatedUnits: number[] } {
	const counts = new Map<number, number>();
	for (const unitIndex of unitSequence) {
		counts.set(unitIndex, (counts.get(unitIndex) ?? 0) + 1);
	}
	const repeatedUnits = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([unitIndex]) => unitIndex)
		.sort((a, b) => a - b);

	const skippedUnits: number[] = [];
	if (totalUnits !== null) {
		// Only count units before the furthest one reached; the rest simply have not played yet.
		const furthestReached = unitSequence.length === 0 ? -1 : Math.max(...unitSequence);
		for (let unitIndex = 0; unitIndex < Math.min(totalUnits, furthestReached); unitIndex++) {
			if (!counts.has(unitIndex)) {
				skippedUnits.push(unitIndex);
			}
		}
	}
	return { skippedUnits, repeatedUnits };
}

export interface PlaybackMetricsSnapshot {
	executionProvider: string | null;
	timeToFirstAudioMs: number | null;
	totalUnits: number | null;
	unitSequence: readonly number[];
	droppedStarts: readonly DroppedStart[];
	synthErrors: readonly DroppedStart[];
	gaps: readonly GapSample[];
	callbackLatenessMs: readonly number[];
	synthDurationsMs: readonly number[];
	inferDurationsMs: readonly number[];
	audioDurationsSec: readonly number[];
	highlightDriftsMs: readonly number[];
}

export interface PlaybackMetricsSummary {
	executionProvider: string | null;
	timeToFirstAudioMs: number | null;
	totalUnits: number | null;
	unitsStarted: number;
	/** Units that never played — heard as missing text. */
	skippedUnits: number[];
	/** Units that played more than once — heard as repeated text. */
	repeatedUnits: number[];
	droppedStarts: readonly DroppedStart[];
	synthErrors: readonly DroppedStart[];
	unitSequence: readonly number[];
	transitions: number;
	gapsOverThreshold: number;
	gapMedianMs: number | null;
	gapMaxMs: number | null;
	callbackLatenessMedianMs: number | null;
	callbackLatenessMaxMs: number | null;
	synthCount: number;
	synthMedianMs: number | null;
	synthMaxMs: number | null;
	inferMedianMs: number | null;
	inferMaxMs: number | null;
	audioMedianSec: number | null;
	/** Median synthesis time over median audio length. Above 1.0 means synthesis cannot keep up. */
	synthToAudioRatio: number | null;
	highlightDriftMaxMs: number | null;
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function max(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((highest, value) => (value > highest ? value : highest), values[0]);
}

export function summarizePlaybackMetrics(snapshot: PlaybackMetricsSnapshot): PlaybackMetricsSummary {
	const gapMs = snapshot.gaps.map((gap) => gap.gapMs);
	const synthMedianMs = median(snapshot.synthDurationsMs);
	const audioMedianSec = median(snapshot.audioDurationsSec);
	const { skippedUnits, repeatedUnits } = analyzeUnitSequence(snapshot.unitSequence, snapshot.totalUnits);
	return {
		executionProvider: snapshot.executionProvider,
		timeToFirstAudioMs: snapshot.timeToFirstAudioMs,
		totalUnits: snapshot.totalUnits,
		unitsStarted: snapshot.unitSequence.length,
		skippedUnits,
		repeatedUnits,
		droppedStarts: snapshot.droppedStarts,
		synthErrors: snapshot.synthErrors,
		unitSequence: snapshot.unitSequence,
		transitions: snapshot.gaps.length,
		gapsOverThreshold: gapMs.filter((value) => value > GAP_THRESHOLD_MS).length,
		gapMedianMs: median(gapMs),
		gapMaxMs: max(gapMs),
		callbackLatenessMedianMs: median(snapshot.callbackLatenessMs),
		callbackLatenessMaxMs: max(snapshot.callbackLatenessMs),
		synthCount: snapshot.synthDurationsMs.length,
		synthMedianMs,
		synthMaxMs: max(snapshot.synthDurationsMs),
		inferMedianMs: median(snapshot.inferDurationsMs),
		inferMaxMs: max(snapshot.inferDurationsMs),
		audioMedianSec,
		synthToAudioRatio:
			synthMedianMs !== null && audioMedianSec !== null && audioMedianSec > 0 ? synthMedianMs / (audioMedianSec * 1_000) : null,
		highlightDriftMaxMs: max(snapshot.highlightDriftsMs),
	};
}

export class PlaybackMetricsRecorder {
	private executionProvider: string | null = null;
	private playRequestedAtMs: number | null = null;
	private timeToFirstAudioMs: number | null = null;
	private totalUnits: number | null = null;
	private unitSequence: number[] = [];
	private droppedStarts: DroppedStart[] = [];
	private synthErrors: DroppedStart[] = [];
	private gaps: GapSample[] = [];
	private callbackLatenessMs: number[] = [];
	private synthDurationsMs: number[] = [];
	private inferDurationsMs: number[] = [];
	private audioDurationsSec: number[] = [];
	private highlightDriftsMs: number[] = [];
	/**
	 * When the currently-playing unit's audio is due to run out, on the `audioCtx` clock.
	 *
	 * Computed at `start()` rather than read at `onended`: `audioCtx.currentTime` does not
	 * advance within one JS task, so reading it inside a late `onended` and again at the next
	 * `start()` yields a difference of exactly zero no matter how long the silence really was.
	 */
	private expectedEndSec: number | null = null;
	private lastHighlightTickMs: number | null = null;

	recordExecutionProvider(provider: string): void {
		this.executionProvider = provider;
	}

	/** Starts a fresh run: every later flush accumulates until the next play request. */
	markPlayRequested(nowMs: number): void {
		this.resetRun();
		this.playRequestedAtMs = nowMs;
	}

	recordTotalUnits(totalUnits: number): void {
		this.totalUnits = totalUnits;
	}

	/** A guard in `playAudioBuffer` refused to play this unit. Otherwise invisible. */
	recordDroppedStart(unitIndex: number, reason: string): void {
		this.droppedStarts.push({ unitIndex, reason });
	}

	recordSynthError(unitIndex: number, reason: string): void {
		this.synthErrors.push({ unitIndex, reason });
	}

	/** Called immediately after `source.start()`. `startAtSec` is `audioCtx.currentTime`. */
	recordUnitStart(unitIndex: number, startAtSec: number, nowMs: number, bufferDurationSec: number, offsetSec = 0): void {
		this.unitSequence.push(unitIndex);
		if (this.expectedEndSec !== null) {
			this.gaps.push({ unitIndex, gapMs: (startAtSec - this.expectedEndSec) * 1_000 });
		}
		this.expectedEndSec = startAtSec + Math.max(bufferDurationSec - offsetSec, 0);
		this.audioDurationsSec.push(bufferDurationSec);
		if (this.timeToFirstAudioMs === null && this.playRequestedAtMs !== null) {
			this.timeToFirstAudioMs = nowMs - this.playRequestedAtMs;
		}
	}

	/** How late the `onended` callback ran relative to when the audio actually ran out. */
	recordUnitEnded(audioTimeSec: number): void {
		if (this.expectedEndSec !== null) {
			this.callbackLatenessMs.push((audioTimeSec - this.expectedEndSec) * 1_000);
		}
	}

	recordSynthDuration(durationMs: number): void {
		this.synthDurationsMs.push(durationMs);
	}

	/** The diffusion + vocoder pass that actually produces audio. */
	recordInferDuration(durationMs: number): void {
		this.inferDurationsMs.push(durationMs);
	}

	beginHighlightTracking(): void {
		this.lastHighlightTickMs = null;
	}

	recordHighlightTick(nowMs: number): void {
		if (this.lastHighlightTickMs !== null) {
			this.highlightDriftsMs.push(nowMs - this.lastHighlightTickMs - HIGHLIGHT_INTERVAL_MS);
		}
		this.lastHighlightTickMs = nowMs;
	}

	/** Drops the pending end timestamp so a stop or pause is never counted as a gap. */
	discardPendingTransition(): void {
		this.expectedEndSec = null;
		this.lastHighlightTickMs = null;
	}

	snapshot(): PlaybackMetricsSnapshot {
		return {
			executionProvider: this.executionProvider,
			timeToFirstAudioMs: this.timeToFirstAudioMs,
			totalUnits: this.totalUnits,
			unitSequence: [...this.unitSequence],
			droppedStarts: [...this.droppedStarts],
			synthErrors: [...this.synthErrors],
			gaps: [...this.gaps],
			callbackLatenessMs: [...this.callbackLatenessMs],
			synthDurationsMs: [...this.synthDurationsMs],
			inferDurationsMs: [...this.inferDurationsMs],
			audioDurationsSec: [...this.audioDurationsSec],
			highlightDriftsMs: [...this.highlightDriftsMs],
		};
	}

	hasSamples(): boolean {
		return (
			this.audioDurationsSec.length > 0 ||
			this.synthDurationsMs.length > 0 ||
			this.droppedStarts.length > 0 ||
			this.synthErrors.length > 0 ||
			this.timeToFirstAudioMs !== null
		);
	}

	/**
	 * Keeps `executionProvider`, which is a property of the loaded engine rather than of one
	 * playback run. Called from `markPlayRequested`, so a flush never has to reset.
	 */
	resetRun(): void {
		this.playRequestedAtMs = null;
		this.timeToFirstAudioMs = null;
		this.totalUnits = null;
		this.unitSequence = [];
		this.droppedStarts = [];
		this.synthErrors = [];
		this.gaps = [];
		this.callbackLatenessMs = [];
		this.synthDurationsMs = [];
		this.inferDurationsMs = [];
		this.audioDurationsSec = [];
		this.highlightDriftsMs = [];
		this.expectedEndSec = null;
		this.lastHighlightTickMs = null;
	}
}
