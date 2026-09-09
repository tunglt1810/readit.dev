import type { TtsProviderId } from '../shared/edge_voice_preferences.ts';
import { estimateSpeechUnitDurations } from './audio_export_estimate.ts';
import type { SpeechUnit } from './speech_unit.ts';

/**
 * How much audio to keep synthesized ahead of the playhead on the cloud path.
 *
 * Microsoft's endpoint drops requests in windows lasting around two minutes; three minutes of
 * buffer rides one out without the reader hearing a gap. Filling it costs about ten seconds,
 * since the arbiter runs requests one at a time and a unit-sized request returns in well under a
 * second, and about 33MB of decoded audio in the offscreen document.
 */
export const PREFETCH_TARGET_SECONDS = 180;

/**
 * The on-device target: about a second of cover, which for any ordinary unit is the one unit ahead
 * this path buffered before the window existed.
 */
const ON_DEVICE_PREFETCH_TARGET_SECONDS = 1;

/**
 * How deep a buffer this engine has a reason to build.
 *
 * Only the cloud path does. Its requests are socket waits, so filling three minutes costs three
 * minutes of nothing much. On the on-device path a request is seconds of synchronous WASM
 * inference on the offscreen document's main thread, and everything that thread owns waits behind
 * it: the `onended` that starts the next unit, and the `playing` report the background and every
 * surface read their state from. Measured on a five-unit article, audio started at 9.5s while the
 * report did not arrive until 36.6s, stuck behind four speculative units — far enough back that a
 * slower machine crosses the background's startup deadline and fails a session already playing.
 *
 * Inference runs ahead of playback on this path, so one unit of cover is all it needs to stay
 * ahead; the successor priming in `shouldPrimeSuccessor` covers the one place it cannot.
 */
export function prefetchTargetSeconds(providerId: TtsProviderId): number {
	return providerId === 'edge' ? PREFETCH_TARGET_SECONDS : ON_DEVICE_PREFETCH_TARGET_SECONDS;
}

/**
 * The unit indices that must be synthesized, in order, to buffer `targetSeconds` past the unit
 * currently playing.
 *
 * Durations are estimated rather than measured because these units have not been synthesized
 * yet — that is the whole point. The estimate only has to be good enough to size a buffer.
 */
export function prefetchWindow(
	units: readonly SpeechUnit[],
	currentIndex: number,
	language: string,
	speed: number,
	targetSeconds: number = PREFETCH_TARGET_SECONDS,
): number[] {
	const durations = estimateSpeechUnitDurations(units, language, speed);
	const window: number[] = [];
	let buffered = 0;
	for (let index = currentIndex + 1; index < units.length && buffered < targetSeconds; index += 1) {
		window.push(index);
		buffered += durations[index];
	}
	return window;
}

/**
 * How many prefetch requests may sit queued at once.
 *
 * The bound costs nothing: the synthesis arbiter runs one request at a time, so queue depth
 * changes the order requests are served in, never the rate. What it buys is that a retry — which
 * re-enters the queue at the back — waits behind at most this many requests instead of behind the
 * entire window. Dumping thirty units in at once put the retry of the unit playback was waiting
 * on behind all of them, and pushed first audio past a minute.
 */
export const MAX_PREFETCH_IN_FLIGHT = 3;

/**
 * How many requests prefetch may queue right now.
 *
 * While the reader is waiting on silence, every queued speculative request is one more thing a
 * retry of the unit they are actually waiting for has to queue behind. So the capacity collapses
 * to a single request until audio is running, and opens back up once the buffer is covering them.
 */
export function prefetchCap(readerIsWaiting: boolean): number {
	return readerIsWaiting ? 1 : MAX_PREFETCH_IN_FLIGHT;
}

/**
 * The worst a successor costs on the cloud path: a dropped request goes silent for about 2.4
 * seconds before the endpoint closes it, then the floor backoff and a fresh request add roughly
 * 0.85 more.
 */
const SUCCESSOR_RECOVERY_SECONDS = 3.25;

/**
 * Whether the second unit must be synthesized before the first one starts playing.
 *
 * Supertonic runs WASM inference on this document's main thread, so a first source that is short
 * cannot cover its successor's inference: the `onended` callback arrives late and leaves audible
 * silence. That is why priming exists, and on the on-device path it always applies.
 *
 * The cloud path does no main-thread inference — it waits on a socket — so priming there only buys
 * insurance against the successor being slow, and charges an extra round trip before the reader
 * hears anything. It is worth paying only when the first unit is too short to absorb the worst
 * case on its own.
 */
export function shouldPrimeSuccessor(providerId: TtsProviderId, firstUnitSeconds: number): boolean {
	if (providerId !== 'edge') {
		return true;
	}
	return firstUnitSeconds < SUCCESSOR_RECOVERY_SECONDS;
}

/**
 * Audio the reader can still hear before they reach silence.
 *
 * Zero while they are waiting, however much sits buffered behind the gap: playback cannot skip the
 * unit it is stuck on, so audio queued after that unit buys the reader nothing. Counting it was
 * enough to keep the starvation deadline resetting forever — a unit that would never synthesize
 * retried indefinitely while the buffer behind it looked healthy and the reader heard nothing.
 */
export function bufferedHeadroomMs(readerIsWaiting: boolean, resolvedSecondsAhead: number): number {
	return readerIsWaiting ? 0 : resolvedSecondsAhead * 1_000;
}

export type PrefetchState = 'idle' | 'inFlight' | 'resolved';

/** Which of the window's units to start now, keeping the queue under the in-flight bound. */
export function prefetchStarts(
	window: readonly number[],
	stateOf: (unitIndex: number) => PrefetchState,
	maxInFlight: number = MAX_PREFETCH_IN_FLIGHT,
): number[] {
	let inFlight = window.filter((unitIndex) => stateOf(unitIndex) === 'inFlight').length;
	const starts: number[] = [];
	for (const unitIndex of window) {
		if (inFlight >= maxInFlight) {
			break;
		}
		if (stateOf(unitIndex) === 'idle') {
			starts.push(unitIndex);
			inFlight += 1;
		}
	}
	return starts;
}
