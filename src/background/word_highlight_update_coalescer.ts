type Schedule = (operation: () => Promise<void>) => void;
type CoalescedWordUpdate = { sessionId: string; wordIndex: number };

export function createWordHighlightUpdateCoalescer<T extends CoalescedWordUpdate>(
	schedule: Schedule,
	relay: (message: T) => Promise<void>,
) {
	let latest: T | null = null;
	let scheduled = false;

	function scheduleLatest(): void {
		scheduled = true;
		schedule(async () => {
			try {
				const message = latest;
				latest = null;
				if (message) {
					await relay(message);
				}
			} finally {
				scheduled = false;
				if (latest) {
					scheduleLatest();
				}
			}
		});
	}

	return {
		submit(message: T): void {
			latest = message;
			if (!scheduled) {
				scheduleLatest();
			}
		},
		discard(sessionId: string): void {
			if (latest?.sessionId === sessionId) {
				latest = null;
			}
		},
	};
}
