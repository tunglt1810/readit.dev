import type { EdgeFailureKind } from './edge_failure.ts';

/** Where the exponential ladder starts, doubling on every further attempt. */
const BASE_DELAY_MS = 1_000;
/** A unit the playhead is starving for retries almost immediately. */
const FLOOR_DELAY_MS = 250;
/** No single sleep may outlast a bad window's useful retry budget. */
const CEILING_DELAY_MS = 45_000;

/**
 * How long to wait before offering a unit to edge-tts again.
 *
 * Microsoft's drops come in windows lasting around two minutes, so a patient ladder recovers
 * where three fast attempts could not. Patience is only affordable while audio is still buffered
 * ahead of the playhead, so the delay is capped at half that headroom: with a full buffer the
 * ladder runs its course, and as the playhead starves the delays collapse to the floor on their
 * own without a second policy.
 */
export function edgeRetryDelayMs(attempt: number, headroomMs: number): number {
	const exponential = BASE_DELAY_MS * 2 ** (attempt - 1);
	const patience = Math.min(exponential, headroomMs / 2);
	return Math.min(Math.max(patience, FLOOR_DELAY_MS), CEILING_DELAY_MS);
}

/**
 * How long the player may sit on a dry buffer before the session moves on-device.
 *
 * Added to the 180 seconds the prefetch window holds, this outlasts the roughly two-minute bad
 * windows measured against the endpoint, while still bounding how long a reader stares at a
 * loading state when the endpoint is genuinely gone.
 */
export const EDGE_STARVATION_GRACE_MS = 30_000;

export interface EdgeRetryOptions<T> {
	classify(error: unknown): EdgeFailureKind;
	/** Audio still buffered ahead of the playhead. Zero means the reader is waiting. */
	headroomMs(): number;
	/** Moves the session on-device; its result is returned to the caller. */
	fallback(error: unknown): Promise<T>;
	onAttemptFailed(error: unknown, attempt: number): void;
	sleep(ms: number): Promise<void>;
	now(): number;
	graceMs: number;
}

/**
 * Offer a unit to edge-tts until it succeeds, until the error proves deterministic, or until the
 * reader has been waiting on an empty buffer for longer than the grace window.
 *
 * There is deliberately no attempt cap. Retrying costs the reader nothing while audio is still
 * buffered, so the stop condition is starvation rather than a counter — a counter is what let a
 * one-second retry budget lose a whole article to a two-minute outage.
 *
 * The caller must not hold a synthesis arbiter slot across this call: the sleeps below have to
 * leave the queue free, or a single retrying unit blocks the very buffer refill that makes
 * waiting safe.
 */
export async function retryEdgeSynthesis<T>(attempt: () => Promise<T>, options: EdgeRetryOptions<T>): Promise<T> {
	let dryAt: number | null = null;
	for (let attemptNumber = 1; ; attemptNumber += 1) {
		try {
			return await attempt();
		} catch (error) {
			const kind = options.classify(error);
			if (kind === 'foreign') {
				throw error;
			}
			if (kind === 'deterministic') {
				return await options.fallback(error);
			}
			options.onAttemptFailed(error, attemptNumber);
			const headroomMs = options.headroomMs();
			if (headroomMs > 0) {
				dryAt = null;
			} else {
				dryAt ??= options.now();
				if (options.now() - dryAt > options.graceMs) {
					return await options.fallback(error);
				}
			}
			await options.sleep(edgeRetryDelayMs(attemptNumber, headroomMs));
		}
	}
}
