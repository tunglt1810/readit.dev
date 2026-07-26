import type { WordHighlightUpdateMessage } from '../shared/word_highlight';

type Schedule = (operation: () => Promise<void>) => void;
type Relay = (message: WordHighlightUpdateMessage) => Promise<void>;

export function createWordHighlightUpdateCoalescer(schedule: Schedule, relay: Relay) {
	let latest: WordHighlightUpdateMessage | null = null;
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
		submit(message: WordHighlightUpdateMessage): void {
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
