import { EdgeUnsupportedLanguageError } from './edge_provider.ts';
import { EdgeSocketError } from './edge_socket.ts';

/**
 * How a failed edge request should be answered.
 *
 * `deterministic` errors repeat no matter how long the caller waits, so retrying them spends the
 * starvation budget for nothing. `transient` errors are the drops Microsoft's endpoint produces
 * under load — silent for two seconds, then an abnormal close — which a later attempt recovers
 * from. `foreign` errors did not come from the cloud path at all and belong to the caller.
 */
export type EdgeFailureKind = 'deterministic' | 'transient' | 'foreign';

/** The close code for a payload the endpoint refuses; every structural SSML tag produces it. */
const INVALID_PAYLOAD = 1007;

export function classifyEdgeFailure(error: unknown): EdgeFailureKind {
	if (error instanceof EdgeUnsupportedLanguageError) {
		return 'deterministic';
	}
	if (error instanceof EdgeSocketError) {
		return error.closeCode === INVALID_PAYLOAD ? 'deterministic' : 'transient';
	}
	return 'foreign';
}
