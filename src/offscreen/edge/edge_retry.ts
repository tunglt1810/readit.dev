/**
 * How many times one unit is offered to edge-tts before the session gives up on it.
 *
 * The endpoint drops the occasional request — a closed idle connection, a lost frame — and each
 * retry opens a fresh connection, so a single blip is cheap to absorb. One attempt was not enough:
 * it downgraded the whole article to on-device synthesis, which then read noticeably slower and
 * with audible gaps.
 */
export const EDGE_SYNTHESIS_ATTEMPTS = 3;

/** Short enough that the prefetch window absorbs it, long enough to outlast a momentary blip. */
export function edgeRetryDelayMs(attempt: number): number {
	return attempt === 1 ? 250 : 750;
}

export interface EdgeRetryOptions {
	attempts: number;
	isRetryable(error: unknown): boolean;
	/** Runs between attempts: close the spent connection, wait out the backoff, record the failure. */
	onRetry(error: unknown, attempt: number): Promise<void>;
}

/** Run `attempt` until it succeeds, the error is not retryable, or the attempts run out. */
export async function retryEdgeSynthesis<T>(attempt: () => Promise<T>, options: EdgeRetryOptions): Promise<T> {
	let lastError: unknown;
	for (let attemptNumber = 1; attemptNumber <= options.attempts; attemptNumber += 1) {
		try {
			return await attempt();
		} catch (error) {
			if (!options.isRetryable(error)) {
				throw error;
			}
			lastError = error;
			if (attemptNumber < options.attempts) {
				await options.onRetry(error, attemptNumber);
			}
		}
	}
	throw lastError;
}
