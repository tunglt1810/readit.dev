import assert from 'node:assert/strict';
import test from 'node:test';
import { createWordHighlightUpdateCoalescer } from '../../src/background/word_highlight_update_coalescer.ts';

type ScheduledOperation = () => Promise<void>;

function createScheduler() {
	const operations: ScheduledOperation[] = [];
	return {
		schedule(operation: ScheduledOperation): void {
			operations.push(operation);
		},
		async runNext(): Promise<void> {
			const operation = operations.shift();
			if (!operation) {
				throw new Error('Expected a scheduled operation.');
			}
			await operation();
		},
		get count(): number {
			return operations.length;
		},
	};
}

test('relays only the newest update that arrives while an earlier relay is pending', async () => {
	const scheduler = createScheduler();
	const relayedIndexes: number[] = [];
	let notifyFirstRelayStarted: () => void = () => {};
	let releaseFirstRelay: () => void = () => {};
	const firstRelayStarted = new Promise<void>((resolve) => {
		notifyFirstRelayStarted = resolve;
	});
	const firstRelayReleased = new Promise<void>((resolve) => {
		releaseFirstRelay = resolve;
	});
	const coalescer = createWordHighlightUpdateCoalescer(scheduler.schedule, async (message) => {
		relayedIndexes.push(message.wordIndex);
		if (message.wordIndex === 0) {
			notifyFirstRelayStarted();
			await firstRelayReleased;
		}
	});

	coalescer.submit({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'session-1', wordIndex: 0 });
	const firstRelay = scheduler.runNext();
	await firstRelayStarted;

	coalescer.submit({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'session-1', wordIndex: 1 });
	coalescer.submit({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'session-1', wordIndex: 2 });
	coalescer.submit({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'session-1', wordIndex: 3 });

	assert.equal(scheduler.count, 0);
	releaseFirstRelay();
	await firstRelay;
	assert.equal(scheduler.count, 1);
	await scheduler.runNext();
	assert.deepEqual(relayedIndexes, [0, 3]);
});

test('drops a pending update only when its own session is cleared', async () => {
	const scheduler = createScheduler();
	const relayedIndexes: number[] = [];
	const coalescer = createWordHighlightUpdateCoalescer(scheduler.schedule, async (message) => {
		relayedIndexes.push(message.wordIndex);
	});

	coalescer.submit({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'old-session', wordIndex: 1 });
	coalescer.submit({ action: 'WORD_HIGHLIGHT_UPDATE', sessionId: 'new-session', wordIndex: 2 });
	coalescer.discard('old-session');

	await scheduler.runNext();
	assert.deepEqual(relayedIndexes, [2]);
});
