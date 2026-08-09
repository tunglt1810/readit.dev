export interface CommandLane {
	/** Runs `operation` after every earlier operation on this lane has settled. */
	enqueue<T>(operation: () => Promise<T>): Promise<T>;
	/**
	 * Queues an operation whose caller has no response channel (a context-menu click, a tab event, a
	 * progress message). Without this, a throwing operation becomes an unhandled service-worker
	 * rejection, because those call sites cannot attach a handler to the returned promise.
	 */
	runQueuedEvent(operation: () => Promise<unknown>): void;
}

/**
 * One FIFO lane. Operations on the same lane are mutually exclusive; operations on different lanes
 * are not. A rejected operation never stalls the lane: the tail is always rewritten to a fulfilled
 * promise, while the rejection still reaches whoever awaited `enqueue`.
 */
export function createCommandLane(): CommandLane {
	let tail = Promise.resolve();

	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = tail.then(operation);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	return {
		enqueue,
		runQueuedEvent(operation) {
			void enqueue(operation).catch(() => {
				// An event-driven operation reports failure through published session state, so there is
				// nothing to surface here — but the rejection must still be consumed.
			});
		},
	};
}
